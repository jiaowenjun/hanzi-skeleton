#!/usr/bin/env python3
"""Export Python reference intermediates for the JavaScript port comparison.

For every sample and both processing variants, dumps the stage-by-stage
artifacts of rubbing_graph.analyze (grayscale bytes, smoothed image, Otsu
threshold, masks, distance transform, skeletons, graph JSON) into
work/port-ref/ so that scripts/compare_port.mjs can diff the browser port
against the pinned Python stack.

No behaviour of the reference pipeline is changed; stages are re-run here
one by one, mirroring analyze() exactly.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.filters import gaussian, threshold_otsu
from skimage.morphology import closing, disk, skeletonize

import rubbing_graph as rg

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'work' / 'port-ref'


def dump_f64(path: Path, arr: np.ndarray) -> None:
    path.write_bytes(np.ascontiguousarray(arr, dtype='<f8').tobytes())


def dump_u8(path: Path, arr: np.ndarray) -> None:
    path.write_bytes(np.ascontiguousarray(arr, dtype=np.uint8).tobytes())


def export_case(name: str, gray_u8: np.ndarray) -> dict:
    """Re-run analyze() stage by stage, dumping each intermediate."""
    out_dir = OUT / name
    out_dir.mkdir(parents=True, exist_ok=True)
    height, width = gray_u8.shape
    meta = dict(name=name, width=width, height=height, variants={})

    gray = gray_u8.astype(float) / 255
    for variant, clean in [('raw', False), ('clean', True)]:
        case = {}
        smooth = gaussian(gray, sigma=1.0, preserve_range=True)
        threshold = float(threshold_otsu(smooth))
        mask = smooth > threshold
        dump_u8(out_dir / f'{variant}_mask0.bin', mask.astype(np.uint8))
        if clean:
            mask = rg.remove_specks(mask, 80)
            mask = closing(mask, footprint=disk(1), mode='ignore')
            mask = rg.fill_small_holes(mask, 48)
        dump_u8(out_dir / f'{variant}_mask.bin', mask.astype(np.uint8))
        distance = ndi.distance_transform_edt(mask)
        dump_f64(out_dir / f'{variant}_distance.bin', distance)
        skeleton = skeletonize(mask, method='zhang')
        dump_u8(out_dir / f'{variant}_skeleton0.bin', skeleton.astype(np.uint8))
        if clean:
            skeleton = rg.prune_short_leaves(skeleton, distance, 12)
        dump_u8(out_dir / f'{variant}_skeleton.bin', skeleton.astype(np.uint8))
        graph = rg.build_graph(skeleton)
        # Reuse analyze()'s export logic by assembling the same result dict.
        result, _, _ = rg.analyze(
            Image.fromarray(np.stack([gray_u8] * 3, axis=-1), 'RGB'),
            clean=clean,
        )
        (out_dir / f'{variant}_graph.json').write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        case.update(threshold=threshold,
                    skeleton_path=f'{variant}_skeleton.bin',
                    nodes=result['statistics']['nodes'],
                    edges=result['statistics']['edges'])
        meta['variants'][variant] = case
        print(f'{name}/{variant}: threshold={threshold:.12f} '
              f'fg={int(mask.sum())} skel={int(skeleton.sum())} '
              f"stats={result['statistics']}")

    dump_u8(out_dir / 'gray.bin', gray_u8)
    dump_f64(out_dir / 'smooth.bin', smooth)
    (out_dir / 'threshold.txt').write_text(repr(threshold), encoding='utf-8')
    # Pruned skeleton for the clean variant is the analysis input.
    return meta


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'data/samples.json').read_text(encoding='utf-8'))
    metas = []
    for sample in manifest['samples']:
        source = ROOT / 'data' / sample['source']
        original = Image.open(source).convert('RGB').crop(sample['crop_box'])
        gray_u8 = np.asarray(original.convert('L'), dtype=np.uint8)
        metas.append(export_case(sample['id'], gray_u8))
    (OUT / 'meta.json').write_text(json.dumps(metas, indent=2), encoding='utf-8')
    print(f'reference artifacts -> {OUT}')


if __name__ == '__main__':
    main()
