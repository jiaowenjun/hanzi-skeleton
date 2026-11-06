/**
 * hanzi-skeleton browser pipeline — a faithful JavaScript port of rubbing_graph.py.
 *
 * Every stage replicates the numeric behaviour of the pinned Python stack
 * (numpy 2.5 / scipy 1.18 / scikit-image 0.26 / sknw 0.15) so that the two
 * implementations can be diffed stage by stage via scripts/compare_port.*:
 *
 *   grayscale      PIL Image.convert('L') integer luma formula
 *   gaussian       scipy.ndimage.gaussian_filter, sigma=1, truncate=4, mode='nearest'
 *   otsu           skimage.filters.threshold_otsu, 256 bins over the float range
 *   specks/holes   scipy.ndimage.label connected-component bookkeeping
 *   closing        skimage.morphology.closing(disk(1), mode='ignore')
 *   distance       exact EDT (Felzenszwalb), outside array counts as background
 *   skeletonize    scikit-image Zhang-Suen LUT thinning (parallel two-phase)
 *   graph          sknw mark/fill/trace/parse_struc, raster order preserved
 *   pruning        rubbing_graph.prune_short_leaves, MultiGraph degree semantics
 *
 * UMD: usable from a plain <script> tag (window.HanziSkeleton) and from Node
 * (require('./pipeline.js')) without any build step or dependency.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HanziSkeleton = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Numeric helpers matching numpy / Python rounding semantics.
   * ------------------------------------------------------------------ */

  // np.rint / np.round on an integer-valued float: half to even.
  function roundHalfEven(v) {
    const f = Math.floor(v);
    const d = v - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // np.round(x, 2): multiply, round half to even, divide back.
  function npRound2(x) {
    return roundHalfEven(x * 100) / 100;
  }

  // np.round(x, 3)
  function npRound3(x) {
    return roundHalfEven(x * 1000) / 1000;
  }

  // Python round(float, 2) for the JSON export (close enough for tolerance
  // comparisons; integer inputs are exact).
  function pyRound2(x) {
    return npRound2(x);
  }

  // np.arange(start, stop, step) with float steps, ascending only.
  function npArange(start, stop, step) {
    const out = [];
    if (stop > start) {
      const n = Math.ceil((stop - start) / step);
      for (let k = 0; k < n; k++) out.push(start + k * step);
    }
    return out;
  }

  // np.interp for a single x over ascending xp, assuming x within [xp0, xpl].
  function npInterp(x, xp, fp) {
    let lo = 0, hi = xp.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xp[mid] <= x) lo = mid; else hi = mid;
    }
    const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
    return fp[lo] + t * (fp[hi] - fp[lo]);
  }

  /* ------------------------------------------------------------------ *
   * Grayscale: PIL Image.convert('L') exact integer formula.
   * ------------------------------------------------------------------ */

  function pilLuma(r, g, b) {
    // (19595*R + 38470*G + 7471*B + 0x8000) >> 16  (ITU-R 601-2, verified)
    return (r * 19595 + g * 38470 + b * 7471 + 32768) >>> 16;
  }

  /** Convert RGBA pixel data (Uint8ClampedArray) to a Uint8Array of PIL 'L' bytes. */
  function rgbaToGray(rgba, width, height) {
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = pilLuma(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Gaussian smoothing: scipy.ndimage.gaussian_filter, mode 'nearest'.
   * Separable kernel, radius = int(truncate * sigma + 0.5); axis 0 first.
   * ------------------------------------------------------------------ */

  function gaussianKernel(sigma, truncate) {
    // Mirrors scipy.ndimage._filters._gaussian_kernel1d (scipy 1.18):
    // phi_x = exp(-0.5 / sigma^2 * x^2) over [-radius, radius], normalized
    // by numpy's pairwise summation of the 9 taps.
    const radius = Math.floor(truncate * sigma + 0.5);  // scipy uses int(...)
    const sd = sigma * sigma;
    const a = new Float64Array(2 * radius + 1);
    for (let i = 0; i < a.length; i++) {
      const x = i - radius;
      a[i] = Math.exp(-0.5 / sd * (x * x));
    }
    // numpy pairwise sum for n = 9: ((a0+a1)+(a2+a3)) + ((a4+a5)+(a6+a7)) + a8
    let sum;
    if (a.length === 9) {
      sum = (((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]))) + a[8];
    } else {
      sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i];
    }
    const taps = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) taps[i] = a[i] / sum;
    return taps;
  }

  /* Software FMA: round(a*b + c) with a single rounding (Dekker twoProduct
   * plus Kahan twoSum). The macOS arm64 wheels of scipy compile the symmetric
   * correlate loop into fused multiply-adds, so bit-exact parity with the
   * reference binary requires reproducing the single-rounding behaviour. */
  const FMA_SPLIT = 134217729;  // 2^27 + 1
  function fma(a, b, c) {
    const p = a * b;
    const at = FMA_SPLIT * a, bt = FMA_SPLIT * b;
    const ahi = at - (at - a), alo = a - ahi;
    const bhi = bt - (bt - b), blo = b - bhi;
    const e = ((ahi * bhi - p) + ahi * blo + alo * bhi) + alo * blo;
    const s = p + c;
    const t = s - p;
    const e2 = (p - (s - t)) + (c - t);
    return s + (e + e2);
  }

  function gaussianSmooth(src, width, height, sigma, truncate) {
    truncate = truncate === undefined ? 4.0 : truncate;
    const taps = gaussianKernel(sigma, truncate);
    const radius = (taps.length - 1) >> 1;
    // Accumulation order matches scipy's symmetric-kernel path in
    // NI_Correlate1D: centre term first, then (x[-k] + x[k]) * w[-k] pairs
    // from the outermost inwards, one multiply per pair.
    function correlate1dSymmetric(get, length) {
      const out = new Float64Array(length);
      for (let i = 0; i < length; i++) {
        const center = get(i);
        let acc = center * taps[radius];
        for (let k = radius; k >= 1; k--) {
          acc = fma(get(i - k) + get(i + k), taps[radius - k], acc);
        }
        out[i] = acc;
      }
      return out;
    }
    // Pass along axis 0 (vertical), replicating edge pixels ('nearest').
    const tmp = new Float64Array(width * height);
    for (let x = 0; x < width; x++) {
      const col = correlate1dSymmetric((y) => {
        if (y < 0) y = 0; else if (y >= height) y = height - 1;
        return src[y * width + x];
      }, height);
      for (let y = 0; y < height; y++) tmp[y * width + x] = col[y];
    }
    // Pass along axis 1 (horizontal).
    const out = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      const line = correlate1dSymmetric((x) => {
        if (x < 0) x = 0; else if (x >= width) x = width - 1;
        return tmp[row + x];
      }, width);
      for (let x = 0; x < width; x++) out[row + x] = line[x];
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Otsu threshold over a float image, replicating
   * skimage.filters.threshold_otsu + skimage.exposure.histogram.
   * ------------------------------------------------------------------ */

  function otsuThreshold(img) {
    let min = Infinity, max = -Infinity;
    const first = img[0];
    let allSame = true;
    for (let i = 0; i < img.length; i++) {
      const v = img[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (v !== first) allSame = false;
    }
    if (allSame) return first;

    const nbins = 256;
    const counts = new Float64Array(nbins);
    const norm = nbins / (max - min);
    for (let i = 0; i < img.length; i++) {
      // numpy fast path: floor((v - first_edge) * norm), clipped into range.
      let idx = Math.floor((img[i] - min) * norm);
      if (idx >= nbins) idx = nbins - 1;   // v == max lands in the last bin
      counts[idx]++;
    }
    // Bin edges follow np.linspace(min, max, nbins + 1): the endpoint is exact.
    const step = (max - min) / nbins;
    const centers = new Float64Array(nbins);
    for (let i = 0; i < nbins; i++) {
      const lo = min + i * step;
      const hi = i + 1 === nbins ? max : min + (i + 1) * step;
      centers[i] = (lo + hi) / 2;
    }

    const weight1 = new Float64Array(nbins);
    const weight2 = new Float64Array(nbins);
    const mean1 = new Float64Array(nbins);
    const mean2 = new Float64Array(nbins);
    let acc1 = 0, accm1 = 0;
    for (let i = 0; i < nbins; i++) {
      acc1 += counts[i];
      accm1 += counts[i] * centers[i];
      weight1[i] = acc1;
      mean1[i] = accm1 / acc1;
    }
    let acc2 = 0, accm2 = 0;
    for (let i = nbins - 1; i >= 0; i--) {
      acc2 += counts[i];
      accm2 += counts[i] * centers[i];
      weight2[i] = acc2;
      mean2[i] = accm2 / acc2;
    }

    let bestIdx = 0, bestVar = -1;
    for (let i = 0; i < nbins - 1; i++) {
      const dm = mean1[i] - mean2[i + 1];
      const var12 = weight1[i] * weight2[i + 1] * dm * dm;
      if (var12 > bestVar) { bestVar = var12; bestIdx = i; }  // argmax: first max
    }
    return centers[bestIdx];
  }

  /* ------------------------------------------------------------------ *
   * Connected components (scipy.ndimage.label equivalents; the boolean
   * results do not depend on label numbering).
   * ------------------------------------------------------------------ */

  /**
   * Label connected components of a binary grid.
   * connectivity: 1 = 4-connected (scipy default), 2 = 8-connected.
   * Returns Int32Array of labels (0 = background) and the component count.
   */
  function labelComponents(mask, width, height, connectivity) {
    const labels = new Int32Array(width * height);
    const offs = connectivity === 2
      ? [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]
      : [-width, -1, 1, width];
    let next = 0;
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      next++;
      let head = 0, tail = 0;
      queue[tail++] = start;
      labels[start] = next;
      while (head < tail) {
        const p = queue[head++];
        for (let k = 0; k < offs.length; k++) {
          const q = p + offs[k];
          // Guard the wrap-around at row / column boundaries.
          if (q < 0 || q >= mask.length) continue;
          if (connectivity === 2) {
            const dx = (q % width) - (p % width);
            if (dx < -1 || dx > 1) continue;
          }
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            queue[tail++] = q;
          }
        }
      }
    }
    return { labels, count: next };
  }

  /** rubbing_graph.remove_specks: drop 8-connected components below min_area. */
  function removeSpecks(mask, width, height, minArea) {
    const { labels, count } = labelComponents(mask, width, height, 2);
    const sizes = new Int32Array(count + 1);
    for (let i = 0; i < labels.length; i++) sizes[labels[i]]++;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (l && sizes[l] >= minArea) out[i] = 1;
    }
    return out;
  }

  /** skimage.morphology.closing(mask, disk(1), mode='ignore'): dilate then
   *  erode with a cross footprint; out-of-bounds neighbours never influence
   *  the result (dilation sees 0, erosion sees 1). */
  function closingCross(mask, width, height) {
    const dil = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v = mask[i];
        if (!v) {
          if ((y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width]) ||
              (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1])) v = 1;
        }
        dil[i] = v;
      }
    }
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let v = dil[i];
        if (v) {
          if ((y > 0 && !dil[i - width]) || (y < height - 1 && !dil[i + width]) ||
              (x > 0 && !dil[i - 1]) || (x < width - 1 && !dil[i + 1])) v = 0;
        }
        out[i] = v;
      }
    }
    return out;
  }

  /** rubbing_graph.fill_small_holes: fill 4-connected background components
   *  of size <= max_area unless they touch the image border. */
  function fillSmallHoles(mask, width, height, maxArea) {
    const bg = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) bg[i] = mask[i] ? 0 : 1;
    const { labels, count } = labelComponents(bg, width, height, 1);
    const sizes = new Int32Array(count + 1);
    for (let i = 0; i < labels.length; i++) sizes[labels[i]]++;
    const border = new Uint8Array(count + 1);
    for (let x = 0; x < width; x++) {
      border[labels[x]] = 1;
      border[labels[(height - 1) * width + x]] = 1;
    }
    for (let y = 0; y < height; y++) {
      border[labels[y * width]] = 1;
      border[labels[y * width + width - 1]] = 1;
    }
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const l = labels[i];
      out[i] = mask[i] || (l && !border[l] && sizes[l] <= maxArea) ? 1 : 0;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
   * scipy.ndimage.distance_transform_edt treats the region outside the
   * array as background, which we model with a one-pixel zero ring.
   * ------------------------------------------------------------------ */

  function edt1dSq(f, n) {
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = -1;
    // Parabolas of infinite height (a run with no background) never lie on
    // the lower envelope, so they are skipped during construction; queries
    // before the first background still measure against the nearest one.
    for (let q = 0; q < n; q++) {
      if (f[q] === Infinity) continue;
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    if (k < 0) {
      d.fill(Infinity);
      return d;
    }
    let kk = 0;
    for (let q = 0; q < n; q++) {
      while (z[kk + 1] < q) kk++;
      const dq = q - v[kk];
      d[q] = dq * dq + f[v[kk]];
    }
    return d;
  }

  /** Distance (in pixels) from every pixel to the nearest background (zero)
   *  pixel of the mask itself. Like scipy.ndimage.distance_transform_edt,
   *  the region outside the array is NOT background; rows or columns with no
   *  background at all propagate Infinity, which the Otsu mask guarantees
   *  never happens for the full image. */
  function edt(mask, width, height) {
    let g = new Float64Array(width * height);      // squared distances
    const row = new Float64Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        row[x] = mask[y * width + x] ? Infinity : 0;
      }
      const d = edt1dSq(row, width);
      for (let x = 0; x < width; x++) g[y * width + x] = d[x];
    }
    const col = new Float64Array(height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) col[y] = g[y * width + x];
      const d = edt1dSq(col, height);
      for (let y = 0; y < height; y++) g[y * width + x] = d[y];
    }
    const out = new Float64Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(g[i]);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Zhang-Suen skeletonization — port of scikit-image's
   * _fast_skeletonize (Cython), including its 256-entry lookup table and
   * the parallel (per-subiteration frozen) update semantics.
   * ------------------------------------------------------------------ */

  const ZHANG_LUT = new Uint8Array([
    0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0,
    1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0,
    3, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 0, 0, 0, 3, 0, 2, 2, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0,
    0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0,
    3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0,
    2, 0, 0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 3, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 1, 3,
    0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0,
    2, 0, 0, 0]);

  function zhangSkeletonize(mask, width, height) {
    const nrows = height + 2, ncols = width + 2;
    const skeleton = new Uint8Array(nrows * ncols);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        skeleton[(y + 1) * ncols + (x + 1)] = mask[y * width + x] ? 1 : 0;
      }
    }
    const cleaned = skeleton.slice();

    let pixelRemoved = true;
    while (pixelRemoved) {
      pixelRemoved = false;
      for (let passNum = 0; passNum < 2; passNum++) {
        const firstPass = passNum === 0;
        for (let row = 1; row < nrows - 1; row++) {
          for (let col = 1; col < ncols - 1; col++) {
            if (skeleton[row * ncols + col]) {
              const i = row * ncols + col;
              const code =
                skeleton[i - ncols - 1] +
                2 * skeleton[i - ncols] +
                4 * skeleton[i - ncols + 1] +
                8 * skeleton[i + 1] +
                16 * skeleton[i + ncols + 1] +
                32 * skeleton[i + ncols] +
                64 * skeleton[i + ncols - 1] +
                128 * skeleton[i - 1];
              const n = ZHANG_LUT[code];
              if (n === 0) continue;
              if (n === 3 || (n === 1 && firstPass) || (n === 2 && !firstPass)) {
                cleaned[i] = 0;
                pixelRemoved = true;
              }
            }
          }
        }
        skeleton.set(cleaned);
      }
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out[y * width + x] = skeleton[(y + 1) * ncols + (x + 1)];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * sknw port: skeleton pixels -> MultiGraph.
   * Coordinates are (row, col) in the ORIGINAL (unpadded) frame, matching
   * sknw's idx2rc(... ) - 1.
   * ------------------------------------------------------------------ */

  // Neighbour flat offsets in sknw's fixed order: NW N NE W E SW S SE.
  function sknwNeighborOffsets(paddedWidth) {
    return [-paddedWidth - 1, -paddedWidth, -paddedWidth + 1, -1, 1,
            paddedWidth - 1, paddedWidth, paddedWidth + 1];
  }

  /**
   * Build the graph from a skeleton bitmap.
   * Returns { nodes: [{ o:[y,x] (int), pts:[[y,x],...] }], edges: [{u, v, pts,
   * weight}] } with nodes / edges in sknw's deterministic raster order.
   * opts: { iso=true, ring=true, full=true }
   */
  function buildSknw(skeleton, width, height, opts) {
    opts = opts || {};
    const iso = opts.iso !== false;
    const ring = opts.ring !== false;
    const full = opts.full !== false;

    const W = width + 2, H = height + 2;
    const img = new Int32Array(W * H);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        img[(y + 1) * W + (x + 1)] = skeleton[y * width + x] ? 1 : 0;
      }
    }
    const nbs = sknwNeighborOffsets(W);

    // sknw.mark: pixels with exactly two neighbours become path (1),
    // everything else becomes node (2).
    for (let p = 0; p < img.length; p++) {
      if (img[p] === 0) continue;
      let s = 0;
      for (let k = 0; k < 8; k++) if (img[p + nbs[k]] !== 0) s++;
      img[p] = s === 2 ? 1 : 2;
    }

    // idx2rc with the -1 unshift back to the original frame.
    function idx2rc(list) {
      const out = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        out[i] = [Math.floor(p / W) - 1, p % W - 1];
      }
      return out;
    }

    // sknw.fill: BFS over one connected node cluster.
    function fill(p, num) {
      img[p] = num;
      const buf = [p];
      let cur = 0;
      let isIso = true;
      while (cur < buf.length) {
        const q = buf[cur];
        for (let k = 0; k < 8; k++) {
          const cp = q + nbs[k];
          if (img[cp] === 2) {
            img[cp] = num;
            buf.push(cp);
          }
          if (img[cp] === 1) isIso = false;
        }
        cur++;
      }
      return { isIso, pts: idx2rc(buf) };
    }

    // sknw.trace: walk a path from one node cluster to the next.
    function trace(p) {
      let c1 = 0, c2 = 0, newp = 0, cur = 1;
      const buf = [0, p];
      for (;;) {
        buf[cur] = p;
        img[p] = 0;
        cur++;
        for (let k = 0; k < 8; k++) {
          const cp = p + nbs[k];
          const v = img[cp];
          if (v >= 10) {
            if (c1 === 0) {
              c1 = v;
              buf[0] = cp;
            } else {
              c2 = v;
              buf[cur] = cp;
            }
          }
          if (v === 1) newp = cp;   // last matching neighbour wins (sknw order)
        }
        p = newp;
        if (c2 !== 0) break;
      }
      return { u: c1 - 10, v: c2 - 10, pts: idx2rc(buf.slice(0, cur + 1)) };
    }

    // sknw.parse_struc
    const nodeClusters = [];
    let num = 10;
    for (let p = 0; p < img.length; p++) {
      if (img[p] === 2) {
        const { isIso, pts } = fill(p, num);
        if (isIso && !iso) continue;
        num++;
        nodeClusters.push(pts);
      }
    }
    const traced = [];
    for (let p = 0; p < img.length; p++) {
      if (img[p] < 10) continue;
      for (let k = 0; k < 8; k++) {
        if (img[p + nbs[k]] === 1) traced.push(trace(p + nbs[k]));
      }
    }
    if (ring) {
      for (let p = 0; p < img.length; p++) {
        if (img[p] !== 1) continue;
        img[p] = num;
        num++;
        nodeClusters.push(idx2rc([p]));
        for (let k = 0; k < 8; k++) {
          if (img[p + nbs[k]] === 1) traced.push(trace(p + nbs[k]));
        }
      }
    }

    // sknw.build_graph: centroid per node, snap edge endpoints, weight as
    // polyline length (computed after snapping, like the original).
    const nodes = nodeClusters.map((pts) => {
      let sy = 0, sx = 0;
      for (const [y, x] of pts) { sy += y; sx += x; }
      const oy = sy / pts.length, ox = sx / pts.length;
      return { o: full ? [roundHalfEven(oy), roundHalfEven(ox)] : [oy, ox], pts };
    });
    const edges = traced.map(({ u, v, pts }) => {
      const q = pts.slice();
      if (full) {
        q[0] = nodes[u].o.slice();
        q[q.length - 1] = nodes[v].o.slice();
      }
      let length = 0;
      for (let i = 1; i < q.length; i++) {
        const dy = q[i][0] - q[i - 1][0], dx = q[i][1] - q[i - 1][1];
        length += Math.sqrt(dy * dy + dx * dx);
      }
      return { u, v, pts: q, weight: length };
    });
    return { nodes, edges };
  }

  /* ------------------------------------------------------------------ *
   * MultiGraph mirroring networkx iteration order and degree semantics:
   * nodes in insertion order; edges yielded grouped by the first endpoint
   * (node order), then adjacency insertion order, then key; self-loops
   * count twice towards degree.
   * ------------------------------------------------------------------ */

  class MultiGraph {
    constructor(sknwGraph) {
      this.nodesData = sknwGraph.nodes;   // [{ o:[y,x], pts:[[y,x],...] }]
      this.nodeCount = sknwGraph.nodes.length;
      this.adj = new Array(this.nodeCount);
      for (let i = 0; i < this.nodeCount; i++) this.adj[i] = new Map();
      this.edgeList = [];  // insertion order, for number_of_edges
      this.keyCount = new Map();
      for (const e of sknwGraph.edges) this.addEdge(e.u, e.v, e);
    }

    addEdge(u, v, data) {
      const pairKey = u <= v ? u + ':' + v : v + ':' + u;
      const key = this.keyCount.get(pairKey) || 0;
      this.keyCount.set(pairKey, key + 1);
      const record = { u, v, key, data };
      if (!this.adj[u].has(v)) this.adj[u].set(v, new Map());
      this.adj[u].get(v).set(key, record);
      if (v !== u) {
        if (!this.adj[v].has(u)) this.adj[v].set(u, new Map());
        this.adj[v].get(u).set(key, record);
      }
      this.edgeList.push(record);
      return record;
    }

    degree(n) {
      let deg = 0;
      for (const kdict of this.adj[n].values()) deg += kdict.size;
      if (this.adj[n].has(n)) deg += this.adj[n].get(n).size;  // self-loop twice
      return deg;
    }

    /** Rounded centroid 'o' of node n, in (row, col). */
    nodePos(n) {
      return this.nodesData[n].o;
    }

    /** All pixel positions belonging to node n's cluster. */
    nodePts(n) {
      return this.nodesData[n].pts;
    }

    /** Iterate (u, v, key, data) in networkx EdgeView order. The first two
     *  entries are oriented (primary node, neighbour), like networkx yields
     *  them, regardless of how the edge was stored. */
    *edges() {
      const seen = new Set();
      for (let n = 0; n < this.nodeCount; n++) {
        for (const [nbr, kdict] of this.adj[n]) {
          if (seen.has(nbr)) continue;
          for (const record of kdict.values()) {
            yield [n, nbr, record.key, record.data];
          }
        }
        seen.add(n);
      }
    }

    numberConnectedComponents() {
      const parent = new Int32Array(this.nodeCount);
      for (let i = 0; i < this.nodeCount; i++) parent[i] = i;
      const find = (a) => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      for (const r of this.edgeList) {
        const ra = find(r.u), rb = find(r.v);
        if (ra !== rb) parent[ra] = rb;
      }
      let count = 0;
      for (let i = 0; i < this.nodeCount; i++) if (find(i) === i) count++;
      return count;
    }
  }

  /* ------------------------------------------------------------------ *
   * rubbing_graph.prune_short_leaves
   * ------------------------------------------------------------------ */

  function pruneShortLeaves(skeleton, width, height, distance, maxLength, iterations) {
    iterations = iterations === undefined ? 2 : iterations;
    const out = skeleton.slice();
    for (let it = 0; it < iterations; it++) {
      const graph = new MultiGraph(buildSknw(out, width, height, {}));
      const remove = new Uint8Array(out.length);
      let any = false;
      for (const [u, v, , edge] of graph.edges()) {
        if (u === v) continue;
        const du = graph.degree(u), dv = graph.degree(v);
        if (!((du === 1 && dv >= 3) || (dv === 1 && du >= 3))) continue;
        const junction = du === 1 ? v : u;
        const [r, c] = graph.nodePos(junction);
        if (edge.weight >= Math.min(maxLength, 1.5 * distance[r * width + c])) continue;
        for (const [y, x] of edge.pts) { remove[y * width + x] = 1; any = true; }
      }
      // Preserve full junction clusters, not just their representative.
      for (let n = 0; n < graph.nodeCount; n++) {
        if (graph.degree(n) >= 3) {
          for (const [y, x] of graph.nodePts(n)) remove[y * width + x] = 0;
        }
      }
      if (!any) break;
      for (let i = 0; i < out.length; i++) if (remove[i]) out[i] = 0;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * skimage.measure.approximate_polygon — Douglas-Peucker variant with
   * perpendicular / endpoint distance selection and stack-based traversal.
   * coords: array of [row, col]; tolerance in pixels.
   * ------------------------------------------------------------------ */

  function approximatePolygon(coords, tolerance) {
    const n = coords.length;
    if (tolerance <= 0) return coords.slice();
    const chain = new Uint8Array(n);
    const dists = new Float64Array(n);
    chain[0] = 1;
    chain[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [start, end] = stack.pop();
      const r0 = coords[start][0], c0 = coords[start][1];
      const r1 = coords[end][0], c1 = coords[end][1];
      const dr = r1 - r0, dc = c1 - c0;
      const angle = -Math.atan2(dr, dc);
      const segDist = c0 * Math.sin(angle) + r0 * Math.cos(angle);

      let anyGreater = false;
      let maxIdx = -1, maxVal = -1;
      for (let i = start + 1; i < end; i++) {
        const ri = coords[i][0], ci = coords[i][1];
        const dr0 = ri - r0, dc0 = ci - c0;
        const dr1 = ri - r1, dc1 = ci - c1;
        const proj0 = dr0 * dr + dc0 * dc;
        const proj1 = -dr1 * dr - dc1 * dc;
        let d;
        if (proj0 > 0 && proj1 > 0) {
          d = Math.abs(ri * Math.cos(angle) + ci * Math.sin(angle) - segDist);
        } else {
          d = Math.min(Math.sqrt(dc0 * dc0 + dr0 * dr0),
                       Math.sqrt(dc1 * dc1 + dr1 * dr1));
        }
        dists[i] = d;
        if (d > tolerance) anyGreater = true;
        if (d > maxVal) { maxVal = d; maxIdx = i; }  // argmax: first max
      }
      if (anyGreater) {
        const newEnd = maxIdx;
        stack.push([newEnd, end]);
        stack.push([start, newEnd]);
        chain[newEnd] = 1;
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (chain[i]) out.push(coords[i]);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * rubbing_graph.analyze — the full pipeline and JSON-shaped result.
   * gray: Uint8Array (PIL 'L'); opts: { clean, minArea, prunePx, sigma }
   * ------------------------------------------------------------------ */

  function analyze(gray, width, height, opts) {
    opts = opts || {};
    const clean = opts.clean !== false;
    const minArea = opts.minArea === undefined ? 80 : opts.minArea;
    const prunePx = opts.prunePx === undefined ? 12 : opts.prunePx;
    const sigma = opts.sigma === undefined ? 1.0 : opts.sigma;

    // Normalize to float64 in [0, 1] like np.asarray(image.convert('L'), float)/255.
    const grayF = new Float64Array(gray.length);
    for (let i = 0; i < gray.length; i++) grayF[i] = gray[i] / 255;

    const smooth = gaussianSmooth(grayF, width, height, sigma);
    const threshold = otsuThreshold(smooth);
    let mask = new Uint8Array(gray.length);
    for (let i = 0; i < mask.length; i++) mask[i] = smooth[i] > threshold ? 1 : 0;

    if (clean) {
      mask = removeSpecks(mask, width, height, minArea);
      mask = closingCross(mask, width, height);
      mask = fillSmallHoles(mask, width, height, 48);
    }
    const distance = edt(mask, width, height);
    let skeleton = zhangSkeletonize(mask, width, height);
    if (clean && prunePx > 0) {
      skeleton = pruneShortLeaves(skeleton, width, height, distance, prunePx);
    }

    const sknwGraph = buildSknw(skeleton, width, height, {});
    const graph = new MultiGraph(sknwGraph);

    const nodes = [];
    for (let i = 0; i < sknwGraph.nodes.length; i++) {
      const [y, x] = sknwGraph.nodes[i].o;
      const degree = graph.degree(i);
      const kind = degree === 0 ? 'isolated' : degree === 1 ? 'endpoint'
        : degree >= 3 ? 'junction' : 'cycle_anchor';
      nodes.push({ id: i, x: pyRound2(x), y: pyRound2(y), degree, type: kind });
    }

    const edges = [];
    let eid = 0;
    for (const [u, v, key, edgeData] of graph.edges()) {
      const pts = edgeData.pts;                       // [ [row, col], ... ]
      const simple = pts.length > 2 ? approximatePolygon(pts, 0.65) : pts;
      const lengths = [0];
      for (let i = 1; i < pts.length; i++) {
        const dy = pts[i][0] - pts[i - 1][0], dx = pts[i][1] - pts[i - 1][1];
        lengths.push(lengths[i - 1] + Math.sqrt(dy * dy + dx * dx));
      }
      const total = lengths[lengths.length - 1];
      const positions = npArange(20, total - 8, 24);
      const samples = positions.map((t) => [
        pyRound2(npInterp(t, lengths, pts.map((p) => p[1]))),   // x
        pyRound2(npInterp(t, lengths, pts.map((p) => p[0]))),   // y
      ]);
      let widthSum = 0;
      const widths = new Float64Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const r = roundHalfEven(pts[i][0]), c = roundHalfEven(pts[i][1]);
        widths[i] = 2 * distance[r * width + c];
        widthSum += widths[i];
      }
      edges.push({
        id: eid++,
        source: u, target: v, key,
        length_px: npRound3(edgeData.weight),
        mean_width_px: npRound3(widthSum / pts.length),
        points_xy: pts.map((p) => [npRound2(p[1]), npRound2(p[0])]),
        display_points_xy: simple.map((p) => [npRound2(p[1]), npRound2(p[0])]),
        sample_points_xy: samples,
        width_samples_px: Array.from(widths, npRound2),
      });
    }

    let count = 0, sumX = 0, sumY = 0, minX = Infinity, maxX = -Infinity,
        minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) {
          count++; sumX += x; sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const centroid = count
      ? [npRound2(sumX / count), npRound2(sumY / count)] : null;
    const bboxCenter = count
      ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;

    const components = graph.numberConnectedComponents();
    const statistics = {
      nodes: nodes.length,
      edges: edges.length,
      components,
      endpoints: nodes.filter((n) => n.type === 'endpoint').length,
      junctions: nodes.filter((n) => n.type === 'junction').length,
      cycle_rank: edges.length - nodes.length + components,
    };

    const result = {
      schema_version: 1,
      coordinate_system: 'crop-local px; x right, y down',
      width, height, directed: false,
      interpretation: 'Geometric skeleton only; no stroke segmentation or stroke order.',
      parameters: {
        sigma,
        threshold_otsu: threshold,
        clean,
        min_component_area: clean ? minArea : 0,
        closing_radius: clean ? 1 : 0,
        max_hole_area: clean ? 48 : 0,
        max_prune_length: clean ? prunePx : 0,
      },
      centroid_xy: centroid,
      bbox_center_xy: bboxCenter,
      centroid_scope: 'all retained foreground, including any residual damage',
      nodes, edges, statistics,
    };
    return { result, mask, skeleton };
  }

  return {
    rgbaToGray, pilLuma,
    gaussianSmooth, otsuThreshold,
    labelComponents, removeSpecks, closingCross, fillSmallHoles,
    edt, zhangSkeletonize,
    buildSknw, MultiGraph, pruneShortLeaves, approximatePolygon,
    analyze,
  };
});
