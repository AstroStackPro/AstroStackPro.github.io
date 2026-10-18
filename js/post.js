/* AstroStackPro post-processing: preview, gradient removal, stretch, crop, export. */
(function (root) {
  'use strict';
  const C = root.AstroCore;

  /** Box-downsamples a linear RGB float image (or Uint16 when `u16`) inside `crop`. */
  function downsample(src, W, H, crop, maxSide, u16) {
    const step = Math.max(1, Math.ceil(Math.max(crop.w, crop.h) / maxSide));
    const pw = Math.max(1, Math.floor(crop.w / step)), ph = Math.max(1, Math.floor(crop.h / step));
    const out = new Float32Array(pw * ph * 3);
    const norm = u16 ? 1 / C.MAXV : 1;
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        let r = 0, g = 0, b = 0, n = 0;
        const x0 = crop.x + px * step, y0 = crop.y + py * step;
        for (let y = y0; y < y0 + step; y++) {
          let i = (y * W + x0) * 3;
          for (let x = 0; x < step; x++, i += 3) {
            if (u16 && src[i] === C.INVALID) continue;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
          }
        }
        const o = (py * pw + px) * 3;
        if (n) { out[o] = (r / n) * norm; out[o + 1] = (g / n) * norm; out[o + 2] = (b / n) * norm; }
      }
    }
    return { w: pw, h: ph, data: out, step, x: crop.x, y: crop.y };
  }

  // ---------------------------------------------------------------- background model

  function solve(A, b) { // Gaussian elimination, small dense systems
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  const terms = (u, v) => [1, u, v, u * u, u * v, v * v];

  /**
   * Fits a smooth 2nd-order surface to the sky background of each channel,
   * ignoring stars, the Milky Way and foreground through iterative rejection.
   * Coordinates are normalised to the full frame (W×H) so the model works at any scale.
   */
  function backgroundModel(pv, W, H) {
    const gx = 16, gy = 12;
    const cells = [];
    const tmp = new Float32Array(Math.ceil(pv.w / gx + 1) * Math.ceil(pv.h / gy + 1));
    for (let cy = 0; cy < gy; cy++) {
      for (let cx = 0; cx < gx; cx++) {
        const x0 = Math.floor((cx * pv.w) / gx), x1 = Math.floor(((cx + 1) * pv.w) / gx);
        const y0 = Math.floor((cy * pv.h) / gy), y1 = Math.floor(((cy + 1) * pv.h) / gy);
        const med = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          let m = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tmp[m++] = pv.data[(y * pv.w + x) * 3 + c];
          med[c] = C.median(tmp, m);
        }
        const fx = pv.x + ((x0 + x1) / 2) * pv.step, fy = pv.y + ((y0 + y1) / 2) * pv.step;
        cells.push({ u: (fx / W) * 2 - 1, v: (fy / H) * 2 - 1, med, ok: true });
      }
    }
    let coef = null;
    for (let it = 0; it < 4; it++) {
      coef = [0, 1, 2].map((c) => {
        const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), b = new Array(6).fill(0);
        for (const cell of cells) {
          if (!cell.ok) continue;
          const t = terms(cell.u, cell.v);
          for (let i = 0; i < 6; i++) { b[i] += t[i] * cell.med[c]; for (let j = 0; j < 6; j++) A[i][j] += t[i] * t[j]; }
        }
        return solve(A, b) || [0, 0, 0, 0, 0, 0];
      });
      const resid = cells.filter((c) => c.ok).map((cell) => {
        const t = terms(cell.u, cell.v);
        let s = 0;
        for (let c = 0; c < 3; c++) s += cell.med[c] - t.reduce((acc, v, i) => acc + v * coef[c][i], 0);
        return s / 3;
      });
      const r = new Float32Array(resid.map(Math.abs));
      const sd = 1.4826 * C.median(r, r.length) + 1e-6;
      let k = 0;
      let changed = false;
      for (const cell of cells) {
        if (!cell.ok) continue;
        const ok = Math.abs(resid[k++]) < 2.5 * sd;
        if (!ok) { cell.ok = false; changed = true; }
      }
      if (!changed || cells.filter((c) => c.ok).length < 12) break;
    }
    const kept = cells.filter((c) => c.ok);
    const level = [0, 1, 2].map((c) => {
      const a = new Float32Array(kept.map((cell) => cell.med[c]));
      return C.median(a, a.length);
    });
    return { coef, level, neutral: (level[0] + level[1] + level[2]) / 3 };
  }

  // ---------------------------------------------------------------- processing

  function defaults() {
    return { gradient: false, neutral: false, black: 0, exposure: 0, stretch: 0, saturation: 1, crop: true };
  }

  const stretchK = (s) => (s <= 0 ? 0 : Math.pow(10, (s / 100) * 3.3) - 1);
  const blackValue = (b) => 0.25 * Math.pow(b / 100, 2);

  /**
   * Renders linear RGB floats to RGBA bytes (or 16-bit RGB when out is a Uint16Array) with the user's adjustments.
   * (x0, y0, step) give the full-frame position of src pixel (0,0) and the pixel pitch.
   */
  function render(src, sw, sh, x0, y0, step, W, H, prm, model, out) {
    const k = stretchK(prm.stretch);
    const ak = k > 0 ? Math.asinh(k) : 1;
    const bp = blackValue(prm.black);
    const bpScale = 1 / (1 - bp);
    const gain = Math.pow(2, prm.exposure);
    const sat = prm.saturation;
    const useModel = prm.gradient && model;
    const neutral = prm.neutral && model;
    const ped = model ? (neutral ? [model.neutral, model.neutral, model.neutral] : model.level) : [0, 0, 0];
    const cf = model ? model.coef : null;
    const enc = C.encodeSrgb;
    const is16 = out instanceof Uint16Array; // 16-bit RGB (no alpha) for TIFF export
    let o = 0;
    for (let y = 0; y < sh; y++) {
      const v = ((y0 + y * step) / H) * 2 - 1;
      let i = y * sw * 3;
      for (let x = 0; x < sw; x++, i += 3, o += 4) {
        let r = src[i], g = src[i + 1], b = src[i + 2];
        if (useModel) {
          const u = ((x0 + x * step) / W) * 2 - 1;
          const uu = u * u, uv = u * v, vv = v * v;
          r += ped[0] - (cf[0][0] + cf[0][1] * u + cf[0][2] * v + cf[0][3] * uu + cf[0][4] * uv + cf[0][5] * vv);
          g += ped[1] - (cf[1][0] + cf[1][1] * u + cf[1][2] * v + cf[1][3] * uu + cf[1][4] * uv + cf[1][5] * vv);
          b += ped[2] - (cf[2][0] + cf[2][1] * u + cf[2][2] * v + cf[2][3] * uu + cf[2][4] * uv + cf[2][5] * vv);
        } else if (neutral) {
          r += ped[0] - model.level[0]; g += ped[1] - model.level[1]; b += ped[2] - model.level[2];
        }
        r = (r - bp) * bpScale * gain; g = (g - bp) * bpScale * gain; b = (b - bp) * bpScale * gain;
        if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
        if (k > 0) {
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (L > 1e-9) { const f = Math.asinh(k * L) / (ak * L); r *= f; g *= f; b *= f; }
        }
        if (sat !== 1) {
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = L + (r - L) * sat; g = L + (g - L) * sat; b = L + (b - L) * sat;
        }
        if (is16) {
          out[o] = enc(r) * 65535 + 0.5;
          out[o + 1] = enc(g) * 65535 + 0.5;
          out[o + 2] = enc(b) * 65535 + 0.5;
          o -= 1;
        } else {
          out[o] = enc(r) * 255 + 0.5;
          out[o + 1] = enc(g) * 255 + 0.5;
          out[o + 2] = enc(b) * 255 + 0.5;
          out[o + 3] = 255;
        }
      }
    }
  }

  /** Picks black point / stretch so the sky sits at a pleasant dark grey. */
  function autoParams(pv, W, H, model) {
    const prm = defaults();
    prm.gradient = true;
    prm.neutral = true;
    prm.saturation = 1.3;
    const rgba = new Uint8ClampedArray(pv.w * pv.h * 4);
    // measure luminance after background correction, before any tone change
    const lin = new Float32Array(pv.w * pv.h);
    const tmp = { ...prm, saturation: 1 };
    render(pv.data, pv.w, pv.h, pv.x, pv.y, pv.step, W, H, tmp, model, rgba);
    // invert sRGB for a linear measurement
    for (let i = 0, j = 0; i < lin.length; i++, j += 4) {
      lin[i] = 0.2126 * C.LIN01[rgba[j]] + 0.7152 * C.LIN01[rgba[j + 1]] + 0.0722 * C.LIN01[rgba[j + 2]];
    }
    const sorted = lin.slice();
    const med = C.median(sorted, sorted.length);
    for (let i = 0; i < sorted.length; i++) sorted[i] = Math.abs(lin[i] - med);
    const mad = 1.4826 * C.median(sorted, sorted.length);
    const bpLin = Math.min(Math.max(0, med - 3 * mad), med * 0.85);
    prm.black = Math.min(100, Math.sqrt(bpLin / 0.25) * 100);
    const bp = blackValue(prm.black);
    const m = Math.max(1e-6, (med - bp) / (1 - bp));
    const target = 0.025;
    if (m < target) {
      let lo = 0, hi = 100;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2, k = stretchK(mid);
        const v = k > 0 ? Math.asinh(k * m) / Math.asinh(k) : m;
        if (v < target) lo = mid; else hi = mid;
      }
      prm.stretch = Math.round(((lo + hi) / 2) * 10) / 10;
    } else {
      prm.exposure = Math.max(-2, Math.log2(target / m));
    }
    return prm;
  }

  // ---------------------------------------------------------------- crop + noise

  /** Largest well-covered rectangle (pixels stacked from ≥ 90% of the frames). */
  function autoCrop(cnt, W, H) {
    let maxC = 0;
    for (let i = 0; i < cnt.length; i++) if (cnt[i] > maxC) maxC = cnt[i];
    const full = { x: 0, y: 0, w: W, h: H };
    if (!maxC) return full;
    const thr = Math.max(1, Math.floor(maxC * 0.9));
    const s = 4, gw = Math.ceil(W / s), gh = Math.ceil(H / s);
    const sat = new Uint32Array((gw + 1) * (gh + 1)); // summed-area table of bad blocks
    for (let gy = 0; gy < gh; gy++) {
      let rowSum = 0;
      for (let gx = 0; gx < gw; gx++) {
        let bad = 0;
        for (let y = gy * s; y < Math.min(H, gy * s + s) && !bad; y++) {
          for (let x = gx * s; x < Math.min(W, gx * s + s); x++) if (cnt[y * W + x] < thr) { bad = 1; break; }
        }
        rowSum += bad;
        sat[(gy + 1) * (gw + 1) + gx + 1] = sat[gy * (gw + 1) + gx + 1] + rowSum;
      }
    }
    const sum = (x0, y0, x1, y1) => sat[y1 * (gw + 1) + x1] - sat[y0 * (gw + 1) + x1] - sat[y1 * (gw + 1) + x0] + sat[y0 * (gw + 1) + x0];
    let x0 = 0, y0 = 0, x1 = gw, y1 = gh;
    while (x1 - x0 > 2 && y1 - y0 > 2 && sum(x0, y0, x1, y1) > 0) {
      const top = sum(x0, y0, x1, y0 + 1) / (x1 - x0), bottom = sum(x0, y1 - 1, x1, y1) / (x1 - x0);
      const left = sum(x0, y0, x0 + 1, y1) / (y1 - y0), right = sum(x1 - 1, y0, x1, y1) / (y1 - y0);
      const mx = Math.max(top, bottom, left, right);
      if (mx === top) y0++; else if (mx === bottom) y1--; else if (mx === left) x0++; else x1--;
    }
    if (x1 - x0 <= 2 || y1 - y0 <= 2) return full;
    const r = { x: x0 * s, y: y0 * s, w: Math.min(W, x1 * s) - x0 * s, h: Math.min(H, y1 * s) - y0 * s };
    return r.w * r.h > 0.3 * W * H ? r : full;
  }

  /** Robust pixel-noise estimate on 2×2-binned luminance in the frame centre. */
  function noise(src, W, H, u16) {
    const norm = u16 ? 1 / C.MAXV : 1;
    const size = Math.min(1024, W - 4, H - 4);
    const x0 = Math.floor((W - size) / 2), y0 = Math.floor((H - size) / 2);
    const lumAt = (x, y) => {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y + dy) * W + x + dx) * 3;
        if (u16 && src[i] === C.INVALID) return NaN;
        s += 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
      }
      return (s / 4) * norm;
    };
    const d = [];
    for (let y = y0; y < y0 + size - 2; y += 2) {
      for (let x = x0; x < x0 + size - 4; x += 4) {
        const v = lumAt(x, y) - lumAt(x + 2, y);
        if (Number.isFinite(v)) d.push(Math.abs(v));
      }
    }
    const a = new Float32Array(d);
    return (1.4826 * C.median(a, a.length)) / Math.SQRT2;
  }

  // ---------------------------------------------------------------- TIFF export

  /** Baseline uncompressed RGB TIFF; 16-bit unsigned or 32-bit float samples. */
  function tiff(w, h, data, isFloat) {
    const bps = isFloat ? 32 : 16;
    const bytes = w * h * 3 * (bps / 8);
    const entries = [
      [256, 4, 1, w], [257, 4, 1, h], [258, 3, 3, 'bps'], [259, 3, 1, 1], [262, 3, 1, 2],
      [273, 4, 1, 'data'], [277, 3, 1, 3], [278, 4, 1, h], [279, 4, 1, bytes],
      [282, 5, 1, 'xres'], [283, 5, 1, 'yres'], [284, 3, 1, 1], [296, 3, 1, 2], [339, 3, 3, 'fmt'],
    ];
    const ifdSize = 2 + entries.length * 12 + 4;
    const extra = 8 + ifdSize;
    const off = { bps: extra, fmt: extra + 6, xres: extra + 12, yres: extra + 20 };
    off.data = extra + 28;
    const head = new ArrayBuffer(off.data);
    const v = new DataView(head);
    v.setUint16(0, 0x4949, true); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
    v.setUint16(8, entries.length, true);
    entries.forEach((e, i) => {
      const p = 10 + i * 12;
      v.setUint16(p, e[0], true); v.setUint16(p + 2, e[1], true); v.setUint32(p + 4, e[2], true);
      const val = typeof e[3] === 'string' ? off[e[3]] : e[3];
      if (e[1] === 3 && e[2] === 1) v.setUint16(p + 8, val, true); else v.setUint32(p + 8, val, true);
    });
    v.setUint32(10 + entries.length * 12, 0, true);
    for (let i = 0; i < 3; i++) { v.setUint16(off.bps + i * 2, bps, true); v.setUint16(off.fmt + i * 2, isFloat ? 3 : 1, true); }
    v.setUint32(off.xres, 72, true); v.setUint32(off.xres + 4, 1, true);
    v.setUint32(off.yres, 72, true); v.setUint32(off.yres + 4, 1, true);
    return new Blob([head, data], { type: 'image/tiff' });
  }

  root.AstroPost = { downsample, backgroundModel, defaults, render, autoParams, autoCrop, noise, tiff, stretchK, blackValue };
})(typeof self !== 'undefined' ? self : this);
