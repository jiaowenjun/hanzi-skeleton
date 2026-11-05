#!/usr/bin/env python3
"""Reproduce all sample graphs and the standalone viewer from project data."""
from __future__ import annotations

import argparse
import base64
import hashlib
from importlib.metadata import version
import io
import json
from pathlib import Path
import platform
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rubbing_graph import analyze, render_overlay, save_results


def validate_graph(result):
    """Validate exported references and geometry without assuming stroke counts."""
    ids = {node['id'] for node in result['nodes']}
    assert len(ids) == len(result['nodes']), 'Duplicate graph node IDs'
    for edge in result['edges']:
        assert edge['source'] in ids and edge['target'] in ids
        points = np.asarray(edge['points_xy'])
        assert points.ndim == 2 and points.shape[1] == 2
        assert np.isfinite(points).all()
        assert (points[:, 0] >= 0).all() and (points[:, 0] < result['width']).all()
        assert (points[:, 1] >= 0).all() and (points[:, 1] < result['height']).all()
        assert len(edge['width_samples_px']) == len(points)
    assert sum(node['degree'] for node in result['nodes']) == 2 * len(result['edges'])


def image_uri(image, fmt, **kwargs):
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **kwargs)
    mime = 'jpeg' if fmt == 'JPEG' else 'png'
    return f'data:image/{mime};base64,' + base64.b64encode(buffer.getvalue()).decode()


def comparison_font():
    # Font choice changes the two captions only, never the image analysis.
    for name in ['/System/Library/Fonts/Supplemental/Arial.ttf', 'DejaVuSans.ttf', 'Arial.ttf']:
        try:
            return ImageFont.truetype(name, 22)
        except OSError:
            pass
    return ImageFont.load_default(size=22)


def write_comparison(tiles, output):
    canvas = Image.new('RGB', (512 * len(tiles), 1116), '#ffffff')
    draw = ImageDraw.Draw(canvas)
    font = comparison_font()
    draw.text((20, 16), 'Actual input crops', font=font, fill='#333333')
    draw.text((20, 568), 'Computed geometric skeletons (simple cleanup)', font=font, fill='#333333')
    for i, pair in enumerate(tiles):
        for j, image in enumerate(pair):
            picture = image.copy()
            picture.thumbnail((496, 496))
            canvas.paste(picture, (8 + i * 512 + (496 - picture.width)//2, 56 + j*552))
    canvas.save(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'results')
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'data/samples.json').read_text(encoding='utf-8'))
    payload, tiles, summaries = [], [], []
    for index, sample in enumerate(manifest['samples'], 1):
        source = ROOT / 'data' / sample['source']
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != sample['sha256']:
            raise ValueError(f'Source checksum mismatch: {source}')
        original = Image.open(source).convert('RGB').crop(sample['crop_box'])
        thumbnail = original.copy()
        thumbnail.thumbnail((512, 512))
        item = dict(id=index, image=image_uri(thumbnail, 'JPEG', quality=78),
                    width=original.width, height=original.height, variants={})
        summary = dict(id=sample['id'], source=sample['source'],
                       crop_box=sample['crop_box'], variants={})
        for clean in [False, True]:
            key = 'clean' if clean else 'raw'
            result, mask, skeleton = analyze(original, clean=clean)
            result['source_attachment'] = sample['original_attachment']
            result['crop_box_in_source'] = sample['crop_box']
            validate_graph(result)
            save_results(original, result, mask, skeleton, out / 'samples' / sample['id'] / key)
            graph_view = {k: result[k] for k in ['nodes', 'centroid_xy', 'statistics']}
            graph_view['edges'] = [dict(p=e['display_points_xy'], s=e['sample_points_xy']) for e in result['edges']]
            graph_view['mask'] = image_uri(Image.fromarray(mask.astype('uint8') * 255), 'PNG')
            item['variants'][key] = graph_view
            summary['variants'][key] = result['statistics']
            print(sample['id'], key, result['statistics'], flush=True)
            if clean:
                tiles.append((original, render_overlay(original, result)))
        payload.append(item)
        summaries.append(summary)

    data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    (out / 'visual-data.json').write_text(data + '\n', encoding='utf-8')
    fragment = (ROOT / 'web/graph.fragment.html').read_text(encoding='utf-8')
    fragment = fragment.replace('__GRAPH_DATA__', data)
    shell = (ROOT / 'web/viewer-shell.html').read_text(encoding='utf-8')
    assert shell.count('__VIEWER_FRAGMENT__') == 1
    page = shell.replace('__VIEWER_FRAGMENT__', fragment)
    (out / 'index.html').write_text(page, encoding='utf-8')
    write_comparison(tiles, out / 'comparison.png')
    summary = dict(
        python=platform.python_version(),
        packages={name: version(name) for name in ['numpy', 'Pillow', 'scipy', 'scikit-image', 'networkx', 'sknw', 'numba']},
        samples=summaries,
    )
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Viewer: {out / "index.html"}')


if __name__ == '__main__':
    main()

