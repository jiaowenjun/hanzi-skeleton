// App-side utilities: input handling helpers, demo glyph generation, exports.
// The skeleton pipeline itself lives in ../pipeline.js (parity-locked, do not edit here).
import * as HanziSkeleton from '@/pipeline.js';

export type Crop = { x: number; y: number; w: number; h: number };

export type PipelineResult = ReturnType<typeof HanziSkeleton.analyze>['result'];

export type RunOutput = {
  result: PipelineResult;
  mask: Uint8Array;
  skeleton: Uint8Array;
  width: number;
  height: number;
  imageDataUrl: string;
};

/** Processing-size cap so parameters stay near their ~700px calibration. */
export const MAX_SIDE = 1000;

/** Yield so progress text can paint; requestAnimationFrame alone never fires in hidden tabs. */
export const frame = () => Promise.race([
  new Promise((r) => requestAnimationFrame(() => r(null))),
  new Promise((r) => setTimeout(() => r(null), 30)),
]);

export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number) {
  return HanziSkeleton.rgbaToGray(rgba, width, height);
}

/**
 * Heuristic evaluated on the CURRENT crop region (a bright paper margin around
 * a dark rubbing panel would fool a whole-image guess): rubbings are bright
 * glyph on dark ground, so a dark ring around a brighter centre means the
 * picture is already bright-on-dark and needs no inversion.
 */
export function guessInvert(source: CanvasImageSource, region: Crop): boolean {
  const c = document.createElement('canvas');
  const s = Math.min(1, 160 / Math.max(region.w, region.h));
  c.width = Math.max(2, Math.round(region.w * s));
  c.height = Math.max(2, Math.round(region.h * s));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ringSum = 0, ringN = 0, cenSum = 0, cenN = 0;
  const band = Math.max(1, Math.round(Math.min(c.width, c.height) * 0.08));
  const x0 = c.width >> 2, y0 = c.height >> 2, x1 = c.width - x0, y1 = c.height - y0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const l = HanziSkeleton.pilLuma(d[(y * c.width + x) * 4], d[(y * c.width + x) * 4 + 1], d[(y * c.width + x) * 4 + 2]);
      if (x < band || y < band || x >= c.width - band || y >= c.height - band) { ringSum += l; ringN++; }
      else if (x >= x0 && x < x1 && y >= y0 && y < y1) { cenSum += l; cenN++; }
    }
  }
  const ring = ringSum / ringN, cen = cenSum / cenN;
  return ring > cen;  // bright frame around darker glyph = black-on-white
}

/** Procedural demo: bright thick strokes on dark ground with speckles,
 *  so the page can be tried without redistributing the reference photos. */
export function makeDemoDataURL(): string {
  const c = document.createElement('canvas');
  c.width = 720; c.height = 720;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1d1f22';
  ctx.fillRect(0, 0, 720, 720);
  ctx.strokeStyle = '#e8e4da';
  ctx.lineCap = 'round';
  ctx.lineWidth = 26;
  // 横
  ctx.beginPath(); ctx.moveTo(120, 180); ctx.lineTo(610, 180); ctx.stroke();
  // 撇
  ctx.beginPath(); ctx.moveTo(300, 130); ctx.lineTo(160, 420); ctx.stroke();
  // 竖弯钩
  ctx.beginPath(); ctx.moveTo(430, 150); ctx.lineTo(430, 400);
  ctx.quadraticCurveTo(430, 560, 620, 540); ctx.stroke();
  // 口（环）
  ctx.lineWidth = 20;
  ctx.beginPath(); ctx.rect(180, 480, 220, 170); ctx.stroke();
  // 点
  ctx.beginPath(); ctx.arc(560, 300, 20, 0, 7); ctx.fill();
  // 石花噪声
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  ctx.fillStyle = '#cfcabc';
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 720, y = rnd() * 720, r = rnd() * 3.2;
    ctx.globalAlpha = 0.25 + 0.75 * rnd();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  return c.toDataURL('image/png');
}

export function binaryDataUrl(bits: Uint8Array, width: number, height: number): string {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? 255 : 0;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Marker palette for the overlay view (light and dark values share names). */
export const MARKER_COLORS: Record<string, { light: string; dark: string }> = {
  edge: { light: '#2474b8', dark: '#66b3f1' },
  endpoint: { light: '#128362', dark: '#48d4a3' },
  junction: { light: '#d42957', dark: '#ff7b9a' },
  sample: { light: '#bf710b', dark: '#ffbd63' },
  center: { light: '#943ab2', dark: '#d5a0f1' },
  isolated: { light: '#77818c', dark: '#9aa4b0' },
  cycle_anchor: { light: '#d78a12', dark: '#ffbd63' },
};

export function overlaySvgText(output: RunOutput): string {
  const { result, width, height, imageDataUrl } = output;
  const col = (name: string) => MARKER_COLORS[name].light;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    '<title>Computed geometric skeleton; not inferred stroke order</title>',
    `<rect width="${width}" height="${height}" fill="white"/>`,
    `<image width="${width}" height="${height}" opacity="0.3" href="${imageDataUrl}"/>`];
  for (const e of result.edges) {
    const pts = e.display_points_xy.map((p: number[]) => p.join(',')).join(' ');
    out.push(`<polyline points="${pts}" fill="none" stroke="${col('edge')}" stroke-width="1.4"/>`);
    for (const [x, y] of e.sample_points_xy) {
      out.push(`<circle cx="${x}" cy="${y}" r="2.8" fill="${col('sample')}" stroke="white"/>`);
    }
  }
  for (const n of result.nodes) {
    out.push(`<circle cx="${n.x}" cy="${n.y}" r="3.5" fill="${col(n.type)}" stroke="white"/>`);
  }
  if (result.centroid_xy) {
    const [x, y] = result.centroid_xy;
    out.push(`<path d="M0 ${y}H${width} M${x} 0V${height}" stroke="${col('center')}" stroke-dasharray="8 6"/>`);
    out.push(`<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${col('center')}"/>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

export function download(name: string, mime: string, data: string) {
  const a = document.createElement('a');
  if (!data.startsWith('data:')) {
    data = URL.createObjectURL(new Blob([data], { type: mime }));
  }
  a.href = data;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
