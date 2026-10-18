/* AstroStackPro worker: decodes, analyses, aligns, warps and combines frames. */
// Loaded on the page as a plain script; app.js starts it inside a Blob worker together with
// core.js. This also works when index.html is opened straight from disk (file://).
function AstroWorkerMain() {
'use strict';
const C = self.AstroCore;

const canvases = new Map();
function surface(key, w, h) {
  let s = canvases.get(key);
  if (!s || s.c.width !== w || s.c.height !== h) {
    const c = new OffscreenCanvas(w, h);
    s = { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
    canvases.set(key, s);
  }
  return s.ctx;
}

function fail(kind, message) {
  const e = new Error(message || kind);
  e.kind = kind;
  return e;
}

async function getBitmap(msg) {
  if (msg.bitmap) return msg.bitmap;
  try {
    return await createImageBitmap(msg.file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (e instanceof TypeError) {
      try { return await createImageBitmap(msg.file); } catch (e2) { /* fall through */ }
    }
    throw fail('decode', 'This browser cannot read this file');
  }
}

function checkSize(bmp, msg) {
  if (msg.W0 && (bmp.width !== msg.W0 || bmp.height !== msg.H0)) {
    throw fail('size', `Different size (${bmp.width}×${bmp.height})`);
  }
}

function draw(bmp, key, w, h) {
  const ctx = surface(key, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx;
}

function analyse(bmp, Ww, Hw, aMax, maxStars) {
  const s = Math.min(1, aMax / Math.max(Ww, Hw));
  const aw = Math.max(16, Math.round(Ww * s)), ah = Math.max(16, Math.round(Hw * s));
  const data = draw(bmp, 'ana', aw, ah).getImageData(0, 0, aw, ah).data;
  const det = C.detectStars(C.luminance(data, aw * ah), aw, ah, { maxStars });
  const fx = Ww / aw, fy = Hw / ah;
  return {
    stars: det.stars.map((st) => ({ x: (st.x + 0.5) * fx - 0.5, y: (st.y + 0.5) * fy - 0.5, f: st.f })),
    nStars: det.count,
    fwhm: det.fwhm * fx,
    bg: det.bg,
    noise: det.noise,
  };
}

function thumbnail(bmp, size) {
  const s = size / Math.max(bmp.width, bmp.height);
  const tw = Math.max(1, Math.round(bmp.width * s)), th = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(tw, th);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, tw, th);
  return c.transferToImageBitmap();
}

function warpFull(bmp, msg, inv) {
  const { Ww, Hw } = msg;
  const src = draw(bmp, 'work', Ww, Hw).getImageData(0, 0, Ww, Hw).data;
  const out = new Uint16Array(Ww * Hw * 3);
  C.warpRows(src, Ww, Hw, 0, 0, Ww, Hw, inv, out, Ww, 0, Hw, msg.interp);
  return out;
}

// ------------------------------------------------------------- disk cache (OPFS)

async function cacheDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('eas-cache', { create: true });
}

async function cacheWrite(id, u16) {
  const dir = await cacheDir();
  const fh = await dir.getFileHandle(`f${id}.bin`, { create: true });
  const ah = await fh.createSyncAccessHandle();
  try {
    ah.truncate(0);
    const bytes = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
    let done = 0;
    while (done < bytes.length) {
      const n = ah.write(bytes.subarray(done), { at: done });
      if (!(n > 0)) throw new Error('Disk cache write failed');
      done += n;
    }
    ah.flush();
  } finally {
    ah.close();
  }
}

async function cacheRead(dir, id, start, end) {
  const file = await (await dir.getFileHandle(`f${id}.bin`)).getFile();
  return new Uint16Array(await file.slice(start, end).arrayBuffer());
}

// ------------------------------------------------------------- jobs

async function probe(msg) {
  const t0 = performance.now();
  const bmp = await getBitmap(msg);
  const tDecode = performance.now() - t0;
  const W0 = bmp.width, H0 = bmp.height;

  let t = performance.now();
  const src = draw(bmp, 'work', W0, H0).getImageData(0, 0, W0, H0).data;
  const tDraw = performance.now() - t;

  t = performance.now();
  const ana = analyse(bmp, W0, H0, 1600, 80);
  const tAnalyse = performance.now() - t;

  // warp speed, measured on a band of rows
  const band = Math.max(8, Math.round(H0 / 12));
  const out = new Uint16Array(W0 * band * 3);
  const id = [1, 0, 0.37, 0, 1, 0.21];
  t = performance.now();
  C.warpRows(src, W0, H0, 0, 0, W0, H0, id, out, W0, 0, band, 'bilinear');
  const tWarp = ((performance.now() - t) * H0) / band;
  t = performance.now();
  C.warpRows(src, W0, H0, 0, 0, W0, H0, id, out, W0, 0, band, 'bicubic');
  const tWarpCubic = ((performance.now() - t) * H0) / band;

  // combine speed, ns per frame-value
  const n = 24, P = 6000 * 3;
  const stack = new Uint16Array(n * P);
  for (let i = 0; i < stack.length; i++) stack[i] = 3000 + ((i * 2654435761) >>> 20) % 400;
  const o = new Float32Array(P), cnt = new Uint16Array(P / 3);
  const reduce = {};
  for (const m of ['mean', 'median', 'sigma', 'winsor']) {
    t = performance.now();
    C.reduceStack(stack, n, P, m, 2.5, o, cnt);
    reduce[m] = ((performance.now() - t) * 1e6) / (n * P);
  }

  let opfs = false;
  try {
    await cacheWrite('probe', new Uint16Array(1024));
    opfs = true;
  } catch (e) { opfs = false; }

  const preview = thumbnail(bmp, 1600);
  bmp.close();
  return {
    result: { W0, H0, tDecode, tDraw, tAnalyse, tWarp, tWarpCubic, reduce, opfs, nStars: ana.nStars, preview },
    transfer: [preview],
  };
}

async function analyseJob(msg) {
  const bmp = await getBitmap(msg);
  checkSize(bmp, msg);
  const ana = analyse(bmp, msg.Ww, msg.Hw, msg.aMax, msg.maxStars);
  const thumb = thumbnail(bmp, 168);
  bmp.close();
  return { result: { ...ana, thumb }, transfer: [thumb] };
}

/** Decode → (detect + align) → warp → return or write to disk cache. */
async function warpJob(msg) {
  const bmp = await getBitmap(msg);
  checkSize(bmp, msg);
  let inv = msg.inv, m = null, ana = null, thumb = null;
  if (msg.detect) {
    ana = analyse(bmp, msg.Ww, msg.Hw, msg.aMax, msg.maxStars);
    if (msg.refStars) {
      const r = C.align(msg.refStars, ana.stars, msg.align, msg.tol, { nUse: msg.nUse });
      if (!r) { bmp.close(); throw fail('align', 'Could not match the stars'); }
      m = r.m;
      inv = C.invertAffine(m);
    } else {
      m = [1, 0, 0, 0, 1, 0];
      inv = m;
    }
  }
  if (msg.thumb) thumb = thumbnail(bmp, 168);
  const result = { m, ana, thumb };
  const transfer = thumb ? [thumb] : [];
  if (msg.sink === 'none') { // only detect + align; warping happens later, band by band
    bmp.close();
    return { result, transfer };
  }
  const out = warpFull(bmp, msg, inv);
  bmp.close();
  if (msg.sink === 'cache') {
    await cacheWrite(msg.id, out);
  } else {
    result.data = out;
    transfer.push(out.buffer);
  }
  return { result, transfer };
}

/** Combine one band of rows from frames stored in the disk cache. */
async function reduceCacheJob(msg) {
  const { ids, y0, y1, W } = msg;
  const P = (y1 - y0) * W * 3;
  const stack = new Uint16Array(ids.length * P);
  const dir = await cacheDir();
  const start = y0 * W * 6, end = y1 * W * 6;
  const chunk = 8;
  for (let k = 0; k < ids.length; k += chunk) {
    const parts = await Promise.all(ids.slice(k, k + chunk).map((id) => cacheRead(dir, id, start, end)));
    parts.forEach((p, j) => stack.set(p, (k + j) * P));
  }
  const out = new Float32Array(P), cnt = new Uint16Array(P / 3);
  C.reduceStack(stack, ids.length, P, msg.method, msg.kappa, out, cnt);
  return { result: { y0, y1, out, cnt }, transfer: [out.buffer, cnt.buffer] };
}

/** Same as above without a disk cache: re-decode every frame for this band. */
async function reduceDecodeJob(msg) {
  const { files, invs, y0, y1, Ww, Hw } = msg;
  const P = (y1 - y0) * Ww * 3;
  const stack = new Uint16Array(files.length * P);
  for (let k = 0; k < files.length; k++) {
    const bmp = await getBitmap({ file: files[k] });
    const target = stack.subarray(k * P, (k + 1) * P);
    const ctx = draw(bmp, 'work', Ww, Hw);
    bmp.close();
    const box = C.sourceBox(invs[k], Ww, Hw, Ww, y0, y1, 3);
    if (!box) { target.fill(C.INVALID); continue; }
    const src = ctx.getImageData(box.x, box.y, box.w, box.h).data;
    C.warpRows(src, box.w, box.h, box.x, box.y, Ww, Hw, invs[k], target, Ww, y0, y1, msg.interp);
  }
  const out = new Float32Array(P), cnt = new Uint16Array(P / 3);
  C.reduceStack(stack, files.length, P, msg.method, msg.kappa, out, cnt);
  return { result: { y0, y1, out, cnt }, transfer: [out.buffer, cnt.buffer] };
}

const jobs = { probe, analyse: analyseJob, warp: warpJob, reduceCache: reduceCacheJob, reduceDecode: reduceDecodeJob };

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const { result, transfer } = await jobs[msg.type](msg);
    self.postMessage({ ok: true, ...result }, transfer || []);
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || String(err), kind: (err && err.kind) || 'error' });
  }
};
}
