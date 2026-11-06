"""Overlay rendering and result export for the skeleton graph."""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw

COLORS = dict(endpoint='#16a477', junction='#dc285e', isolated='#77818c',
              cycle_anchor='#d78a12', sample='#e69a27', edge='#2474b8', center='#9c38b7')


def render_overlay(image, result):
    scale = 2
    faded = Image.blend(image.convert('RGB'), Image.new('RGB', image.size, '#ffffff'), 0.70)
    out = faded.resize((image.width*scale, image.height*scale), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(out)
    def dot(x, y, color, radius=3.5):
        x, y, r = x*scale, y*scale, radius*scale
        draw.ellipse((x-r, y-r, x+r, y+r), fill=color, outline='white', width=2)
    for edge in result['edges']:
        xy = [(x*scale, y*scale) for x, y in edge['display_points_xy']]
        if len(xy) > 1:
            draw.line(xy, fill=COLORS['edge'], width=3)
        for x,y in edge['sample_points_xy']:
            dot(x, y, COLORS['sample'], 2.8)
    for n in result['nodes']:
        dot(n['x'], n['y'], COLORS[n['type']])
    if result['centroid_xy']:
        x, y = (v*scale for v in result['centroid_xy'])
        for a in range(0, out.width, 24):
            draw.line((a,y,a+13,y),fill=COLORS['center'],width=2)
        for a in range(0, out.height, 24):
            draw.line((x,a,x,a+13),fill=COLORS['center'],width=2)
        draw.ellipse((x-12,y-12,x+12,y+12), outline=COLORS['center'], width=3)
    return out.resize(image.size, Image.Resampling.LANCZOS)


def render_svg(image, result):
    buf = io.BytesIO()
    image.save(buf, format='JPEG', quality=88)
    data = base64.b64encode(buf.getvalue()).decode()
    w, h = image.size
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">',
           '<title>Computed geometric skeleton; not inferred stroke order</title>',
           f'<rect width="{w}" height="{h}" fill="white"/>',
           f'<image width="{w}" height="{h}" opacity="0.3" href="data:image/jpeg;base64,{data}"/>']
    for edge in result['edges']:
        pts = ' '.join(f'{x},{y}' for x,y in edge['display_points_xy'])
        out.append(f'<polyline points="{pts}" fill="none" stroke="{COLORS["edge"]}" stroke-width="1.4"/>')
        for x,y in edge['sample_points_xy']:
            out.append(f'<circle cx="{x}" cy="{y}" r="2.8" fill="{COLORS["sample"]}" stroke="white"/>')
    for n in result['nodes']:
        out.append(f'<circle cx="{n["x"]}" cy="{n["y"]}" r="3.5" fill="{COLORS[n["type"]]}" stroke="white"/>')
    if result['centroid_xy']:
        x,y = result['centroid_xy']
        out.append(f'<path d="M0 {y}H{w} M{x} 0V{h}" stroke="{COLORS["center"]}" stroke-dasharray="8 6"/>')
        out.append(f'<circle cx="{x}" cy="{y}" r="6" fill="none" stroke="{COLORS["center"]}"/>')
    return '\n'.join(out + ['</svg>'])


def save_results(image, result, mask, skeleton, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    image.save(out / 'input.png')
    Image.fromarray(mask.astype('uint8') * 255).save(out / 'mask.png')
    Image.fromarray(skeleton.astype('uint8') * 255).save(out / 'skeleton.png')
    render_overlay(image, result).save(out / 'overlay.png')
    (out / 'overlay.svg').write_text(render_svg(image, result), encoding='utf-8')
    (out / 'graph.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
