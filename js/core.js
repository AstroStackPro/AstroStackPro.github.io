/*
 * AstroStackPro core algorithms.
 * Shared by the page and the Web Workers (the worker gets this function's source).
 * Pure functions only: star detection, alignment, warping, pixel rejection.
 */
function AstroCoreInit(root) {
  'use strict';

  const INVALID = 65535; // marks "no data" in warped 16-bit frames
  const MAXV = 65534;

  // ---------------------------------------------------------------- colour

  // 8-bit sRGB -> linear light, scaled to 0..65534 (float, for interpolation)
  const LIN = new Float32Array(256);
  const LIN01 = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const l = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    LIN01[i] = l;
    LIN[i] = l * MAXV;
  }

  // linear 0..1 -> sRGB 0..1 (LUT with interpolation; exact in the linear toe)
  const ENC_N = 4096;
  const ENC = new Float32Array(ENC_N + 2);
  for (let i = 0; i <= ENC_N + 1; i++) {
    const x = Math.min(1, i / ENC_N);
    ENC[i] = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }
  function encodeSrgb(x) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    const f = x * ENC_N;
    const i = f | 0;
    return ENC[i] + (ENC[i + 1] - ENC[i]) * (f - i);
  }

  function luminance(rgba, n) {
    const out = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = 0.2126 * LIN01[rgba[j]] + 0.7152 * LIN01[rgba[j + 1]] + 0.0722 * LIN01[rgba[j + 2]];
    }
    return out;
  }

  // ---------------------------------------------------------------- selection

  /** Partially sorts a[0..n) so that a[k] is the k-th smallest; a[0..k) <= a[k]. */
  function select(a, n, k) {
    let l = 0, r = n - 1;
    while (r > l) {
      if (r - l < 16) {
        for (let i = l + 1; i <= r; i++) {
          const v = a[i];
          let j = i - 1;
          while (j >= l && a[j] > v) { a[j + 1] = a[j]; j--; }
          a[j + 1] = v;
        }
        return a[k];
      }
      const mid = (l + r) >> 1;
      let t;
      if (a[mid] < a[l]) { t = a[mid]; a[mid] = a[l]; a[l] = t; }
      if (a[r] < a[l]) { t = a[r]; a[r] = a[l]; a[l] = t; }
      if (a[r] < a[mid]) { t = a[r]; a[r] = a[mid]; a[mid] = t; }
      const pivot = a[mid];
      let i = l, j = r;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) r = j;
      else if (k >= i) l = i;
      else return a[k];
    }
    return a[k];
  }

  function median(a, n) {
    if (n <= 0) return 0;
    if (n === 1) return a[0];
    if (n === 2) return 0.5 * (a[0] + a[1]);
    const k = n >> 1;
    const hi = select(a, n, k);
    if (n & 1) return hi;
    let lo = a[0];
    for (let i = 1; i < k; i++) if (a[i] > lo) lo = a[i];
    return 0.5 * (lo + hi);
  }

  // ---------------------------------------------------------------- stars

  /**
   * Finds stars in a linear luminance image.
   * Returns { stars:[{x,y,f,fwhm}] (brightest first), count, fwhm, bg, noise }.
   */
  function detectStars(lum, w, h, opt) {
    opt = opt || {};
    const maxStars = opt.maxStars || 80;
    const ksig = opt.sigma || 5;
    const R = 3;

    // 1. background: median of a coarse grid, bilinearly interpolated
    const cell = Math.max(16, Math.round(Math.max(w, h) / 20));
    const gx = Math.max(1, Math.ceil(w / cell)), gy = Math.max(1, Math.ceil(h / cell));
    const grid = new Float32Array(gx * gy);
    const tmp = new Float32Array((Math.ceil(cell / 2) + 1) ** 2);
    for (let cy = 0; cy < gy; cy++) {
      for (let cx = 0; cx < gx; cx++) {
        let m = 0;
        const x0 = cx * cell, y0 = cy * cell;
        const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) tmp[m++] = lum[y * w + x];
        grid[cy * gx + cx] = median(tmp, m);
      }
    }
    const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xt = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let f = (x + 0.5) / cell - 0.5;
      f = f < 0 ? 0 : f > gx - 1 ? gx - 1 : f;
      const i = Math.floor(f);
      xi0[x] = i; xi1[x] = Math.min(gx - 1, i + 1); xt[x] = f - i;
    }
    const res = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let f = (y + 0.5) / cell - 0.5;
      f = f < 0 ? 0 : f > gy - 1 ? gy - 1 : f;
      const j = Math.floor(f), j1 = Math.min(gy - 1, j + 1), t = f - j;
      const r0 = j * gx, r1 = j1 * gx, row = y * w;
      for (let x = 0; x < w; x++) {
        const a = grid[r0 + xi0[x]] + (grid[r0 + xi1[x]] - grid[r0 + xi0[x]]) * xt[x];
        const b = grid[r1 + xi0[x]] + (grid[r1 + xi1[x]] - grid[r1 + xi0[x]]) * xt[x];
        res[row + x] = lum[row + x] - (a + (b - a) * t);
      }
    }

    // 2. noise from the median absolute deviation of a sample
    const step = Math.max(1, Math.floor((w * h) / 60000));
    const ns = new Float32Array(Math.ceil((w * h) / step));
    let m = 0;
    for (let i = 0; i < w * h; i += step) ns[m++] = res[i];
    const med = median(ns, m);
    for (let i = 0; i < m; i++) ns[i] = Math.abs(ns[i] - med);
    const sigma = Math.max(1.4826 * median(ns, m), 1e-5);
    const thr = med + ksig * sigma;

    // 3. local maxima above threshold
    let cand = [];
    for (let y = R; y < h - R; y++) {
      const row = y * w;
      for (let x = R; x < w - R; x++) {
        const i = row + x;
        const v = res[i];
        if (v < thr) continue;
        if (v <= res[i - 1] || v < res[i + 1] || v <= res[i - w] || v < res[i + w] ||
            v <= res[i - w - 1] || v <= res[i - w + 1] || v < res[i + w - 1] || v < res[i + w + 1]) continue;
        cand.push(i, v);
      }
    }
    let idx = [];
    for (let c = 0; c < cand.length; c += 2) idx.push(c);
    if (idx.length > 3000) {
      idx.sort((p, q) => cand[q + 1] - cand[p + 1]);
      idx.length = 3000;
    }

    // 4. centroid + size from intensity moments
    const floor = med + sigma;
    const found = [];
    for (const c of idx) {
      const i = cand[c];
      const x = i % w, y = (i / w) | 0;
      let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let dy = -R; dy <= R; dy++) {
        const rowi = i + dy * w;
        for (let dx = -R; dx <= R; dx++) {
          const v = res[rowi + dx] - floor;
          if (v <= 0) continue;
          sw += v; sx += v * dx; sy += v * dy; sxx += v * dx * dx; syy += v * dy * dy; sxy += v * dx * dy;
        }
      }
      if (sw <= 0) continue;
      const mx = sx / sw, my = sy / sw;
      const vx = sxx / sw - mx * mx, vy = syy / sw - my * my;
      const cxy = sxy / sw - mx * my;
      const fwhm = 2.3548 * Math.sqrt(Math.max(0, (vx + vy) / 2));
      if (fwhm < 0.5) continue; // single hot pixel
      const half = (vx + vy) / 2, diff = Math.sqrt(((vx - vy) / 2) ** 2 + cxy * cxy);
      if (half - diff < 0.2 * (half + diff)) continue; // elongated: satellite, plane or meteor trail
      found.push({ x: x + mx, y: y + my, f: sw, fwhm });
    }
    found.sort((p, q) => q.f - p.f);

    // 5. remove duplicates
    const kept = [];
    for (const s of found) {
      let dup = false;
      for (let k = 0; k < kept.length; k++) {
        const dx = kept[k].x - s.x, dy = kept[k].y - s.y;
        if (dx * dx + dy * dy < 6.25) { dup = true; break; }
      }
      if (!dup) kept.push(s);
      if (kept.length >= 600) break;
    }

    const top = kept.slice(0, Math.min(30, kept.length));
    const fw = new Float32Array(top.map((s) => s.fwhm));
    return {
      stars: kept.slice(0, maxStars),
      count: kept.length,
      fwhm: top.length ? median(fw, fw.length) : 0,
      bg: median(grid.slice(), grid.length),
      noise: sigma,
    };
  }

  // ---------------------------------------------------------------- geometry

  function applyAffine(m, x, y) {
    return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
  }

  function invertAffine(m) {
    const det = m[0] * m[4] - m[1] * m[3];
    if (Math.abs(det) < 1e-12) return null;
    const a = m[4] / det, b = -m[1] / det, d = -m[3] / det, e = m[0] / det;
    return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
  }

  /** Least-squares similarity (rotation + uniform scale + shift) mapping src -> dst. */
  function lsqSimilarity(src, dst) {
    const n = src.length;
    if (n < 2) return null;
    let mx = 0, my = 0, mu = 0, mv = 0;
    for (let i = 0; i < n; i++) { mx += src[i].x; my += src[i].y; mu += dst[i].x; mv += dst[i].y; }
    mx /= n; my /= n; mu /= n; mv /= n;
    let a = 0, b = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const xc = src[i].x - mx, yc = src[i].y - my, uc = dst[i].x - mu, vc = dst[i].y - mv;
      a += xc * uc + yc * vc;
      b += xc * vc - yc * uc;
      s += xc * xc + yc * yc;
    }
    if (s <= 1e-9) return null;
    a /= s; b /= s;
    return [a, -b, mu - a * mx + b * my, b, a, mv - b * mx - a * my];
  }

  function matchPairs(m, stars, ref, tol) {
    const tol2 = tol * tol;
    const src = [], dst = [];
    let err = 0;
    for (let i = 0; i < stars.length; i++) {
      const X = m[0] * stars[i].x + m[1] * stars[i].y + m[2];
      const Y = m[3] * stars[i].x + m[4] * stars[i].y + m[5];
      let best = tol2, bj = -1;
      for (let j = 0; j < ref.length; j++) {
        const dx = ref[j].x - X, dy = ref[j].y - Y;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; bj = j; }
      }
      if (bj >= 0) { src.push(stars[i]); dst.push(ref[bj]); err += best; }
    }
    return { src, dst, n: src.length, rms: src.length ? Math.sqrt(err / src.length) : Infinity };
  }

  function makeTriangle(pts, i, j, k, minSide) {
    const P = [pts[i], pts[j], pts[k]], id = [i, j, k];
    const d = [
      Math.hypot(P[1].x - P[2].x, P[1].y - P[2].y), // opposite vertex 0
      Math.hypot(P[0].x - P[2].x, P[0].y - P[2].y), // opposite vertex 1
      Math.hypot(P[0].x - P[1].x, P[0].y - P[1].y), // opposite vertex 2
    ];
    const o = [0, 1, 2].sort((p, q) => d[p] - d[q]);
    const L0 = d[o[0]], L1 = d[o[1]], L2 = d[o[2]];
    if (L0 < minSide) return null;
    return { v: [id[o[0]], id[o[1]], id[o[2]]], a: Math.log(L2 / L1), b: Math.log(L1 / L0) };
  }

  function buildTriangles(pts, minSide) {
    const n = pts.length, tris = [], seen = new Set();
    for (let i = 0; i < n; i++) {
      const nb = [];
      for (let j = 0; j < n; j++) if (j !== i) nb.push([j, (pts[j].x - pts[i].x) ** 2 + (pts[j].y - pts[i].y) ** 2]);
      nb.sort((p, q) => p[1] - q[1]);
      const g = [i].concat(nb.slice(0, 4).map((p) => p[0]));
      for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) for (let c = b + 1; c < g.length; c++) {
        const ids = [g[a], g[b], g[c]].sort((p, q) => p - q);
        const key = ids[0] * 1e6 + ids[1] * 1e3 + ids[2];
        if (seen.has(key)) continue;
        seen.add(key);
        const t = makeTriangle(pts, ids[0], ids[1], ids[2], minSide);
        if (t) tris.push(t);
      }
    }
    return tris;
  }

  function minInliers(nr, nt) {
    return Math.max(3, Math.min(8, Math.round(0.15 * Math.min(nr, nt))));
  }

  function refine(m, stars, ref, tol, fit) {
    let best = matchPairs(m, stars, ref, tol);
    for (let it = 0; it < 3 && best.n >= 3; it++) {
      const m2 = fit(best.src, best.dst);
      if (!m2) break;
      const p = matchPairs(m2, stars, ref, tol);
      if (p.n < best.n || (p.n === best.n && p.rms >= best.rms)) break;
      m = m2; best = p;
    }
    return { m, inliers: best.n, rms: best.rms };
  }

  /** Rotation + shift alignment by matching star triangles (astroalign-style). */
  function alignSimilarity(ref, tgt, tol, opt) {
    opt = opt || {};
    const nUse = opt.nUse || 30;
    const R = ref.slice(0, nUse), T = tgt.slice(0, nUse);
    if (R.length < 3 || T.length < 3) return null;
    const minSide = opt.minSide || 4;
    const rt = buildTriangles(R, minSide), tt = buildTriangles(T, minSide);
    const cands = [];
    for (const t of tt) {
      for (const r of rt) {
        const d = Math.abs(t.a - r.a) + Math.abs(t.b - r.b);
        if (d < 0.04) cands.push([d, t, r]);
      }
    }
    cands.sort((p, q) => p[0] - q[0]);
    const need = minInliers(ref.length, tgt.length);
    let best = null;
    const lim = Math.min(cands.length, 600);
    for (let c = 0; c < lim; c++) {
      const t = cands[c][1], r = cands[c][2];
      const m = lsqSimilarity([T[t.v[0]], T[t.v[1]], T[t.v[2]]], [R[r.v[0]], R[r.v[1]], R[r.v[2]]]);
      if (!m) continue;
      const scale = Math.hypot(m[0], m[3]);
      if (scale < 0.9 || scale > 1.1) continue;
      const p = matchPairs(m, tgt, ref, tol);
      if (!best || p.n > best.n || (p.n === best.n && p.rms < best.rms)) best = { m, n: p.n, rms: p.rms };
      if (best.n >= Math.max(10, 0.7 * Math.min(ref.length, tgt.length))) break;
    }
    if (!best || best.n < need) return null;
    const out = refine(best.m, tgt, ref, tol, lsqSimilarity);
    return out.inliers >= need ? out : null;
  }

  function lsqTranslation(src, dst) {
    let dx = 0, dy = 0;
    for (let i = 0; i < src.length; i++) { dx += dst[i].x - src[i].x; dy += dst[i].y - src[i].y; }
    return src.length ? [1, 0, dx / src.length, 0, 1, dy / src.length] : null;
  }

  /** Shift-only alignment by voting on star-pair offsets. */
  function alignTranslation(ref, tgt, tol) {
    const R = ref.slice(0, 50), T = tgt.slice(0, 50);
    if (!R.length || !T.length) return null;
    const votes = new Map();
    const offs = [];
    for (const t of T) for (const r of R) {
      const dx = r.x - t.x, dy = r.y - t.y;
      offs.push(dx, dy);
      const key = Math.floor(dx / tol) + ',' + Math.floor(dy / tol);
      votes.set(key, (votes.get(key) || 0) + 1);
    }
    let bestKey = null, bestScore = -1;
    for (const key of votes.keys()) {
      const [kx, ky] = key.split(',').map(Number);
      let s = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += votes.get((kx + a) + ',' + (ky + b)) || 0;
      if (s > bestScore) { bestScore = s; bestKey = [kx, ky]; }
    }
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < offs.length; i += 2) {
      const kx = Math.floor(offs[i] / tol), ky = Math.floor(offs[i + 1] / tol);
      if (Math.abs(kx - bestKey[0]) <= 1 && Math.abs(ky - bestKey[1]) <= 1) { sx += offs[i]; sy += offs[i + 1]; n++; }
    }
    const out = refine([1, 0, sx / n, 0, 1, sy / n], tgt, ref, tol, lsqTranslation);
    return out.inliers >= minInliers(ref.length, tgt.length) ? out : null;
  }

  /** Returns {m, inliers, rms} mapping target-frame pixels onto the reference, or null. */
  function align(ref, tgt, mode, tol, opt) {
    if (mode === 'none') return { m: [1, 0, 0, 0, 1, 0], inliers: 0, rms: 0 };
    if (mode === 'similarity') {
      const s = alignSimilarity(ref, tgt, tol, opt);
      if (s) return s;
    }
    return alignTranslation(ref, tgt, tol);
  }

  // ---------------------------------------------------------------- warping

  function cubicWeights(t, w) {
    const t2 = t * t, t3 = t2 * t;
    w[0] = -0.5 * t3 + t2 - 0.5 * t;
    w[1] = 1.5 * t3 - 2.5 * t2 + 1;
    w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    w[3] = 0.5 * t3 - 0.5 * t2;
  }

  /**
   * Resamples output rows [y0,y1) of a W×H frame through `inv` (output -> source).
   * src: RGBA bytes of the sub-rectangle (ox,oy,sw,sh) of the source frame.
   * out: Uint16 RGB, linear light, INVALID where the source has no data.
   */
  function warpRows(src, sw, sh, ox, oy, W, H, inv, out, outW, y0, y1, interp) {
    const a = inv[0], b = inv[1], c = inv[2], d = inv[3], e = inv[4], f = inv[5];
    const wx = new Float32Array(4), wy = new Float32Array(4);
    let o = 0;
    for (let y = y0; y < y1; y++) {
      let sx = b * y + c, sy = e * y + f;
      for (let x = 0; x < outW; x++, sx += a, sy += d, o += 3) {
        if (sx < -0.5 || sy < -0.5 || sx > W - 0.5 || sy > H - 0.5) {
          out[o] = out[o + 1] = out[o + 2] = INVALID;
          continue;
        }
        const fx = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx;
        const fy = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
        if (interp === 'nearest') {
          const lx = Math.round(fx) - ox, ly = Math.round(fy) - oy;
          if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) { out[o] = out[o + 1] = out[o + 2] = INVALID; continue; }
          const i = (ly * sw + lx) * 4;
          out[o] = LIN[src[i]] + 0.5; out[o + 1] = LIN[src[i + 1]] + 0.5; out[o + 2] = LIN[src[i + 2]] + 0.5;
          continue;
        }
        const x0 = fx | 0, yy0 = fy | 0;
        const tx = fx - x0, ty = fy - yy0;
        if (interp === 'bicubic') {
          cubicWeights(tx, wx); cubicWeights(ty, wy);
          let r = 0, g = 0, bl = 0, bad = false;
          for (let j = 0; j < 4 && !bad; j++) {
            let yy = yy0 - 1 + j;
            yy = yy < 0 ? 0 : yy > H - 1 ? H - 1 : yy;
            const ly = yy - oy;
            if (ly < 0 || ly >= sh) { bad = true; break; }
            for (let i = 0; i < 4; i++) {
              let xx = x0 - 1 + i;
              xx = xx < 0 ? 0 : xx > W - 1 ? W - 1 : xx;
              const lx = xx - ox;
              if (lx < 0 || lx >= sw) { bad = true; break; }
              const p = (ly * sw + lx) * 4, wgt = wx[i] * wy[j];
              r += LIN[src[p]] * wgt; g += LIN[src[p + 1]] * wgt; bl += LIN[src[p + 2]] * wgt;
            }
          }
          if (bad) { out[o] = out[o + 1] = out[o + 2] = INVALID; continue; }
          out[o] = r < 0 ? 0 : r > MAXV ? MAXV : r + 0.5;
          out[o + 1] = g < 0 ? 0 : g > MAXV ? MAXV : g + 0.5;
          out[o + 2] = bl < 0 ? 0 : bl > MAXV ? MAXV : bl + 0.5;
          continue;
        }
        // bilinear
        const x1 = x0 + 1 < W ? x0 + 1 : x0, yy1 = yy0 + 1 < H ? yy0 + 1 : yy0;
        const lx0 = x0 - ox, lx1 = x1 - ox, ly0 = yy0 - oy, ly1 = yy1 - oy;
        if (lx0 < 0 || ly0 < 0 || lx1 >= sw || ly1 >= sh) { out[o] = out[o + 1] = out[o + 2] = INVALID; continue; }
        const i00 = (ly0 * sw + lx0) * 4, i01 = (ly0 * sw + lx1) * 4, i10 = (ly1 * sw + lx0) * 4, i11 = (ly1 * sw + lx1) * 4;
        const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        out[o] = LIN[src[i00]] * w00 + LIN[src[i01]] * w01 + LIN[src[i10]] * w10 + LIN[src[i11]] * w11 + 0.5;
        out[o + 1] = LIN[src[i00 + 1]] * w00 + LIN[src[i01 + 1]] * w01 + LIN[src[i10 + 1]] * w10 + LIN[src[i11 + 1]] * w11 + 0.5;
        out[o + 2] = LIN[src[i00 + 2]] * w00 + LIN[src[i01 + 2]] * w01 + LIN[src[i10 + 2]] * w10 + LIN[src[i11 + 2]] * w11 + 0.5;
      }
    }
  }

  /** Source-pixel bounding box needed to render output rows [y0,y1). */
  function sourceBox(inv, W, H, outW, y0, y1, margin) {
    const pts = [[0, y0], [outW - 1, y0], [0, y1 - 1], [outW - 1, y1 - 1]];
    let x0 = Infinity, x1 = -Infinity, ya = Infinity, yb = -Infinity;
    for (const p of pts) {
      const q = applyAffine(inv, p[0], p[1]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); ya = Math.min(ya, q[1]); yb = Math.max(yb, q[1]);
    }
    const bx0 = Math.max(0, Math.floor(x0) - margin), by0 = Math.max(0, Math.floor(ya) - margin);
    const bx1 = Math.min(W - 1, Math.ceil(x1) + margin), by1 = Math.min(H - 1, Math.ceil(yb) + margin);
    if (bx1 < bx0 || by1 < by0) return null;
    return { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  }

  // ---------------------------------------------------------------- rejection

  function meanStd(a, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - mean; v += d * d; }
    return [mean, n > 1 ? Math.sqrt(v / (n - 1)) : 0];
  }

  function sigmaClip(a, n, kappa, iters) {
    for (let it = 0; it < iters && n > 3; it++) {
      const sd = meanStd(a, n)[1];
      if (sd <= 0) break;
      const med = median(a, n);
      const lo = med - kappa * sd, hi = med + kappa * sd;
      let m = 0;
      for (let i = 0; i < n; i++) { const v = a[i]; if (v >= lo && v <= hi) a[m++] = v; }
      if (m === n || m === 0) break;
      n = m;
    }
    return meanStd(a, n)[0];
  }

  function winsorizedClip(a, n, kappa, iters) {
    for (let it = 0; it < iters && n > 3; it++) {
      const med = median(a, n);
      let sd = meanStd(a, n)[1];
      if (sd <= 0) break;
      for (let w = 0; w < 6; w++) { // robust sigma from winsorized values
        const lo = med - 1.5 * sd, hi = med + 1.5 * sd;
        let s = 0, s2 = 0;
        for (let i = 0; i < n; i++) { const v = a[i] < lo ? lo : a[i] > hi ? hi : a[i]; s += v; s2 += v * v; }
        const mean = s / n;
        const sd2 = 1.134 * Math.sqrt(Math.max(0, s2 / n - mean * mean) * n / (n - 1));
        const done = Math.abs(sd2 - sd) < 5e-4 * sd;
        sd = sd2;
        if (done || sd <= 0) break;
      }
      if (sd <= 0) break;
      const lo = med - kappa * sd, hi = med + kappa * sd;
      let m = 0;
      for (let i = 0; i < n; i++) { const v = a[i]; if (v >= lo && v <= hi) a[m++] = v; }
      if (m === n || m === 0) break;
      n = m;
    }
    return meanStd(a, n)[0];
  }

  /**
   * Combines a frame-major stack (n frames × P values, Uint16, INVALID = no data).
   * Writes normalised floats to out (P) and per-pixel frame counts to cnt (P/3).
   */
  function reduceStack(stack, n, P, method, kappa, out, cnt) {
    const tmp = new Float32Array(n);
    const iters = 5;
    for (let p = 0; p < P; p++) {
      let m = 0;
      for (let k = 0, q = p; k < n; k++, q += P) {
        const v = stack[q];
        if (v !== INVALID) tmp[m++] = v;
      }
      if (p % 3 === 0) cnt[p / 3] = m;
      if (m === 0) { out[p] = 0; continue; }
      let v;
      if (m <= 2) v = m === 1 ? tmp[0] : 0.5 * (tmp[0] + tmp[1]);
      else if (method === 'median') v = median(tmp, m);
      else if (method === 'sigma') v = sigmaClip(tmp, m, kappa, iters);
      else if (method === 'winsor') v = winsorizedClip(tmp, m, kappa, iters);
      else if (method === 'max') { v = 0; for (let i = 0; i < m; i++) if (tmp[i] > v) v = tmp[i]; }
      else { v = 0; for (let i = 0; i < m; i++) v += tmp[i]; v /= m; }
      out[p] = v / MAXV;
    }
  }

  root.AstroCore = {
    INVALID, MAXV, LIN, LIN01, encodeSrgb, luminance, select, median,
    detectStars, applyAffine, invertAffine, lsqSimilarity, align, alignSimilarity, alignTranslation,
    warpRows, sourceBox, reduceStack,
  };
}
AstroCoreInit(typeof self !== 'undefined' ? self : this);
