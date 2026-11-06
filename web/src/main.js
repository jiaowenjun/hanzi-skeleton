import './style.css';
import * as HanziSkeleton from './pipeline.js';

  const $ = (id) => document.getElementById(id);
  const drop = $('drop'), demoBtn = $('demo-btn');
  const cropCard = $('crop-card'), cropCanvas = $('crop-canvas'), cropInfo = $('crop-info');
  const cropCtx = cropCanvas.getContext('2d');
  const runBtn = $('run-btn'), progress = $('progress');
  const resultCard = $('result-card'), stage = $('result-stage'), statsEl = $('stats');
  const viewSel = $('view'), legend = $('legend');

  const state = {
    source: null,        // HTMLImageElement or canvas of the loaded picture
    sourceW: 0, sourceH: 0,
    crop: null,          // {x, y, w, h} in source pixels, null = full image
    busy: false,
    output: null,        // { result, mask, skeleton, gray, width, height, imageDataUrl }
    cropDrag: null,
    invertTouched: false,
  };
  const MAX_SIDE = 1000;  // processing cap so parameters stay near their 700px calibration

  // Yield to the event loop so progress text paints; requestAnimationFrame
  // alone never fires in hidden tabs, so fall back to a plain timer.
  const frame = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => r())),
    new Promise((r) => setTimeout(r, 30)),
  ]);

  /* ---------------- input loading ---------------- */

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { alert('请选择图片文件'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); acceptImage(img); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('图片解码失败'); };
    img.src = url;
  }

  function acceptImage(source) {
    state.source = source;
    state.sourceW = source.naturalWidth || source.width;
    state.sourceH = source.naturalHeight || source.height;
    state.crop = null;
    state.invertTouched = false;
    guessInvert();
    cropCard.hidden = false;
    resultCard.hidden = true;
    drawCrop();
  }

  // Heuristic evaluated on the CURRENT crop region (a bright paper margin
  // around a dark rubbing panel would fool a whole-image guess): rubbings are
  // bright glyph on dark ground, so a dark ring around a brighter centre
  // means "no invert needed".
  function guessInvert() {
    if (!state.source || state.invertTouched) return;
    const r = state.crop || { x: 0, y: 0, w: state.sourceW, h: state.sourceH };
    const c = document.createElement('canvas');
    const s = Math.min(1, 160 / Math.max(r.w, r.h));
    c.width = Math.max(2, Math.round(r.w * s));
    c.height = Math.max(2, Math.round(r.h * s));
    const ctx = c.getContext('2d');
    ctx.drawImage(state.source, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
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
    $('opt-invert').checked = ring > cen;  // bright frame around darker glyph = black-on-white
  }

  // Procedural demo: bright thick strokes on dark ground with speckles,
  // so the page can be tried without redistributing the reference photos.
  function makeDemo() {
    const c = document.createElement('canvas');
    c.width = 720; c.height = 720;
    const ctx = c.getContext('2d');
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
    // 石花噪声 + 淡纹理
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    ctx.fillStyle = '#cfcabc';
    for (let i = 0; i < 260; i++) {
      const x = rnd() * 720, y = rnd() * 720, r = rnd() * 3.2;
      ctx.globalAlpha = 0.25 + 0.75 * rnd();
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const img = new Image();
    img.onload = () => acceptImage(img);
    img.src = c.toDataURL('image/png');
  }

  /* ---------------- crop selection ---------------- */

  function displayScale() { return cropCanvas.width / cropCanvas.clientWidth; }

  function drawCrop() {
    const maxW = Math.min(660, document.querySelector('main').clientWidth - 34);
    const scale = Math.min(1, maxW / state.sourceW, 520 / state.sourceH);
    cropCanvas.width = Math.round(state.sourceW * scale);
    cropCanvas.height = Math.round(state.sourceH * scale);
    cropCtx.drawImage(state.source, 0, 0, cropCanvas.width, cropCanvas.height);
    if (state.crop) {
      const s = cropCanvas.width / state.sourceW;
      cropCtx.save();
      cropCtx.fillStyle = 'rgba(0,0,0,.45)';
      cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
      cropCtx.drawImage(state.source,
        state.crop.x * s, state.crop.y * s, state.crop.w * s, state.crop.h * s,
        state.crop.x * s, state.crop.y * s, state.crop.w * s, state.crop.h * s);
      cropCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--blue');
      cropCtx.lineWidth = 2;
      cropCtx.strokeRect(state.crop.x * s, state.crop.y * s, state.crop.w * s, state.crop.h * s);
      cropCtx.restore();
    }
    updateCropInfo();
  }

  function updateCropInfo() {
    const w = state.crop ? state.crop.w : state.sourceW;
    const h = state.crop ? state.crop.h : state.sourceH;
    const note = Math.max(w, h) > MAX_SIDE
      ? `（超过 ${MAX_SIDE}px，将等比缩放后处理）` : '';
    cropInfo.textContent = `处理区域 ${Math.round(w)}×${Math.round(h)} px${note}`;
  }

  function canvasPoint(ev) {
    const r = cropCanvas.getBoundingClientRect();
    const px = ev.clientX !== undefined ? ev.clientX : (ev.touches && ev.touches[0].clientX);
    const py = ev.clientY !== undefined ? ev.clientY : (ev.touches && ev.touches[0].clientY);
    return {
      x: Math.min(state.sourceW - 1, Math.max(0, (px - r.left) * state.sourceW / r.width)),
      y: Math.min(state.sourceH - 1, Math.max(0, (py - r.top) * state.sourceH / r.height)),
    };
  }

  function cropStart(ev) { state.cropDrag = { a: canvasPoint(ev) }; ev.preventDefault(); }
  function cropMove(ev) {
    if (!state.cropDrag) return;
    const b = canvasPoint(ev), a = state.cropDrag.a;
    state.crop = {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    };
    drawCrop();
    ev.preventDefault();
  }
  function cropEnd() {
    if (state.cropDrag && state.crop && (state.crop.w < 8 || state.crop.h < 8)) state.crop = null;
    state.cropDrag = null;
    drawCrop();
    guessInvert();   // the crop region decides bright-on-dark vs the reverse
  }
  cropCanvas.addEventListener('mousedown', cropStart);
  cropCanvas.addEventListener('mousemove', cropMove);
  window.addEventListener('mouseup', cropEnd);
  cropCanvas.addEventListener('touchstart', cropStart, { passive: false });
  cropCanvas.addEventListener('touchmove', cropMove, { passive: false });
  cropCanvas.addEventListener('touchend', cropEnd);
  $('crop-reset').addEventListener('click', () => { state.crop = null; drawCrop(); guessInvert(); });
  $('opt-invert').addEventListener('change', () => { state.invertTouched = true; });

  /* ---------------- pipeline run ---------------- */

  async function run() {
    if (state.busy) return;
    state.busy = true;
    runBtn.disabled = true;
    try {
      const clean = $('opt-clean').value === 'clean';
      const minArea = Math.max(0, parseInt($('opt-min-area').value, 10) || 0);
      const prunePx = Math.max(0, parseFloat($('opt-prune').value) || 0);
      const invert = $('opt-invert').checked;

      const region = state.crop || { x: 0, y: 0, w: state.sourceW, h: state.sourceH };
      const scale = Math.min(1, MAX_SIDE / Math.max(region.w, region.h));
      const W = Math.max(8, Math.round(region.w * scale));
      const Hh = Math.max(8, Math.round(region.h * scale));

      progress.textContent = '准备输入…';
      await frame();
      const c = document.createElement('canvas');
      c.width = W; c.height = Hh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.source, region.x, region.y, region.w, region.h, 0, 0, W, Hh);
      const rgba = ctx.getImageData(0, 0, W, Hh).data;
      let gray = HanziSkeleton.rgbaToGray(rgba, W, Hh);
      if (invert) {
        const g = new Uint8Array(gray.length);
        for (let i = 0; i < gray.length; i++) g[i] = 255 - gray[i];
        gray = g;
      }

      progress.textContent = '高斯平滑与 Otsu 二值化…';
      await frame();
      const t0 = performance.now();
      const { result, mask, skeleton } = HanziSkeleton.analyze(gray, W, Hh,
        { clean, minArea, prunePx, sigma: 1.0 });
      const ms = Math.round(performance.now() - t0);

      state.output = {
        result, mask, skeleton, width: W, height: Hh,
        imageDataUrl: c.toDataURL('image/jpeg', 0.88),
      };
      progress.textContent = `完成，用时 ${ms} ms（本页内计算，未上传）`;
      resultCard.hidden = false;
      renderResult();
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error(err);
      progress.textContent = '处理失败：' + err.message;
    } finally {
      state.busy = false;
      runBtn.disabled = false;
    }
  }

  /* ---------------- result rendering ---------------- */

  function binaryDataUrl(bits) {
    const { width, height } = state.output;
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < bits.length; i++) {
      const v = bits[i] ? 255 : 0;
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function lazyBinary(key, bits) {
    if (!state[key]) state[key] = binaryDataUrl(bits);
    return state[key];
  }

  function renderResult() {
    const o = state.output;
    if (!o) return;
    const mode = viewSel.value;
    const { result, width, height } = o;
    let svg = `<svg id="result-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `role="img" aria-label="骨架叠加结果"><title>几何骨架，不代表真实笔顺</title>` +
      `<rect width="100%" height="100%" fill="var(--background)"/>`;
    if (mode === 'image') {
      svg += `<image href="${o.imageDataUrl}" width="${width}" height="${height}"/>`;
    } else if (mode === 'mask') {
      svg += `<image href="${lazyBinary('_maskUrl', o.mask)}" width="${width}" height="${height}"/>`;
    } else if (mode === 'skeleton') {
      svg += `<image href="${lazyBinary('_skelUrl', o.skeleton)}" width="${width}" height="${height}"/>`;
    } else {
      svg += `<image href="${o.imageDataUrl}" width="${width}" height="${height}" opacity="0.42"/>`;
      for (const e of result.edges) {
        svg += `<polyline points="${e.display_points_xy.map((p) => p.join(',')).join(' ')}" ` +
          `fill="none" stroke="var(--blue)" stroke-width="1.7" stroke-linejoin="round"/>`;
        for (const [x, y] of e.sample_points_xy) {
          svg += `<circle cx="${x}" cy="${y}" r="2.9" fill="var(--orange)" stroke="var(--background)" stroke-width="1"/>`;
        }
      }
      for (const n of result.nodes) {
        if (n.type === 'junction') {
          svg += `<rect x="${n.x - 3.4}" y="${n.y - 3.4}" width="6.8" height="6.8" rx="1" ` +
            `fill="var(--red)" stroke="var(--background)" stroke-width="1"/>`;
        } else {
          svg += `<circle cx="${n.x}" cy="${n.y}" r="${n.type === 'isolated' ? 2.3 : 3.5}" ` +
            `fill="${n.type === 'endpoint' ? 'var(--green)' : n.type === 'isolated' ? 'var(--gray)' : 'var(--orange)'}" ` +
            `stroke="var(--background)" stroke-width="1"/>`;
        }
      }
      if (result.centroid_xy) {
        const [x, y] = result.centroid_xy;
        svg += `<path d="M0 ${y}H${width} M${x} 0V${height}" fill="none" stroke="var(--purple)" ` +
          `stroke-width="1.2" stroke-dasharray="8 6"/>` +
          `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="var(--purple)" stroke-width="1.7"/>`;
      }
    }
    svg += '</svg>';
    stage.innerHTML = svg;
    legend.hidden = mode !== 'overlay';
    const s = result.statistics;
    statsEl.textContent =
      `${s.nodes} 个几何节点 · ${s.edges} 条骨架边 · ${s.components} 个连通分量 · ` +
      `Otsu 阈值 ${result.parameters.threshold_otsu.toFixed(3)}（均非笔画数量）`;
  }

  /* ---------------- exports ---------------- */

  function overlaySvgText() {
    const o = state.output;
    const { result, width, height } = o;
    const colors = { endpoint: '#16a477', junction: '#dc285e', isolated: '#77818c',
                     cycle_anchor: '#d78a12', sample: '#e69a27', edge: '#2474b8', center: '#9c38b7' };
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
      '<title>Computed geometric skeleton; not inferred stroke order</title>',
      `<rect width="${width}" height="${height}" fill="white"/>`,
      `<image width="${width}" height="${height}" opacity="0.3" href="${o.imageDataUrl}"/>`];
    for (const e of result.edges) {
      const pts = e.display_points_xy.map((p) => p.join(',')).join(' ');
      out.push(`<polyline points="${pts}" fill="none" stroke="${colors.edge}" stroke-width="1.4"/>`);
      for (const [x, y] of e.sample_points_xy) {
        out.push(`<circle cx="${x}" cy="${y}" r="2.8" fill="${colors.sample}" stroke="white"/>`);
      }
    }
    for (const n of result.nodes) {
      out.push(`<circle cx="${n.x}" cy="${n.y}" r="3.5" fill="${colors[n.type]}" stroke="white"/>`);
    }
    if (result.centroid_xy) {
      const [x, y] = result.centroid_xy;
      out.push(`<path d="M0 ${y}H${width} M${x} 0V${height}" stroke="${colors.center}" stroke-dasharray="8 6"/>`);
      out.push(`<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${colors.center}"/>`);
    }
    out.push('</svg>');
    return out.join('\n');
  }

  function download(name, mime, data) {
    const a = document.createElement('a');
    if (typeof data === 'string' && !data.startsWith('data:')) {
      data = URL.createObjectURL(new Blob([data], { type: mime }));
    }
    a.href = data;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.querySelectorAll('[data-dl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const o = state.output;
      if (!o) return;
      const name = btn.dataset.dl;
      if (name === 'graph.json') {
        download(name, 'application/json',
          JSON.stringify(o.result, null, 2));
      } else if (name === 'overlay.svg') {
        download(name, 'image/svg+xml', overlaySvgText());
      } else if (name === 'mask.png') {
        download(name, 'image/png', lazyBinary('_maskUrl', o.mask));
      } else if (name === 'skeleton.png') {
        download(name, 'image/png', lazyBinary('_skelUrl', o.skeleton));
      }
    });
  });

  /* ---------------- wiring ---------------- */

  drop.addEventListener('click', (ev) => {
    if (ev.target === demoBtn) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => loadFile(input.files[0]);
    input.click();
  });
  drop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') drop.click();
  });
  ['dragenter', 'dragover'].forEach((t) =>
    drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => loadFile(ev.dataTransfer.files[0]));
  window.addEventListener('paste', (ev) => {
    const item = [...(ev.clipboardData ? ev.clipboardData.items : [])]
      .find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
  demoBtn.addEventListener('click', (ev) => { ev.stopPropagation(); makeDemo(); });
  runBtn.addEventListener('click', run);
  viewSel.addEventListener('change', renderResult);
