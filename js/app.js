/* AstroStackPro page logic: files, presets, worker pool, pipeline, viewer, export. */
(() => {
  'use strict';
  const C = window.AstroCore;
  const Post = window.AstroPost;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /Android|Mobi/i.test(navigator.userAgent);
  const HW = navigator.hardwareConcurrency || 4;

  // ------------------------------------------------------------------ presets

  const PRESETS = {
    quick: { method: 'mean', kappa: '2.5', align: 'similarity', scale: '0.5', analysis: '0', keep: '1', interp: 'bilinear', maxStars: '40' },
    balanced: { method: 'sigma', kappa: '2.5', align: 'similarity', scale: '1', analysis: '1', keep: '1', interp: 'bilinear', maxStars: '80' },
    best: { method: 'winsor', kappa: '2.5', align: 'similarity', scale: '1', analysis: '1', keep: '0.9', interp: 'bicubic', maxStars: '150' },
    trails: { method: 'max', kappa: '2.5', align: 'none', scale: '1', analysis: '0', keep: '1', interp: 'bilinear', maxStars: '40' },
  };
  const METHOD_NAMES = {
    mean: 'average', weighted: 'weighted average', median: 'median',
    sigma: 'sigma clipping', winsor: 'winsorized sigma clipping', max: 'maximum',
  };
  const STREAMING = new Set(['mean', 'weighted', 'max']);
  const ANALYSIS_SIZE = { 40: 1000, 80: 1600, 150: 2400 };
  const TRIANGLE_STARS = { 40: 25, 80: 30, 150: 40 };

  const state = {
    frames: [],
    probe: null,
    quotaFree: 0,
    preset: 'balanced',
    settings: { ...PRESETS.balanced, workers: 'auto', memory: 'auto' },
    running: false,
    job: null,
    result: null,
    post: Post.defaults(),
    view: { zoom: 'fit', cx: 0, cy: 0, compare: false },
    accMsPerPx: 2e-6,
  };
  let uid = 1;

  // ------------------------------------------------------------------ small helpers

  function fmtDur(ms, approx) {
    const s = ms / 1000;
    let out;
    if (s < 1) out = approx ? '1 s' : 'under 1 s';
    else if (s < 60) out = `${Math.round(s)} s`;
    else if (s < 600) { const m = Math.floor(s / 60), r = Math.round(s % 60); out = r ? `${m} min ${r} s` : `${m} min`; }
    else if (s < 3600) out = `${Math.round(s / 60)} min`;
    else out = `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
    return out;
  }
  const fmtMB = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const kindError = (kind, message) => Object.assign(new Error(message || kind), { kind });

  function setNotice(html) {
    const n = $('#notice');
    if (!html) { n.hidden = true; n.innerHTML = ''; return; }
    n.innerHTML = html;
    n.hidden = false;
  }

  async function decodeInMain(file) {
    try { return await createImageBitmap(file); } catch (e) { /* try an <img> */ }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ------------------------------------------------------------------ worker pool

  let workerBlobURL = null;
  function workerURL() {
    if (!workerBlobURL) {
      const src = `${window.AstroCoreInit.toString()}\nAstroCoreInit(self);\n${window.AstroWorkerMain.toString()}\nAstroWorkerMain();\n`;
      workerBlobURL = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return workerBlobURL;
  }

  class Pool {
    constructor(n) {
      this.workers = Array.from({ length: n }, () => new Worker(workerURL()));
      this.dead = false;
    }
    call(i, msg, transfer) {
      const w = this.workers[i];
      return new Promise((resolve, reject) => {
        if (this.dead) { reject(kindError('cancel')); return; }
        w._reject = reject;
        w.onmessage = (e) => {
          w._reject = null;
          const d = e.data;
          if (d.ok) resolve(d); else reject(kindError(d.kind, d.error));
        };
        w.onerror = (e) => {
          w._reject = null;
          e.preventDefault();
          reject(kindError('crash', e.message || 'A background worker crashed (probably out of memory).'));
        };
        w.postMessage(msg, transfer || []);
      });
    }
    async each(items, fn) {
      let next = 0;
      await Promise.all(this.workers.map(async (_, wi) => {
        while (next < items.length) {
          if (this.dead) throw kindError('cancel');
          const item = items[next++];
          await fn(item, wi);
        }
      }));
    }
    terminate() {
      this.dead = true;
      for (const w of this.workers) {
        w.terminate();
        if (w._reject) w._reject(kindError('cancel'));
      }
    }
  }

  /** Sends a per-photo job, decoding on the page instead when the worker can't (e.g. HEIC). */
  async function callFrame(pool, wi, frame, msg) {
    const m = { ...msg };
    const transfer = [];
    if (frame.mainDecode) {
      const bmp = await decodeInMain(frame.file);
      if (!bmp) throw kindError('decode', 'This browser cannot read this file');
      m.bitmap = bmp;
      transfer.push(bmp);
    } else {
      m.file = frame.file;
    }
    try {
      return await pool.call(wi, m, transfer);
    } catch (e) {
      if (e.kind === 'decode' && !frame.mainDecode) {
        frame.mainDecode = true;
        return callFrame(pool, wi, frame, msg);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ settings

  function memoryBudget(setting) {
    if (setting !== 'auto') return Number(setting) * 1048576;
    const dm = navigator.deviceMemory;
    const mb = dm ? Math.min(4096, dm * 1024 * 0.4) : isMobile ? 600 : 1600;
    return mb * 1048576;
  }

  function resolve(settings) {
    const p = state.probe;
    const s = { ...settings };
    let scale = Number(s.scale);
    if (isIOS) scale = Math.min(scale, Math.sqrt(16e6 / (p.W0 * p.H0))); // Safari canvas limit
    s.scaleUsed = scale;
    s.Ww = Math.max(16, Math.round(p.W0 * scale));
    s.Hw = Math.max(16, Math.round(p.H0 * scale));
    s.kappa = Number(s.kappa);
    s.keep = Number(s.keep);
    s.analysis = s.analysis === '1';
    s.maxStars = Number(s.maxStars);
    s.aMax = ANALYSIS_SIZE[s.maxStars] || 1600;
    s.nUse = TRIANGLE_STARS[s.maxStars] || 30;
    s.streaming = STREAMING.has(s.method);
    s.budget = memoryBudget(s.memory);
    const P = s.Ww * s.Hw;
    const perWorker = p.W0 * p.H0 * 4 + P * 14 + 40e6;
    const reserve = P * 20;
    const autoW = Math.max(1, Math.min(8, HW - 1));
    const fit = Math.max(1, Math.floor((s.budget - reserve) / perWorker));
    s.workers = s.workers === 'auto' ? Math.max(1, Math.min(autoW, fit)) : Number(s.workers);
    const aRatio = Math.max(1, Math.max(s.Ww, s.Hw) / s.aMax);
    s.tol = Math.max(2, 1.6 * aRatio, 0.0015 * Math.max(s.Ww, s.Hw));
    return s;
  }

  function cacheFits(s, n) {
    return !!(state.probe && state.probe.opfs) && n * s.Ww * s.Hw * 6 * 1.15 < state.quotaFree;
  }

  /** Estimated duration in ms, split into phases, from the speed test on the first photo. */
  function estimate(settings, n) {
    const p = state.probe;
    const s = resolve(settings);
    const P = s.Ww * s.Hw;
    const area = P / (p.W0 * p.H0);
    const W = s.workers;
    const tDec = p.tDecode;
    const tDraw = p.tDraw * Math.max(area, 0.35);
    const tWarp = (s.interp === 'bicubic' ? p.tWarpCubic : p.tWarp) * area;
    const tAna = p.tAnalyse * Math.pow(s.aMax / 1600, 2);
    const ph = { analysis: 0, warp: 0, combine: 0 };
    if (s.analysis) ph.analysis = (n * (tDec + tAna)) / W;
    const perFrame = tDec + tDraw + tWarp + (s.analysis ? 0 : tAna);
    if (s.streaming) {
      ph.warp = Math.max((n * perFrame) / W, n * P * state.accMsPerPx);
    } else if (cacheFits(s, n)) {
      const bytes = n * P * 6;
      ph.warp = (n * perFrame) / W + (bytes / 350e6) * 1000;
      ph.combine = (n * P * 3 * p.reduce[s.method] * 1e-6) / W + (bytes / 700e6) * 1000;
    } else {
      const strips = Math.max(W, Math.ceil((n * P * 6 * W) / (s.budget * 0.45)));
      ph.combine = (strips * n * (tDec + tDraw) + n * tWarp + n * P * 3 * p.reduce[s.method] * 1e-6) / W;
      ph.warp = s.analysis ? 0 : (n * (tDec + tAna)) / W; // one-pass mode still aligns every photo first
    }
    const fixed = 600 + P * 4e-5;
    return { total: ph.analysis + ph.warp + ph.combine + fixed, phases: ph, fixed };
  }

  function usableFrames() {
    return state.frames.filter((f) => !f.excluded && !f.unreadable);
  }

  function matchPreset() {
    for (const [name, p] of Object.entries(PRESETS)) {
      if (Object.keys(p).every((k) => String(state.settings[k]) === p[k])) return name;
    }
    return null;
  }

  function syncSettingsUI() {
    for (const el of $$('[data-setting]')) el.value = String(state.settings[el.dataset.setting]);
    state.preset = matchPreset();
    for (const b of $$('.preset')) b.setAttribute('aria-checked', String(b.dataset.preset === state.preset));
    $('#customState').textContent = state.preset ? '' : '(custom settings)';
    const robust = ['sigma', 'winsor'].includes(state.settings.method);
    $('[data-show="robust"]').hidden = !robust;
    $('[data-show="analysis"]').hidden = state.settings.analysis !== '1';
    updateEta();
  }

  function updateEta() {
    const n = usableFrames().length;
    const ready = state.probe && n >= 2;
    for (const el of $$('[data-eta]')) {
      if (!ready) { el.textContent = '–'; continue; }
      const est = estimate({ ...state.settings, ...PRESETS[el.dataset.eta] }, n);
      el.innerHTML = `≈ ${fmtDur(est.total, true)}`;
    }
    const btn = $('#stackBtn');
    if (!ready) {
      btn.disabled = true;
      if (!probing) btn.textContent = state.frames.length && !state.probe ? 'No readable photos yet'
        : n === 1 ? 'Add at least one more photo' : 'Stack photos';
      return;
    }
    btn.disabled = state.running;
    const est = estimate(state.settings, n);
    btn.textContent = `${state.result ? 'Stack again' : `Stack ${n} photos`} (about ${fmtDur(est.total, true)})`;
  }

  function initWorkerOptions() {
    const sel = $('[data-setting="workers"]');
    const autoW = Math.max(1, Math.min(8, HW - 1));
    sel.innerHTML = `<option value="auto">Automatic (up to ${autoW})</option>` +
      Array.from({ length: Math.min(16, HW) }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  }

  // ------------------------------------------------------------------ files

  const IMG_EXT = /\.(jpe?g|png|webp|avif|heic|heif|tiff?|gif|bmp)$/i;

  function addFiles(list) {
    const known = new Set(state.frames.map((f) => `${f.file.name}|${f.file.size}|${f.file.lastModified}`));
    let added = 0;
    for (const file of list) {
      if (!(/^image\//.test(file.type) || IMG_EXT.test(file.name))) continue;
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (known.has(key)) continue;
      known.add(key);
      state.frames.push({ id: uid++, file, name: file.name, thumb: null, ana: null, excluded: false });
      added++;
    }
    if (!added) return;
    state.frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    renderPhotos();
    renderStrip();
    if (!state.probe) probe();
    else updateEta();
  }

  function clearAll() {
    if (state.running) return;
    state.frames = [];
    state.probe = null;
    state.result = null;
    setNotice('');
    $('#view').hidden = true;
    $('#drop').hidden = false;
    $('#viewerBar').hidden = true;
    $('#stageHint').hidden = true;
    $('#stepFinish').hidden = true;
    $('#stepRun').classList.remove('is-done');
    renderPhotos();
    renderStrip();
    updateEta();
  }

  /** Measures decode/warp/combine speed on the first readable photo. */
  let probing = false;
  async function probe() {
    if (probing) return;
    probing = true;
    const btn = $('#stackBtn');
    btn.disabled = true;
    btn.textContent = 'Reading the first photo…';
    let pool = null, failure = null;
    try {
      pool = new Pool(1);
      for (const frame of state.frames) {
        if (frame.unreadable) continue;
        try {
          const r = await Promise.race([
            callFrame(pool, 0, frame, { type: 'probe' }),
            new Promise((_, rej) => setTimeout(() => rej(kindError('timeout', 'reading the photo took too long')), 90000)),
          ]);
          state.probe = r;
          break;
        } catch (e) {
          if (e.kind !== 'decode') throw e;
          frame.unreadable = true;
        }
      }
    } catch (e) {
      console.error(e);
      failure = e;
    } finally {
      if (pool) pool.terminate();
      probing = false;
    }
    try {
      const est = await navigator.storage.estimate();
      state.quotaFree = (est.quota || 0) - (est.usage || 0);
    } catch (e) { state.quotaFree = 0; }

    const p = state.probe;
    const unreadable = state.frames.filter((f) => f.unreadable).length;
    const notes = [];
    if (failure) {
      notes.push(`The photos couldn't be prepared: ${failure.message}. Try a recent Chrome, Edge, Safari or Firefox.`);
    } else if (!p && unreadable) {
      notes.push(`This browser can't read ${unreadable === 1 ? 'this file' : `any of these ${unreadable} files`}. iPhone HEIC photos only open in Safari. Elsewhere, export them as JPEG, or set Camera → Formats → Most Compatible on the iPhone. RAW and FITS files need converting to JPEG first.`);
    } else if (unreadable) {
      notes.push(`${unreadable} file${unreadable > 1 ? 's' : ''} can't be read by this browser and will be skipped. iPhone HEIC photos only open in Safari; elsewhere, export them as JPEG.`);
    }
    if (p && p.nStars < 8) notes.push(`Only ${p.nStars} star${p.nStars === 1 ? '' : 's'} found in the first photo. Alignment needs several clear stars. If the photos come from a tracked mount or a fixed tripod with lots of foreground, set Alignment to None.`);
    setNotice(notes.join('<br><br>'));
    if (p && !state.result) showImage(p.preview);
    renderPhotos();
    updateEta();
  }

  function renderPhotos() {
    const n = state.frames.length;
    const el = $('#photosSummary');
    $('#photosActions').hidden = n === 0;
    $('#stepPhotos').classList.toggle('is-done', n >= 2);
    if (!n) { el.textContent = 'No photos yet.'; return; }
    const bytes = state.frames.reduce((s, f) => s + f.file.size, 0);
    const excluded = state.frames.filter((f) => f.excluded).length;
    const size = state.probe ? `, ${state.probe.W0} × ${state.probe.H0} px` : '';
    el.innerHTML = `<strong>${n} photo${n > 1 ? 's' : ''}</strong> (${fmtMB(bytes)}${size})` +
      (excluded ? `, ${excluded} left out` : '') + '.';
  }

  // ------------------------------------------------------------------ filmstrip

  const frameEls = new Map();

  function renderStrip() {
    const strip = $('#strip');
    strip.innerHTML = '';
    frameEls.clear();
    $('#stripWrap').hidden = state.frames.length === 0;
    $('#stripTitle').textContent = `${state.frames.length} frames`;
    state.frames.forEach((f, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'frame';
      b.innerHTML = `<canvas width="76" height="57"></canvas><span class="frame-n">${i + 1}</span>`;
      b.addEventListener('click', () => {
        if (state.running) return;
        f.excluded = !f.excluded;
        updateFrameEl(f);
        renderPhotos();
        updateEta();
      });
      li.appendChild(b);
      strip.appendChild(li);
      frameEls.set(f.id, b);
      updateFrameEl(f);
    });
  }

  function updateFrameEl(f) {
    const b = frameEls.get(f.id);
    if (!b) return;
    if (f.thumb && !b._drawn) {
      const c = b.querySelector('canvas');
      const ctx = c.getContext('2d');
      const s = Math.max(c.width / f.thumb.width, c.height / f.thumb.height);
      const w = f.thumb.width * s, h = f.thumb.height * s;
      ctx.drawImage(f.thumb, (c.width - w) / 2, (c.height - h) / 2, w, h);
      b._drawn = true;
    }
    b.classList.toggle('is-ref', !!f.isRef);
    b.classList.toggle('is-excluded', !!f.excluded);
    b.classList.toggle('is-rejected', !f.excluded && !!f.rejected);
    b.title = `${f.name}${f.excluded ? '. Left out' : ''}${f.rejected ? `. Skipped: ${f.rejected}` : ''}${f.isRef ? '. Reference frame' : ''}`;
  }

  // ------------------------------------------------------------------ progress

  const PHASE_LABEL = { analysis: 'Checking photos', warp: 'Aligning and stacking', combine: 'Combining', finish: 'Finishing' };

  function setPhase(job, phase, total) {
    const now = performance.now();
    if (job.phase && job.phaseStart) job.timings[job.phase] = (job.timings[job.phase] || 0) + now - job.phaseStart;
    job.phaseStart = now;
    job.phase = phase;
    job.done = 0;
    job.total = total;
    renderProgress(job);
  }

  function tick(job) {
    job.done++;
    const now = performance.now();
    if (now - (job.lastDraw || 0) > 120 || job.done === job.total) {
      job.lastDraw = now;
      renderProgress(job);
    }
  }

  function renderProgress(job) {
    const est = job.est.phases;
    const order = ['analysis', 'warp', 'combine'];
    const total = est.analysis + est.warp + est.combine || 1;
    let before = 0;
    for (const p of order) { if (p === job.phase) break; before += est[p]; }
    const frac = job.phase === 'finish' ? 1 : Math.min(1, (before + est[job.phase] * (job.total ? job.done / job.total : 0)) / total);
    $('#progressFill').style.width = `${(frac * 100).toFixed(1)}%`;
    const label = PHASE_LABEL[job.phase] || 'Working';
    $('#progressPhase').textContent = job.total ? `${label} ${job.done} of ${job.total}` : `${label}…`;
    const elapsed = performance.now() - job.t0;
    let left = '';
    if (frac > 0.04) left = `, about ${fmtDur((elapsed * (1 - frac)) / frac, true)} left`;
    else left = `, about ${fmtDur(Math.max(0, job.est.total - elapsed), true)} left`;
    $('#progressTime').textContent = `${fmtDur(elapsed)} elapsed${left}`;
  }

  // ------------------------------------------------------------------ accumulation (streaming methods)

  function makeAcc(method, P) {
    const acc = { method, P, cnt: new Uint16Array(P) };
    if (method === 'max') acc.mx = new Uint16Array(P * 3);
    else {
      acc.sum = new Float32Array(P * 3);
      if (method === 'weighted') acc.wsum = new Float32Array(P);
    }
    return acc;
  }

  function accumulate(acc, d, w) {
    const P = acc.P, cnt = acc.cnt, INV = C.INVALID;
    if (acc.mx) {
      const mx = acc.mx;
      for (let p = 0, i = 0; p < P; p++, i += 3) {
        if (d[i] === INV) continue;
        cnt[p]++;
        if (d[i] > mx[i]) mx[i] = d[i];
        if (d[i + 1] > mx[i + 1]) mx[i + 1] = d[i + 1];
        if (d[i + 2] > mx[i + 2]) mx[i + 2] = d[i + 2];
      }
    } else if (acc.wsum) {
      const sum = acc.sum, ws = acc.wsum;
      for (let p = 0, i = 0; p < P; p++, i += 3) {
        if (d[i] === INV) continue;
        cnt[p]++; ws[p] += w;
        sum[i] += w * d[i]; sum[i + 1] += w * d[i + 1]; sum[i + 2] += w * d[i + 2];
      }
    } else {
      const sum = acc.sum;
      for (let p = 0, i = 0; p < P; p++, i += 3) {
        if (d[i] === INV) continue;
        cnt[p]++;
        sum[i] += d[i]; sum[i + 1] += d[i + 1]; sum[i + 2] += d[i + 2];
      }
    }
  }

  function finishAcc(acc) {
    const P = acc.P, cnt = acc.cnt, k = 1 / C.MAXV;
    if (acc.mx) {
      const out = new Float32Array(P * 3);
      for (let i = 0; i < P * 3; i++) out[i] = acc.mx[i] * k;
      return { out, cnt };
    }
    const out = acc.sum;
    for (let p = 0, i = 0; p < P; p++, i += 3) {
      const d = acc.wsum ? acc.wsum[p] : cnt[p];
      const f = d > 0 ? k / d : 0;
      out[i] *= f; out[i + 1] *= f; out[i + 2] *= f;
    }
    return { out, cnt };
  }

  function benchAccumulate() {
    const P = 400000;
    const acc = makeAcc('mean', P);
    const d = new Uint16Array(P * 3);
    for (let i = 0; i < d.length; i++) d[i] = (i * 7919) & 0x7fff;
    const t = performance.now();
    accumulate(acc, d, 1);
    accumulate(acc, d, 1);
    state.accMsPerPx = Math.max(1e-7, (performance.now() - t) / (2 * P));
  }

  /** Point-sampled preview of a partially built stack. */
  function livePreview(getRGB, W, H) {
    const max = 1100;
    const step = Math.max(1, Math.ceil(Math.max(W, H) / max));
    const pw = Math.floor(W / step), ph = Math.floor(H / step);
    const data = new Float32Array(pw * ph * 3);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) getRGB((y * step) * W + x * step, data, (y * pw + x) * 3);
    const canvas = $('#view');
    canvas.width = pw; canvas.height = ph;
    const img = canvas.getContext('2d').createImageData(pw, ph);
    Post.render(data, pw, ph, 0, 0, step, W, H, Post.defaults(), null, img.data);
    canvas.getContext('2d').putImageData(img, 0, 0);
    canvas.hidden = false;
    $('#drop').hidden = true;
  }

  function maybeLive(job, fn) {
    const now = performance.now();
    if (now - (job.lastLive || 0) < 700) return;
    job.lastLive = now;
    fn();
  }

  // ------------------------------------------------------------------ disk cache

  async function clearCache() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('eas-cache', { recursive: true });
    } catch (e) { /* nothing cached */ }
  }

  async function readCached(id) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('eas-cache');
    const file = await (await dir.getFileHandle(`f${id}.bin`)).getFile();
    return new Uint16Array(await file.arrayBuffer());
  }

  // ------------------------------------------------------------------ pipeline

  function skip(frame, reason, skipped) {
    frame.rejected = reason;
    skipped.push({ frame, reason });
    updateFrameEl(frame);
  }

  function reasonFor(e) {
    if (e.kind === 'decode') return 'this browser cannot read the file';
    if (e.kind === 'size') return `different image size (${e.message.replace(/^\D+/, '').replace(/\)$/, '')})`;
    if (e.kind === 'align') return 'its stars did not match the reference';
    return null;
  }

  async function analysisPass(job, pool, s, frames, skipped) {
    setPhase(job, 'analysis', frames.length);
    const key = `${s.Ww}x${s.Hw}:${s.aMax}:${s.maxStars}`;
    await pool.each(frames, async (f, wi) => {
      if (f.ana && f.anaKey === key) { tick(job); return; }
      try {
        const r = await callFrame(pool, wi, f, {
          type: 'analyse', W0: state.probe.W0, H0: state.probe.H0, Ww: s.Ww, Hw: s.Hw, aMax: s.aMax, maxStars: s.maxStars,
        });
        f.ana = { stars: r.stars, nStars: r.nStars, fwhm: r.fwhm, bg: r.bg, noise: r.noise };
        f.anaKey = key;
        if (!f.thumb) { f.thumb = r.thumb; updateFrameEl(f); } else r.thumb.close();
      } catch (e) {
        const why = reasonFor(e);
        if (!why) throw e;
        skip(f, why, skipped);
      }
      tick(job);
    });

    const ok = frames.filter((f) => !f.rejected && f.ana && f.anaKey === key);
    if (!ok.length) throw new Error('None of the photos could be read.');
    for (const f of ok) f.score = Math.sqrt(f.ana.nStars + 1) / Math.max(0.7, f.ana.fwhm || 3);
    const ref = ok.reduce((a, b) => (b.score > a.score ? b : a));
    let align = s.align;
    if (align !== 'none' && ref.ana.stars.length < 3) {
      align = 'none';
      job.notes.push('Too few stars to align, so the photos were stacked as they are.');
    }
    const aligned = [];
    let i = 0;
    for (const f of ok) {
      if (f === ref) f.m = [1, 0, 0, 0, 1, 0];
      else {
        const r = C.align(ref.ana.stars, f.ana.stars, align, s.tol, { nUse: s.nUse });
        if (!r) { skip(f, 'its stars did not match the reference', skipped); continue; }
        f.m = r.m;
      }
      f.inv = C.invertAffine(f.m);
      aligned.push(f);
      if (++i % 25 === 0) await nextFrame();
    }
    const byScore = aligned.slice().sort((a, b) => b.score - a.score);
    const keepN = Math.max(1, Math.round(aligned.length * s.keep));
    const keepSet = new Set(byScore.slice(0, keepN));
    keepSet.add(ref);
    for (const f of aligned) if (!keepSet.has(f)) skip(f, 'less sharp than the others', skipped);
    const used = aligned.filter((f) => keepSet.has(f));
    const scores = new Float32Array(used.map((f) => f.score));
    const med = C.median(scores.slice(), scores.length) || 1;
    const weights = new Map(used.map((f) => [f, s.method === 'weighted' ? Math.min(3, Math.max(0.25, f.score / med)) : 1]));
    return { ref, used, weights };
  }

  async function reducePass(job, pool, s, used, useCache) {
    const n = used.length, W = s.Ww, H = s.Hw;
    if (!useCache && used.some((f) => f.mainDecode)) {
      throw new Error('This browser can only read these files on the page itself. Choose Average or Maximum as the stacking method, or use JPEG files.');
    }
    const out = new Float32Array(W * H * 3), cnt = new Uint16Array(W * H);
    const perWorker = (s.budget * 0.45) / s.workers;
    let rows = Math.max(1, Math.min(H, Math.floor(perWorker / (n * W * 6 + W * 14))));
    if (useCache) rows = Math.min(rows, Math.max(8, Math.ceil(H / (s.workers * 4))));
    const strips = [];
    for (let y = 0; y < H; y += rows) strips.push({ y0: y, y1: Math.min(H, y + rows) });
    setPhase(job, 'combine', strips.length);
    const ids = used.map((f) => f.id);
    const files = used.map((f) => f.file);
    const invs = used.map((f) => f.inv);
    await pool.each(strips, async (st, wi) => {
      const msg = useCache
        ? { type: 'reduceCache', ids, y0: st.y0, y1: st.y1, W, method: s.method, kappa: s.kappa }
        : { type: 'reduceDecode', files, invs, y0: st.y0, y1: st.y1, Ww: W, Hw: H, interp: s.interp, method: s.method, kappa: s.kappa };
      const r = await pool.call(wi, msg);
      out.set(r.out, st.y0 * W * 3);
      cnt.set(r.cnt, st.y0 * W);
      tick(job);
      maybeLive(job, () => livePreview((p, d, o) => { d[o] = out[p * 3]; d[o + 1] = out[p * 3 + 1]; d[o + 2] = out[p * 3 + 2]; }, W, H));
    });
    return { out, cnt };
  }

  async function run() {
    if (state.running || !state.probe) return;
    const frames = usableFrames();
    if (frames.length < 2) return;
    const s = resolve(state.settings);
    for (const f of state.frames) { f.isRef = false; f.rejected = null; updateFrameEl(f); }

    const job = { t0: performance.now(), est: estimate(state.settings, frames.length), notes: [], phase: '', done: 0, total: 0, timings: {} };
    state.job = job;
    state.running = true;
    setRunningUI(true);
    const pool = (job.pool = new Pool(s.workers));
    const skipped = [];
    const P = s.Ww * s.Hw;
    const common = { W0: state.probe.W0, H0: state.probe.H0, Ww: s.Ww, Hw: s.Hw, interp: s.interp, aMax: s.aMax, maxStars: s.maxStars, inv: [1, 0, 0, 0, 1, 0] };

    try {
      await clearCache();
      const useCache = !s.streaming && cacheFits(s, frames.length);
      job.useCache = useCache;
      const acc = s.streaming ? makeAcc(s.method, P) : null;
      const live = () => livePreview((p, d, o) => {
        const c = acc.cnt[p];
        if (!c) { d[o] = d[o + 1] = d[o + 2] = 0; return; }
        if (acc.mx) { d[o] = acc.mx[p * 3] / C.MAXV; d[o + 1] = acc.mx[p * 3 + 1] / C.MAXV; d[o + 2] = acc.mx[p * 3 + 2] / C.MAXV; return; }
        const k = 1 / ((acc.wsum ? acc.wsum[p] : c) * C.MAXV);
        d[o] = acc.sum[p * 3] * k; d[o + 1] = acc.sum[p * 3 + 1] * k; d[o + 2] = acc.sum[p * 3 + 2] * k;
      }, s.Ww, s.Hw);
      const sink = acc ? 'return' : useCache ? 'cache' : 'none';
      let ref, used, refData = null;

      if (s.analysis) {
        const a = await analysisPass(job, pool, s, frames, skipped);
        ref = a.ref; used = a.used;
        ref.isRef = true; updateFrameEl(ref);
        setPhase(job, 'warp', sink === 'none' ? 0 : used.length);
        if (sink !== 'none') await pool.each(used, async (f, wi) => {
          const r = await callFrame(pool, wi, f, { type: 'warp', ...common, inv: f.inv, sink, id: f.id });
          if (acc) {
            accumulate(acc, r.data, a.weights.get(f));
            if (f === ref) refData = r.data;
            maybeLive(job, live);
          }
          tick(job);
        });
      } else {
        // one pass: the first photo is the reference, others are matched to it as they arrive
        setPhase(job, 'warp', frames.length);
        ref = frames[0];
        ref.isRef = true;
        let align = s.align;
        const detect = align !== 'none' || s.method === 'weighted';
        const r0 = await callFrame(pool, 0, ref, { type: 'warp', ...common, detect, thumb: !ref.thumb, sink, id: ref.id });
        if (r0.thumb) { ref.thumb = r0.thumb; updateFrameEl(ref); }
        const refStars = r0.ana ? r0.ana.stars : [];
        if (align !== 'none' && refStars.length < 3) {
          align = 'none';
          job.notes.push('Too few stars to align, so the photos were stacked as they are.');
        }
        updateFrameEl(ref);
        const refScore = r0.ana ? Math.sqrt(r0.ana.nStars + 1) / Math.max(0.7, r0.ana.fwhm || 3) : 1;
        if (acc) { accumulate(acc, r0.data, 1); refData = r0.data; }
        used = [ref];
        tick(job);
        await pool.each(frames.slice(1), async (f, wi) => {
          let r;
          try {
            r = await callFrame(pool, wi, f, {
              type: 'warp', ...common, detect: align !== 'none' || s.method === 'weighted', refStars: align === 'none' ? null : refStars, align, tol: s.tol, nUse: s.nUse,
              thumb: !f.thumb, sink, id: f.id,
            });
          } catch (e) {
            const why = reasonFor(e);
            if (!why) throw e;
            skip(f, why, skipped);
            tick(job);
            return;
          }
          if (r.thumb) { f.thumb = r.thumb; updateFrameEl(f); }
          f.inv = r.m ? C.invertAffine(r.m) : [1, 0, 0, 0, 1, 0];
          used.push(f);
          if (acc) {
            const score = r.ana ? Math.sqrt(r.ana.nStars + 1) / Math.max(0.7, r.ana.fwhm || 3) : refScore;
            const w = s.method === 'weighted' ? Math.min(3, Math.max(0.25, score / refScore)) : 1;
            accumulate(acc, r.data, w);
            maybeLive(job, live);
          }
          tick(job);
        });
        used.sort((a, b) => frames.indexOf(a) - frames.indexOf(b));
      }

      const result = acc ? finishAcc(acc) : await reducePass(job, pool, s, used, useCache);
      if (!refData) {
        if (useCache) refData = await readCached(ref.id);
        else refData = (await callFrame(pool, 0, ref, { type: 'warp', ...common, inv: [1, 0, 0, 0, 1, 0], sink: 'return' })).data;
      }
      setPhase(job, 'finish', 0);
      console.info('[AstroStackPro] estimate', JSON.stringify(job.est), 'actual', JSON.stringify(job.timings), 'cache', job.useCache);
      finalize(result, refData, s, { used, skipped, ref, total: frames.length, elapsed: performance.now() - job.t0, notes: job.notes });
    } catch (e) {
      if (e.kind === 'cancel') {
        setNotice('Stacking cancelled.');
      } else {
        console.error(e);
        const hint = e.kind === 'crash' || /memory|allocation/i.test(e.message)
          ? ' The browser ran out of memory: under Fine-tune, choose a lower resolution or fewer background workers.' : '';
        setNotice(`Stacking stopped: ${e.message}.${hint}`);
      }
    } finally {
      pool.terminate();
      state.running = false;
      state.job = null;
      setRunningUI(false);
      clearCache();
      for (const f of state.frames) updateFrameEl(f);
    }
  }

  function setRunningUI(on) {
    $('#progress').hidden = !on;
    $('#stackBtn').hidden = on;
    for (const el of $$('.preset, [data-setting], #clearBtn')) el.disabled = on;
    $('#photosActions').classList.toggle('is-locked', on);
    if (on) {
      $('#stepFinish').hidden = true;
      $('#viewerBar').hidden = true;
      $('#progressFill').style.width = '0';
      setNotice('');
    }
    updateEta();
  }

  // ------------------------------------------------------------------ result

  function finalize(res, refData, s, info) {
    const W = s.Ww, H = s.Hw;
    const r = {
      w: W, h: H, data: res.out, cnt: res.cnt, ref: refData, s, info,
      cropRect: Post.autoCrop(res.cnt, W, H),
    };
    state.result = r;
    state.post = Post.defaults();
    state.view = { zoom: 'fit', cx: W / 2, cy: H / 2, compare: false };
    r.noiseGain = Post.noise(refData, W, H, true) / Math.max(1e-9, Post.noise(res.out, W, H, false));
    preparePreviews();

    const used = info.used.length, skippedN = info.skipped.length;
    const reasons = {};
    for (const k of info.skipped) reasons[k.reason] = (reasons[k.reason] || 0) + 1;
    const skipText = skippedN
      ? ` ${skippedN} skipped: ${Object.entries(reasons).map(([k, v]) => `${v} because ${k}`).join(', ')}.`
      : '';
    const gain = s.method !== 'max' && Number.isFinite(r.noiseGain) && r.noiseGain > 1.05
      ? ` Noise is about <strong>${r.noiseGain.toFixed(1)}× lower</strong> than in a single photo.` : '';
    const scaleNote = s.scaleUsed < 1 ? ` at ${Math.round(s.scaleUsed * 100)}% resolution (${W} × ${H})` : ` (${W} × ${H})`;
    $('#report').innerHTML = `Stacked <strong>${used} of ${info.total}</strong> photos with ${METHOD_NAMES[s.method]}${scaleNote} in ${fmtDur(info.elapsed)}.${skipText}${gain}` +
      (info.notes.length ? `<br>${info.notes.join(' ')}` : '');

    $('#stepRun').classList.add('is-done');
    $('#stepFinish').hidden = false;
    $('#viewerBar').hidden = false;
    $('.seg').hidden = false;
    $('#compareBtn').hidden = false;
    $('#view').classList.add('has-result');
    syncPostUI();
    updateEta();
    renderView();
    $('#stepFinish').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function activeCrop() {
    const r = state.result;
    return state.post.crop ? r.cropRect : { x: 0, y: 0, w: r.w, h: r.h };
  }

  function preparePreviews() {
    const r = state.result;
    const crop = activeCrop();
    r.pv = Post.downsample(r.data, r.w, r.h, crop, 1800, false);
    r.pvRef = Post.downsample(r.ref, r.w, r.h, crop, 1800, true);
    r.model = Post.backgroundModel(r.pv, r.w, r.h);
    state.view.cx = Math.min(Math.max(state.view.cx, crop.x), crop.x + crop.w);
    state.view.cy = Math.min(Math.max(state.view.cy, crop.y), crop.y + crop.h);
  }

  function showImage(bitmap) {
    const c = $('#view');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.style.width = c.style.height = '';
    c.getContext('2d').drawImage(bitmap, 0, 0);
    c.hidden = false;
    $('#drop').hidden = true;
    $('#viewerBar').hidden = false;
    $('.seg').hidden = true;
    $('#compareBtn').hidden = true;
    $('#viewerCaption').textContent = 'First photo, before stacking';
  }

  let renderQueued = false;
  function renderView() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; drawView(); });
  }

  function drawView() {
    const r = state.result;
    if (!r || state.running) return;
    const c = $('#view');
    const ctx = c.getContext('2d');
    const stage = $('#stage');
    const v = state.view;
    const compare = v.compare;
    stage.classList.toggle('is-zoomed', v.zoom === '1');
    if (v.zoom === 'fit') {
      const pv = compare ? r.pvRef : r.pv;
      c.width = pv.w; c.height = pv.h;
      c.style.width = c.style.height = '';
      const img = ctx.createImageData(pv.w, pv.h);
      Post.render(pv.data, pv.w, pv.h, pv.x, pv.y, pv.step, r.w, r.h, state.post, r.model, img.data);
      ctx.putImageData(img, 0, 0);
    } else {
      const crop = activeCrop();
      const dpr = window.devicePixelRatio || 1;
      const rect = stage.getBoundingClientRect();
      const cw = Math.min(crop.w, Math.round(rect.width * dpr)), ch = Math.min(crop.h, Math.round(rect.height * dpr));
      const x0 = Math.round(Math.min(Math.max(v.cx - cw / 2, crop.x), crop.x + crop.w - cw));
      const y0 = Math.round(Math.min(Math.max(v.cy - ch / 2, crop.y), crop.y + crop.h - ch));
      v.cx = x0 + cw / 2; v.cy = y0 + ch / 2;
      const src = new Float32Array(cw * ch * 3);
      const k = 1 / C.MAXV;
      for (let y = 0; y < ch; y++) {
        const off = ((y0 + y) * r.w + x0) * 3;
        if (compare) {
          for (let i = 0; i < cw * 3; i++) { const val = r.ref[off + i]; src[y * cw * 3 + i] = val === C.INVALID ? 0 : val * k; }
        } else {
          src.set(r.data.subarray(off, off + cw * 3), y * cw * 3);
        }
      }
      c.width = cw; c.height = ch;
      c.style.width = `${cw / dpr}px`;
      c.style.height = `${ch / dpr}px`;
      const img = ctx.createImageData(cw, ch);
      Post.render(src, cw, ch, x0, y0, 1, r.w, r.h, state.post, r.model, img.data);
      ctx.putImageData(img, 0, 0);
    }
    $('#viewerCaption').textContent = compare
      ? 'Single photo (reference frame)'
      : v.zoom === '1' ? 'Stacked result at 100%. Drag to move around.' : 'Stacked result. Click to zoom to 100%.';
    $('#compareBtn').classList.toggle('is-active', compare);
    for (const b of $$('.seg-btn')) b.classList.toggle('is-on', b.dataset.zoom === v.zoom);
  }

  function setZoom(zoom, cx, cy) {
    const r = state.result;
    if (!r) return;
    state.view.zoom = zoom;
    if (cx !== undefined) { state.view.cx = cx; state.view.cy = cy; }
    renderView();
  }

  // ------------------------------------------------------------------ adjustments

  const OUT_FMT = {
    black: (v) => (v ? v.toFixed(0) : 'Off'),
    exposure: (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`,
    stretch: (v) => (v ? v.toFixed(0) : 'Off'),
    saturation: (v) => `${Math.round(v * 100)}%`,
  };

  function syncPostUI() {
    for (const el of $$('[data-post]')) {
      const k = el.dataset.post;
      if (el.type === 'checkbox') el.checked = !!state.post[k];
      else el.value = state.post[k];
    }
    for (const o of $$('[data-out]')) o.textContent = OUT_FMT[o.dataset.out](Number(state.post[o.dataset.out]));
  }

  function onPostInput(e) {
    const el = e.target;
    const k = el.dataset.post;
    const before = state.post.crop;
    state.post[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (k === 'crop' && before !== state.post.crop) preparePreviews();
    for (const o of $$('[data-out]')) o.textContent = OUT_FMT[o.dataset.out](Number(state.post[o.dataset.out]));
    renderView();
  }

  // ------------------------------------------------------------------ export

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function exportImage(kind, btn) {
    const r = state.result;
    if (!r) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    await nextFrame();
    try {
      const crop = activeCrop();
      const base = `astrostackpro-${r.info.used.length}x-${r.s.method}`;
      const rowSrc = (y) => r.data.subarray(((crop.y + y) * r.w + crop.x) * 3, ((crop.y + y) * r.w + crop.x + crop.w) * 3);
      if (kind === 'tiff32') {
        const out = new Float32Array(crop.w * crop.h * 3);
        for (let y = 0; y < crop.h; y++) out.set(rowSrc(y), y * crop.w * 3);
        download(Post.tiff(crop.w, crop.h, out, true), `${base}-linear.tif`);
      } else if (kind === 'tiff16') {
        const out = new Uint16Array(crop.w * crop.h * 3);
        for (let y = 0; y < crop.h; y++) {
          Post.render(rowSrc(y), crop.w, 1, crop.x, crop.y + y, 1, r.w, r.h, state.post, r.model, out.subarray(y * crop.w * 3, (y + 1) * crop.w * 3));
        }
        download(Post.tiff(crop.w, crop.h, out, false), `${base}.tif`);
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = crop.w; canvas.height = crop.h;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(crop.w, crop.h);
        for (let y = 0; y < crop.h; y++) {
          Post.render(rowSrc(y), crop.w, 1, crop.x, crop.y + y, 1, r.w, r.h, state.post, r.model, img.data.subarray(y * crop.w * 4, (y + 1) * crop.w * 4));
        }
        ctx.putImageData(img, 0, 0);
        const mime = kind === 'png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.95));
        if (!blob) throw new Error('the image is too large for this browser');
        download(blob, `${base}.${kind === 'png' ? 'png' : 'jpg'}`);
      }
    } catch (e) {
      setNotice(`Export failed: ${e.message}.`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ------------------------------------------------------------------ events

  function bind() {
    $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('#clearBtn').addEventListener('click', clearAll);
    $('#stackBtn').addEventListener('click', run);
    $('#cancelBtn').addEventListener('click', () => { if (state.job && state.job.pool) state.job.pool.terminate(); });

    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('.desk').classList.add('is-over'); $('#drop').classList.add('is-over'); });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('.desk').classList.remove('is-over'); $('#drop').classList.remove('is-over'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('.desk').classList.remove('is-over');
      $('#drop').classList.remove('is-over');
      if (!state.running && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    for (const b of $$('.preset')) {
      b.addEventListener('click', () => {
        Object.assign(state.settings, PRESETS[b.dataset.preset]);
        syncSettingsUI();
      });
    }
    for (const el of $$('[data-setting]')) {
      el.addEventListener('change', () => { state.settings[el.dataset.setting] = el.value; syncSettingsUI(); });
    }

    // viewer: click to zoom, drag to pan, hold to compare
    const view = $('#view');
    let drag = null;
    view.addEventListener('pointerdown', (e) => {
      if (!state.result || state.running) return;
      if (state.view.zoom === 'fit') {
        const r = state.result, pv = r.pv;
        const x = pv.x + (e.offsetX / view.clientWidth) * pv.w * pv.step;
        const y = pv.y + (e.offsetY / view.clientHeight) * pv.h * pv.step;
        setZoom('1', x, y);
        return;
      }
      drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
      view.setPointerCapture(e.pointerId);
      $('#stage').classList.add('is-dragging');
    });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dpr = window.devicePixelRatio || 1;
      state.view.cx = drag.cx - (e.clientX - drag.x) * dpr;
      state.view.cy = drag.cy - (e.clientY - drag.y) * dpr;
      renderView();
    });
    const endDrag = () => { drag = null; $('#stage').classList.remove('is-dragging'); };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    view.addEventListener('dblclick', () => setZoom('fit'));
    for (const b of $$('.seg-btn')) b.addEventListener('click', () => setZoom(b.dataset.zoom));

    const cmp = $('#compareBtn');
    const setCompare = (on) => { if (state.result && state.view.compare !== on) { state.view.compare = on; renderView(); } };
    cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); setCompare(true); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setCompare(false));
    cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
    cmp.addEventListener('keyup', () => setCompare(false));
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'c' || e.key === 'C') && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) setCompare(true);
    });
    window.addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') setCompare(false); });
    window.addEventListener('resize', () => { if (state.view.zoom === '1') renderView(); });

    for (const el of $$('[data-post]')) el.addEventListener('input', onPostInput);
    $('#autoBtn').addEventListener('click', () => {
      const r = state.result;
      if (!r) return;
      const crop = state.post.crop;
      state.post = { ...Post.autoParams(r.pv, r.w, r.h, r.model), crop };
      syncPostUI();
      renderView();
    });
    $('#resetBtn').addEventListener('click', () => {
      const crop = state.post.crop;
      state.post = { ...Post.defaults(), crop };
      syncPostUI();
      renderView();
    });
    for (const b of $$('[data-export]')) b.addEventListener('click', () => exportImage(b.dataset.export, b));
  }

  function init() {
    if (!window.Worker || typeof OffscreenCanvas === 'undefined') {
      setNotice('This browser is missing features AstroStackPro needs (Web Workers with OffscreenCanvas). Please use a recent Chrome, Edge, Safari 16.4+ or Firefox.');
    }
    if (matchMedia('(pointer: coarse)').matches) {
      $('.drop-title').textContent = 'Choose your night-sky photos';
      $('.drop-sub').innerHTML = 'Pick 5 to 500 shots of the same patch of sky.<br>JPEG, PNG, WebP, AVIF, and HEIC in Safari.';
    }
    initWorkerOptions();
    bind();
    syncSettingsUI();
    benchAccumulate();
    clearCache();
    window.AstroStackPro = { state, estimate, resolve }; // handy for debugging
  }

  init();
})();
