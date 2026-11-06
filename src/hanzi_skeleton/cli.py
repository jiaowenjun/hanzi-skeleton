"""Command line entry: image -> skeleton graph files in one shot."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

from hanzi_skeleton.pipeline import analyze
from hanzi_skeleton.render import save_results


def main():
    ap = argparse.ArgumentParser(
        description='Rubbing bitmap -> geometric skeleton graph (not historical stroke order). '
                    'Example: uv run hanzi-skeleton input.jpg --crop 12 12 732 732 --out result. '
                    'Outputs: input crop, mask, skeleton, overlay PNG, overlay SVG, graph JSON.')
    ap.add_argument('image', type=Path)
    ap.add_argument('--crop', nargs=4, type=int, metavar=('LEFT','TOP','RIGHT','BOTTOM'))
    ap.add_argument('--out', type=Path, default=Path('result'))
    ap.add_argument('--raw', action='store_true', help='Only Gaussian smoothing + Otsu; skip mask cleanup/pruning')
    ap.add_argument('--min-area', type=int, default=80)
    ap.add_argument('--prune-px', type=float, default=12)
    args = ap.parse_args()
    image = Image.open(args.image).convert('RGB')
    if args.crop:
        image = image.crop(args.crop)
    result, mask, skeleton = analyze(image, clean=not args.raw, min_area=args.min_area, prune_px=args.prune_px)
    result['crop_box_in_source'] = args.crop
    save_results(image, result, mask, skeleton, args.out)
    print(json.dumps(result['statistics'], ensure_ascii=False))


if __name__ == '__main__':
    main()
