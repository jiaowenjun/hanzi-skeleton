#!/usr/bin/env node
/**
 * Compare the JavaScript port (web/pipeline.js) against the Python reference
 * artifacts exported by scripts/compare_port.py, stage by stage:
 *
 *   gray -> gaussian smooth -> otsu threshold -> mask (raw)
 *        -> specks/closing/holes -> mask (clean)
 *        -> distance transform -> zhang skeleton -> prune
 *        -> sknw graph -> exported graph JSON
 *
 * Usage: node scripts/compare_port.mjs [--ref work/port-ref]
 * Exit code 0 only if every stage passes its tolerance.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as H from '../web/src/pipeline.js';

const REF = process.argv.includes('--ref')
  ? resolve(process.argv[process.argv.indexOf('--ref') + 1])
  : resolve('work/port-ref');

const meta = JSON.parse(readFileSync(join(REF, 'meta.json'), 'utf8'));

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function readU8(p) { return new Uint8Array(readFileSync(p)); }
function readF64(p) {
  const buf = readFileSync(p);
  const out = new Float64Array(buf.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

function diffU8(a, b) {
  if (a.length !== b.length) return { count: Math.abs(a.length - b.length), total: a.length };
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return { count, total: a.length };
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

for (const caseMeta of meta) {
  const { name, width, height } = caseMeta;
  const dir = join(REF, name);
  console.log(`\n=== ${name} (${width}x${height}) ===`);
  const gray = readU8(join(dir, 'gray.bin'));
  const refSmooth = readF64(join(dir, 'smooth.bin'));
  const refThreshold = parseFloat(readFileSync(join(dir, 'threshold.txt'), 'utf8'));

  // Stage 1: gaussian smooth.
  const grayF = new Float64Array(gray.length);
  for (let i = 0; i < gray.length; i++) grayF[i] = gray[i] / 255;
  const smooth = H.gaussianSmooth(grayF, width, height, 1.0);
  const smoothDiff = maxAbsDiff(smooth, refSmooth);
  check('gaussian smooth', smoothDiff <= 1e-15, `max|Δ|=${smoothDiff.toExponential(2)}`);

  // Stage 2: otsu threshold.
  const threshold = H.otsuThreshold(smooth);
  check('otsu threshold', Math.abs(threshold - refThreshold) <= 1e-15,
    `js=${threshold.toFixed(15)} py=${refThreshold.toFixed(15)} Δ=${Math.abs(threshold - refThreshold).toExponential(2)}`);

  for (const [variant, clean] of [['raw', false], ['clean', true]]) {
    console.log(`  -- variant: ${variant} --`);
    // Stage 3: raw mask.
    let mask = new Uint8Array(gray.length);
    for (let i = 0; i < mask.length; i++) mask[i] = smooth[i] > threshold ? 1 : 0;
    const d0 = diffU8(mask, readU8(join(dir, `${variant}_mask0.bin`)));
    check('mask (otsu)', d0.count === 0, `${d0.count}/${d0.total} px differ`);

    if (clean) {
      mask = H.removeSpecks(mask, width, height, 80);
      mask = H.closingCross(mask, width, height);
      mask = H.fillSmallHoles(mask, width, height, 48);
    }
    const d = diffU8(mask, readU8(join(dir, `${variant}_mask.bin`)));
    check('mask (cleaned)', d.count === 0, `${d.count}/${d.total} px differ`);

    // Stage 4: distance transform.
    const distance = H.edt(mask, width, height);
    {
      const refDist = readF64(join(dir, `${variant}_distance.bin`));
      const distDiff = maxAbsDiff(distance, refDist);
      check('distance transform', distDiff <= 1e-12, `max|Δ|=${distDiff.toExponential(2)}`);
    }

    // Stage 5: zhang skeleton.
    let skeleton = H.zhangSkeletonize(mask, width, height);
    const s0 = diffU8(skeleton, readU8(join(dir, `${variant}_skeleton0.bin`)));
    check('skeleton (zhang)', s0.count === 0, `${s0.count}/${s0.total} px differ`);

    // Stage 6: prune.
    if (clean) skeleton = H.pruneShortLeaves(skeleton, width, height, distance, 12);

    // Stage 7: graph + JSON export via analyze().
    const { result } = H.analyze(gray, width, height,
      { clean, minArea: 80, prunePx: 12, sigma: 1.0 });
    const ref = JSON.parse(readFileSync(join(dir, `${variant}_graph.json`), 'utf8'));
    const s = result.statistics, r = ref.statistics;
    check('statistics', JSON.stringify(s) === JSON.stringify(r),
      `js ${JSON.stringify(s)} vs py ${JSON.stringify(r)}`);

    const nodeOk = result.nodes.length === ref.nodes.length
      && result.nodes.every((n, i) =>
        n.id === ref.nodes[i].id && n.x === ref.nodes[i].x && n.y === ref.nodes[i].y
        && n.degree === ref.nodes[i].degree && n.type === ref.nodes[i].type);
    check(`nodes (${result.nodes.length})`, nodeOk,
      nodeOk ? '' : `first diff at ${result.nodes.findIndex((n, i) =>
        n.x !== ref.nodes[i].x || n.y !== ref.nodes[i].y || n.degree !== ref.nodes[i].degree)}`);

    let edgeOk = result.edges.length === ref.edges.length;
    let maxLenDiff = 0, maxCoordDiff = 0, firstBadEdge = -1;
    if (edgeOk) {
      for (let i = 0; i < result.edges.length; i++) {
        const e = result.edges[i], f = ref.edges[i];
        if (e.source !== f.source || e.target !== f.target || e.key !== f.key) {
          edgeOk = false; firstBadEdge = i; break;
        }
        maxLenDiff = Math.max(maxLenDiff, Math.abs(e.length_px - f.length_px));
        if (e.points_xy.length !== f.points_xy.length) { edgeOk = false; firstBadEdge = i; break; }
        for (let k = 0; k < e.points_xy.length; k++) {
          maxCoordDiff = Math.max(maxCoordDiff,
            Math.abs(e.points_xy[k][0] - f.points_xy[k][0]),
            Math.abs(e.points_xy[k][1] - f.points_xy[k][1]));
        }
      }
    }
    check(`edges (${result.edges.length})`, edgeOk && maxLenDiff <= 1e-3 && maxCoordDiff <= 0.011,
      edgeOk
        ? `max|Δlength|=${maxLenDiff.toExponential(2)} max|Δcoord|=${maxCoordDiff}`
        : `structure differs at edge ${firstBadEdge}`);

    const centroidOk = JSON.stringify(result.centroid_xy) === JSON.stringify(ref.centroid_xy);
    check('centroid', centroidOk,
      `${JSON.stringify(result.centroid_xy)} vs ${JSON.stringify(ref.centroid_xy)}`);
    check('threshold param', result.parameters.threshold_otsu === ref.parameters.threshold_otsu,
      `${result.parameters.threshold_otsu} vs ${ref.parameters.threshold_otsu}`);
  }
}

console.log(failures === 0
  ? `\nAll stages match the Python reference.`
  : `\n${failures} stage(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
