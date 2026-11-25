// Ink and noise measures of a drawing for the Proportions check (pixel work only; the engine itself stays pure).
//
//   DC.Ink.prepare(canvas)            -> prep { g, w, h, k, paper, dark, range, noise, noiseRel, faint, ... }  (one greyscale view, at most 640 px)
//   DC.Ink.regions(prep, points)      -> { eyes, nose, mouth, chin: { ink, edge, strong, peak }, missing: ['nose'|'mouth'|'chin'], ... }  for MediaPipe points in SOURCE px
//   DC.Ink.normalise(canvas)          -> a contrast-stretched copy of the canvas (percentile stretch), for faint but clean drawings
//   DC.Ink.shouldNormalise(prep)      -> true only when the drawing is faint AND low-noise (stretching noisy paper makes the detector worse)
//   DC.Ink.flip(canvas)               -> mirrored copy
// Numbers are relative to the drawing's own paper and darkest ink, so a pale pencil and a bold marker read alike.
// See review/proportions-engine.md ("Robustness") for how the thresholds were chosen.
(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});
  const MAX_SIDE = 640;

  const FAINT_RANGE = 120;       // paper minus the darkest ink (0-255); below this the drawing is "faint" (30% ink is about 70, 50% about 115)
  const NOISE_REL_MAX = 0.045;   // pixel noise in paper areas relative to the range; above it stretching amplifies noise, so it is skipped
  // A region counts as not drawn when it has hardly any stroke next to the noise floor (see regions()).
  const EMPTY = { strong: 0.015, peak: 0.5 };

  function view(canvas, maxSide) {
    const w0 = canvas.naturalWidth || canvas.width, h0 = canvas.naturalHeight || canvas.height, k = Math.min(1, (maxSide || MAX_SIDE) / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, c.width, c.height);
    return { c, x, kx: w0 / c.width, ky: h0 / c.height };
  }
  function grey(v) {
    const { width: w, height: h } = v.c, d = v.x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return { g, w, h };
  }
  function percentiles(g, ps) {
    const hist = new Uint32Array(256); for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    return ps.map((p) => { let a = 0; const t = g.length * p; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= t) return i; } return 255; });
  }
  function boxBlur(g, w, h, r) { // separable mean
    const t = new Float32Array(g.length), o = new Float32Array(g.length), n = 2 * r + 1;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += g[y * w + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { t[y * w + x] = s / n; s += g[y * w + Math.min(w - 1, x + r + 1)] - g[y * w + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { o[y * w + x] = s / n; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; } }
    return o;
  }

  /** One greyscale view plus the global numbers. noise: sigma of the pixel noise on blank paper (0-255 scale), from the median absolute
      difference to the 3x3 mean over paper-like pixels whose neighbourhood is flat. */
  function prepare(canvas) {
    const v = view(canvas), { g, w, h } = grey(v);
    const [p2, p10, p90] = percentiles(g, [0.02, 0.10, 0.90]);
    const paper = p90, dark = p2, range = Math.max(1, paper - dark);
    const m3 = boxBlur(g, w, h, 1), m7 = boxBlur(g, w, h, 3), res = [];
    for (let y = 3; y < h - 3; y += 2) for (let x = 3; x < w - 3; x += 2) {
      const i = y * w + x;
      if (g[i] < paper - 0.2 * range || m7[i] < paper - 0.12 * range) continue; // blank paper only
      res.push(Math.abs(g[i] - m3[i]));
    }
    res.sort((a, b) => a - b);
    const med = res.length > 50 ? res[res.length >> 1] : 0, noise = med * 1.4826 / Math.sqrt(8 / 9);
    return { g, w, h, kx: v.kx, ky: v.ky, paper, dark, range, p10, noise, noiseRel: noise / range, faint: range < FAINT_RANGE, blankPixels: res.length };
  }
  const shouldNormalise = (prep) => !!prep && prep.faint && prep.noiseRel < NOISE_REL_MAX;

  /** Percentile stretch: 0.5% darkest -> black, 99% -> white (the benchmark's definition). */
  function normalise(canvas) {
    const v = view(canvas, Math.max(canvas.width, canvas.height)), d = v.x.getImageData(0, 0, v.c.width, v.c.height), px = d.data, n = px.length / 4, g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const [lo, hi] = percentiles(g, [0.005, 0.99]);
    if (hi - lo < 8) return canvas;
    for (let i = 0; i < n; i++) { const t = Math.max(0, Math.min(255, (g[i] - lo) / (hi - lo) * 255)); px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = t; px[i * 4 + 3] = 255; }
    v.x.putImageData(d, 0, 0);
    return v.c;
  }
  function flip(canvas) {
    const w = canvas.naturalWidth || canvas.width, h = canvas.naturalHeight || canvas.height, c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.translate(w, 0); x.scale(-1, 1); x.drawImage(canvas, 0, 0); return c;
  }

  // ------------------------------------------------------------------------------------------ regions
  function boxStats(prep, x0, y0, x1, y1) {
    const { g, w, h, paper, range } = prep;
    x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0)); x1 = Math.min(w - 2, Math.ceil(x1)); y1 = Math.min(h - 2, Math.ceil(y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return { ink: 0, edge: 0, strong: 0, peak: 0, n: 0 };
    let ink = 0, edge = 0, strong = 0, n = 0, peak = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x, dk = Math.max(0, paper - g[i]) / range, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      ink += dk; edge += Math.hypot(gx, gy) / 2 / range; if (dk > 0.3) strong++; n++;
    }
    // peak: the darkest 3x3-smoothed spot, as a fraction of the range (a single thin stroke still shows)
    const sub = new Float32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let j = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sub[j++] = Math.max(0, paper - (g[y * w + x] + g[y * w + x - 1] + g[y * w + x + 1] + g[(y - 1) * w + x] + g[(y + 1) * w + x]) / 5) / range;
    for (const v of sub) if (v > peak) peak = v;
    return { ink: ink / n, edge: edge / n, strong: strong / n, peak, n };
  }
  const MPI = { eyeR: 468, eyeL: 473, cO_R: 33, cI_R: 133, cI_L: 362, cO_L: 263, upR: 159, loR: 145, upL: 386, loL: 374, noseTip: 1, noseBase: 2, alaR: 129, alaL: 358, mouthR: 61, mouthL: 291, lipU: 0, lipL: 17, chin: 152, bridge: 168 };

  /** regions(prep, points) -> per-region stroke numbers and `missing` (regions with no drawing). points: MediaPipe 478 points in source px. */
  function regions(prep, points) {
    if (!prep || !points || points.length < 468) return null;
    const P = (i) => ({ x: points[i].x / prep.kx, y: points[i].y / prep.ky });
    const e = { R: P(MPI.eyeR), L: P(MPI.eyeL) }, mid = { x: (e.R.x + e.L.x) / 2, y: (e.R.y + e.L.y) / 2 }, chin = P(MPI.chin), ec = Math.hypot(chin.x - mid.x, chin.y - mid.y);
    const mR = P(MPI.mouthR), mL = P(MPI.mouthL), lU = P(MPI.lipU), lL = P(MPI.lipL), nB = P(MPI.noseBase), nT = P(MPI.noseTip), aR = P(MPI.alaR), aL = P(MPI.alaL);
    const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
    const out = {
      ec,
      eyes: boxStats(prep, lo(P(MPI.cO_R).x, P(MPI.cO_L).x) - 0.05 * ec, lo(P(MPI.upR).y, P(MPI.upL).y) - 0.06 * ec, hi(P(MPI.cO_R).x, P(MPI.cO_L).x) + 0.05 * ec, hi(P(MPI.loR).y, P(MPI.loL).y) + 0.06 * ec),
      nose: boxStats(prep, lo(aR.x, aL.x) - 0.05 * ec, nT.y - 0.12 * ec, hi(aR.x, aL.x) + 0.05 * ec, nB.y + 0.07 * ec),
      mouth: boxStats(prep, lo(mR.x, mL.x) - 0.06 * ec, lU.y - 0.07 * ec, hi(mR.x, mL.x) + 0.06 * ec, lL.y + 0.04 * ec),
      chin: boxStats(prep, mid.x - 0.3 * ec, lL.y + 0.05 * ec, mid.x + 0.3 * ec, chin.y + 0.07 * ec),
    };
    out.missing = [];
    for (const k of ['nose', 'mouth', 'chin']) {
      const s = out[k]; s.empty = s.strong < EMPTY.strong && s.peak < EMPTY.peak; if (s.empty) out.missing.push(k);
    }
    return out;
  }

  DC.Ink = { prepare, regions, normalise, shouldNormalise, flip, boxStats, FAINT_RANGE, NOISE_REL_MAX, EMPTY };
})();
