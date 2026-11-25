// Outline engine: compares the outer outline of the subject in the reference with the lines of the drawing, after a given alignment.
// Pure functions on plain arrays (no network); only grayFromImage() touches the DOM. Method, tolerances, held-out numbers: review/proportions-body-hands-outline.md.
//
// Public API (window.DrawingCompare.Outline)
//   grayFromImage(canvasOrImage, maxSide = 512) -> gray { w, h, data: Float32Array (0..255), kx, ky }   kx, ky = source px per working px
//   maskFromSegment(seg) -> mask { w, h, data: Uint8Array, kx, ky }         from DC.Landmarks.segment() (selfie segmenter person mask)
//   lineMap(gray, opts?) -> { w, h, strength: Float32Array (0..1), ori: Float32Array (stroke direction, radians), kx, ky }   pencil strokes (blur-divide + XDoG, two scales)
//   lineRoute(gray, { seed?: {x,y} source px, maxSide }) -> { mask, ok, reason, leaked, box }   pencil strokes -> filled subject region (the "line route");
//       with `seed` (a user tap inside the subject) the region is the closed area around the tap (for cluttered images); without it, the largest filled blob.
//   contour(mask, opts?) -> { pts, normals, perimeter, height, box, area, N, kx, ky } | null    outer contour, smoothed (sigma 0.4% of height), resampled every 0.5%
//   compare(refContour, drawingLines, alignment, opts?) -> { samples, regions, items, flagged, notes, info }   normal search + robust smoothing + regions
//   analyse({ reference: { mask } | { gray }, drawing: { gray }, alignment, bodyPoints?, seed?, tolerance?, ... }) -> report
//   nameRegion(point, normal, ctx) (used by compare)
//
// Coordinates: everything returned is in SOURCE pixels of the reference image (samples, regions, polylines). The alignment maps DRAWING source px to REFERENCE
// source px: p_ref = scale * R(rotation) * p_draw + (tx, ty), the same object DC.Proportions / DC.BodyProportions / DC.HandProportions return.
// Distances: signed, in % of the reference subject's height (the bounding box height of its outline); + = the drawing's line lies OUTSIDE the reference outline.
// Samples on the image frame (within 1.5% of an image border) and strokes within 2% of the drawing's border are ignored.
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const DC = root.DrawingCompare = root.DrawingCompare || {};

  const TOLERANCE = { outline: 8 };           // % of subject height, Usual: smallest value with <= 5% of natural CUFS pairs (calibration half) showing any band; the spec's 3% flags 53% of natural pairs
  const TOLERANCE_TUNED = {};
  const TOLERANCE_PRESETS = { strict: 0.72, usual: 1, relaxed: 2 };
  const SEARCH = 0.12, STEP = 0.0025, MIN_REGION = 0.02, MAX_REGIONS = 6, FRAME = 0.015;

  // ------------------------------------------------------------------------------------------ image helpers
  function grayFromImage(src, maxSide) {
    const w0 = src.naturalWidth || src.videoWidth || src.width, h0 = src.naturalHeight || src.videoHeight || src.height, k = Math.min(1, (maxSide || 512) / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data, g = new Float32Array(c.width * c.height);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
    return { w: c.width, h: c.height, data: g, kx: w0 / c.width, ky: h0 / c.height };
  }
  const maskFromSegment = seg => seg && seg.mask ? { w: seg.width, h: seg.height, data: seg.mask, kx: seg.kx, ky: seg.ky } : null;

  function boxPass(src, dst, w, h, r, horiz) {
    const n = horiz ? w : h, m = horiz ? h : w, st = horiz ? 1 : w, line = horiz ? w : 1, k = 1 / (2 * r + 1);
    for (let j = 0; j < m; j++) { const base = j * line; let acc = 0; for (let i = -r; i <= r; i++) acc += src[base + Math.min(n - 1, Math.max(0, i)) * st]; for (let i = 0; i < n; i++) { dst[base + i * st] = acc * k; acc += src[base + Math.min(n - 1, i + r + 1) * st] - src[base + Math.max(0, i - r) * st]; } }
  }
  function blur(g, w, h, sigma) { // three box passes ~ gaussian
    if (sigma < 0.5) return Float32Array.from(g);
    const r = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1) / 2 - 0.5)); let a = Float32Array.from(g), b = new Float32Array(g.length);
    for (let p = 0; p < 3; p++) { boxPass(a, b, w, h, r, true); boxPass(b, a, w, h, r, false); } return a;
  }
  function bilinear(a, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
    return (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
  }
  function percentile(arr, p) { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))]; }

  // ------------------------------------------------------------------------------------------ drawing lines
  /** lineMap(gray, opts) -> { strength (0..1), ori, w, h, kx, ky }. Grey, divide by a large blur (removes paper tone and soft shading), difference of Gaussians
      at two scales (XDoG-like soft threshold), drop strokes shorter than opts.minStroke px (default 1.5% of the long side), clear the image frame (2%). */
  function lineMap(gray, opts) {
    const o = Object.assign({ frame: 0.02, minStroke: null }, opts || {}), { w, h, data } = gray, n = w * h, big = Math.max(w, h);
    const bl = blur(data, w, h, big * 0.04), dark = new Float32Array(n);
    for (let i = 0; i < n; i++) dark[i] = Math.max(0, 1 - data[i] / Math.max(8, bl[i]));
    const s1 = Math.max(0.8, big / 640), d1 = blur(dark, w, h, s1), d2 = blur(dark, w, h, s1 * 1.6), d3 = blur(dark, w, h, s1 * 3.2), rid = new Float32Array(n);
    for (let i = 0; i < n; i++) rid[i] = Math.max(0, Math.max(d1[i] - d2[i], (d2[i] - d3[i]) * 1.2));
    const scale = Math.max(1e-6, percentile(rid, 0.985)), strength = new Float32Array(n), mg = Math.round(big * o.frame);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; let v = rid[i] / scale; v = v < 0.12 ? 0 : Math.min(1, (v - 0.12) / 0.5); if (x < mg || y < mg || x >= w - mg || y >= h - mg) v = 0; strength[i] = v; }
    // remove short strokes (connected components of strength > 0.25 smaller than minStroke px)
    const minPx = o.minStroke !== null ? o.minStroke : Math.max(4, big * 0.015), lab = new Int32Array(n), q = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (strength[s] <= 0.25 || lab[s]) continue; let qh = 0, qt = 0; q[qt++] = s; lab[s] = s + 1;
      while (qh < qt) { const p = q[qh++], x = p % w, y = (p / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const pp = yy * w + xx; if (strength[pp] > 0.25 && !lab[pp]) { lab[pp] = s + 1; q[qt++] = pp; } } }
      if (qt < minPx) for (let i = 0; i < qt; i++) strength[q[i]] = 0;
    }
    // stroke direction: structure tensor of the blurred darkness
    const g = blur(dark, w, h, 1.5), jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w]; jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy; }
    const sxx = blur(jxx, w, h, 2.5), syy = blur(jyy, w, h, 2.5), sxy = blur(jxy, w, h, 2.5), ori = new Float32Array(n);
    for (let i = 0; i < n; i++) ori[i] = 0.5 * Math.atan2(2 * sxy[i], sxx[i] - syy[i]) + Math.PI / 2; // along the line
    return { w, h, strength: blur(strength, w, h, 0.7), ori, kx: gray.kx || 1, ky: gray.ky || 1 };
  }

  // ------------------------------------------------------------------------------------------ mask operations
  function ccLargest(m, w, h) {
    const lab = new Int32Array(w * h), q = new Int32Array(w * h); let best = 0, bestId = 0, id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || lab[s]) continue; id++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = id;
      while (qh < qt) { const p = q[qh++], x = p % w, y = (p / w) | 0; if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; q[qt++] = p - 1; } if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; q[qt++] = p + 1; } if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = id; q[qt++] = p - w; } if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = id; q[qt++] = p + w; } }
      if (qt > best) { best = qt; bestId = id; }
    }
    const o = new Uint8Array(w * h); if (bestId) for (let i = 0; i < w * h; i++) if (lab[i] === bestId) o[i] = 1; return o;
  }
  function fillHoles(m, w, h) {
    const bg = new Uint8Array(w * h), q = new Int32Array(w * h); let qt = 0, qh = 0; const push = p => { if (!m[p] && !bg[p]) { bg[p] = 1; q[qt++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); } for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (qh < qt) { const p = q[qh++], x = p % w, y = (p / w) | 0; if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w); }
    const o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = bg[i] ? 0 : 1; return o;
  }
  function morph(m, w, h, r, dilate) {
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let cnt = 0; const row = y * w; for (let x = -r; x <= r; x++) if (x >= 0 && x < w && m[row + x]) cnt++; for (let x = 0; x < w; x++) { const full = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1; t[row + x] = dilate ? (cnt > 0 ? 1 : 0) : (cnt === full ? 1 : 0); const a = x + r + 1, b = x - r; if (a < w && m[row + a]) cnt++; if (b >= 0 && m[row + b]) cnt--; } }
    for (let x = 0; x < w; x++) { let cnt = 0; for (let y = -r; y <= r; y++) if (y >= 0 && y < h && t[y * w + x]) cnt++; for (let y = 0; y < h; y++) { const full = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1; o[y * w + x] = dilate ? (cnt > 0 ? 1 : 0) : (cnt === full ? 1 : 0); const a = y + r + 1, b = y - r; if (a < h && t[a * w + x]) cnt++; if (b >= 0 && t[b * w + x]) cnt--; } }
    return o;
  }
  const bboxOf = (m, w, h) => { let x0 = w, y0 = h, x1 = -1, y1 = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; };

  /** lineRoute(gray, opts) -> { ok, mask: { w, h, data, kx, ky }, box, leaked, reason }  pencil strokes -> closed region -> filled subject mask.
      opts.seed: {x, y} in SOURCE px of this image (a tap inside the subject): the region is the closed area around the tap. */
  function lineRoute(gray, opts) {
    const o = opts || {}, { w, h, data } = gray, n = w * h, big = Math.max(w, h), bl = blur(data, w, h, big * 0.04), st = new Uint8Array(n), mg = Math.round(big * 0.03);
    for (let i = 0; i < n; i++) { const x = i % w, y = (i / w) | 0; st[i] = (data[i] / Math.max(1, bl[i]) < 0.82 && data[i] < 235 && x > mg && y > mg && x < w - mg && y < h - mg) ? 1 : 0; }
    const finish = (m, leaked, reason) => { const box = m ? bboxOf(m, w, h) : null; return { ok: !!box, mask: box ? { w, h, data: m, kx: gray.kx || 1, ky: gray.ky || 1 } : null, box, leaked: !!leaked, reason: box ? null : (reason || 'no subject found') }; };
    let r = Math.max(2, Math.round(big * 0.018));
    if (o.seed) {
      const sx = Math.round(o.seed.x / (gray.kx || 1)), sy = Math.round(o.seed.y / (gray.ky || 1));
      for (let attempt = 0; attempt < 4; attempt++, r = Math.round(r * 1.5)) {
        const dl = morph(st, w, h, r, true); let p0 = -1;
        for (let rad = 0; rad < 40 && p0 < 0; rad++) for (let dy = -rad; dy <= rad && p0 < 0; dy++) for (let dx = -rad; dx <= rad; dx++) { const x = sx + dx, y = sy + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue; if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue; if (!dl[y * w + x]) { p0 = y * w + x; break; } }
        if (p0 < 0) continue;
        const reg = new Uint8Array(n), q = new Int32Array(n); let qh = 0, qt = 0, touches = false; q[qt++] = p0; reg[p0] = 1;
        while (qh < qt) { const p = q[qh++], x = p % w, y = (p / w) | 0; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true; for (const pp of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (pp >= 0 && !dl[pp] && !reg[pp]) { reg[pp] = 1; q[qt++] = pp; } }
        if (touches || qt > 0.85 * n) continue; // the outline leaks: close the gaps harder
        const m = morph(reg, w, h, r, true); // the free space is r smaller than the drawn region on every side
        return finish(fillHoles(m, w, h), false);
      }
      return finish(null, true, 'the outline around the tap is not closed');
    }
    const dl = morph(st, w, h, r, true), fg = fillHoles(dl, w, h), er = morph(fg, w, h, r, false);
    return finish(fillHoles(ccLargest(er, w, h), w, h), false);
  }

  // ------------------------------------------------------------------------------------------ contour
  const N8 = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  function traceOuter(m, w, h) { // Moore-neighbour tracing, clockwise on screen
    let s = -1; for (let i = 0; i < w * h; i++) if (m[i]) { s = i; break; } if (s < 0) return [];
    const sx = s % w, sy = (s / w) | 0, at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    const pts = [[sx, sy]]; let cx = sx, cy = sy, k = 0, first = null; // k: direction from c to the backtrack (west, background)
    for (let guard = 0; guard < 8 * w * h; guard++) {
      let moved = false;
      for (let i = 1; i <= 8; i++) {
        const d = (k + i) % 8, nx = cx + N8[d][0], ny = cy + N8[d][1];
        if (at(nx, ny)) {
          const pd = (k + i - 1) % 8, bx = cx + N8[pd][0], by = cy + N8[pd][1], dirs = N8.findIndex(v => v[0] === bx - nx && v[1] === by - ny);
          if (!first) first = [nx, ny]; else if (cx === sx && cy === sy && nx === first[0] && ny === first[1]) return pts;
          cx = nx; cy = ny; k = dirs < 0 ? 0 : dirs; pts.push([cx, cy]); moved = true; break;
        }
      }
      if (!moved) return pts;
    }
    return pts;
  }
  /** contour(mask, opts) -> { pts: [{x,y}] (mask px), normals: [{x,y}] (outward, unit), perimeter, height, box, area, N, kx, ky } | null.
      The largest blob with its holes filled; boundary traced, smoothed with a circular Gaussian (sigma = opts.smooth * height, default 0.4%), resampled every opts.step * height (0.5%). */
  function contour(mask, opts) {
    const o = Object.assign({ smooth: 0.004, step: 0.005, clean: true }, opts || {}), { w, h } = mask;
    const m = o.clean ? fillHoles(ccLargest(mask.data, w, h), w, h) : mask.data, box = bboxOf(m, w, h); if (!box || box.h < 8) return null;
    const raw = traceOuter(m, w, h); if (raw.length < 12) return null;
    const H = box.h, sigma = Math.max(0.8, o.smooth * H), step = Math.max(0.7, o.step * H);
    // arc-length parametrisation, resample at 1 px, circular gaussian
    const P = raw.map(p => ({ x: p[0] + 0.5, y: p[1] + 0.5 })), n0 = P.length, cum = [0];
    for (let i = 1; i <= n0; i++) cum.push(cum[i - 1] + Math.hypot(P[i % n0].x - P[i - 1].x, P[i % n0].y - P[i - 1].y));
    const L = cum[n0], M = Math.max(16, Math.round(L)), uni = []; let j = 0;
    for (let i = 0; i < M; i++) { const t = i / M * L; while (cum[j + 1] < t) j++; const f = (t - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]), a = P[j], b = P[(j + 1) % n0]; uni.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }); }
    const half = Math.ceil(sigma * 3), ker = []; let ks = 0; for (let i = -half; i <= half; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); ker.push(v); ks += v; }
    const sm = uni.map((_, i) => { let x = 0, y = 0; for (let k = -half; k <= half; k++) { const p = uni[((i + k) % M + M) % M]; x += p.x * ker[k + half]; y += p.y * ker[k + half]; } return { x: x / ks, y: y / ks }; });
    const N = Math.max(16, Math.round(L / step)), pts = [];
    for (let i = 0; i < N; i++) pts.push(sm[Math.min(M - 1, Math.round(i / N * M))]);
    let area2 = 0; for (let i = 0; i < N; i++) { const a = pts[i], b = pts[(i + 1) % N]; area2 += a.x * b.y - b.x * a.y; }
    const sgn = area2 >= 0 ? 1 : -1, normals = pts.map((_, i) => { const a = pts[(i - 2 + N) % N], b = pts[(i + 2) % N], tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1; return { x: sgn * ty / l, y: -sgn * tx / l }; });
    // make sure the normals point outwards: test one point
    const t0 = pts[0], n0v = normals[0], px = Math.round(t0.x + n0v.x * 3), py = Math.round(t0.y + n0v.y * 3);
    if (px >= 0 && py >= 0 && px < w && py < h && m[py * w + px]) for (const nv of normals) { nv.x = -nv.x; nv.y = -nv.y; }
    let area = 0; for (let i = 0; i < w * h; i++) area += m[i];
    return { pts, normals, perimeter: L, height: H, box, area, N, kx: mask.kx || 1, ky: mask.ky || 1, w, h };
  }

  // ------------------------------------------------------------------------------------------ naming
  const PRIM_SEGMENTS = [['head', 'headTop', 'chin'], ['neck', 'chin', 'neck'], ['shoulder', 'neck', 'shoulder*'], ['upperArm', 'shoulder*', 'elbow*'], ['forearm', 'elbow*', 'wrist*'], ['side', 'shoulder*', 'hip*'], ['thigh', 'hip*', 'knee*'], ['shin', 'knee*', 'ankle*']];
  const PRIM_JOINTS = [['elbow', 'elbow*'], ['knee', 'knee*'], ['hip', 'hip*'], ['shoulder', 'shoulder*']];
  const POSITIONS = ['right', 'lower_right', 'bottom', 'lower_left', 'left', 'upper_left', 'top', 'upper_right']; // 45 degree sectors, east first, clockwise on screen
  const distSeg = (p, a, b) => { const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy, t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0; return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t); };
  /** nameRegion(point, normal, ctx) -> { part, side, position, by: 'body'|'position' } . ctx: { body: fs.points (reference source px, names as in BodyProportions) | null, box: {x,y,w,h} subject box (source px) } */
  function nameRegion(p, nrm, ctx) {
    const B = ctx.body, box = ctx.box, ang = Math.atan2(p.y - (box.y + box.h / 2), (p.x - (box.x + box.w / 2)) * (box.h / Math.max(1, box.w)));
    const position = POSITIONS[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8], out = { part: null, side: null, position, by: 'position' };
    if (!B || !(B.shoulderL || B.shoulderR) || !(B.hipL || B.hipR || B.headTop)) return out;
    let best = null; const consider = (part, side, d, w) => { const dd = d * w; if (!best || dd < best.d) best = { part, side, d: dd }; };
    const pt = (n, s) => B[n.replace('*', s || '')] || null;
    for (const s of ['R', 'L']) {
      for (const [part, a, b] of PRIM_SEGMENTS) { const A = pt(a, s), Bp = pt(b, s); if (A && Bp && (part !== 'head' && part !== 'neck' || s === 'R')) consider(part, part === 'head' || part === 'neck' ? null : s, distSeg(p, A, Bp), part === 'head' ? 0.9 : 1); }
      for (const [part, a] of PRIM_JOINTS) { const A = pt(a, s); if (A) consider(part, s, Math.hypot(p.x - A.x, p.y - A.y), 0.8); }
      const w = pt('wrist*', s), e = pt('elbow*', s); if (w && e) { const ext = { x: w.x + (w.x - e.x) * 0.45, y: w.y + (w.y - e.y) * 0.45 }; consider('hand', s, distSeg(p, w, ext), 0.95); }
      const an = pt('ankle*', s), toe = pt('toe*', s), kn = pt('knee*', s); if (an) { const e2 = toe || (kn ? { x: an.x + (an.x - kn.x) * 0.3, y: an.y + (an.y - kn.y) * 0.3 } : an); consider('foot', s, distSeg(p, an, e2), 0.95); }
    }
    if (!best) return out;
    const res = { part: best.part, side: best.side ? sideName(best.side) : null, position, by: 'body' };
    if (best.part === 'head' && B.headTop && B.chin) { const hh = Math.hypot(B.headTop.x - B.chin.x, B.headTop.y - B.chin.y) || 1, up = { x: B.headTop.x - B.chin.x, y: B.headTop.y - B.chin.y }, along = ((p.x - B.chin.x) * up.x + (p.y - B.chin.y) * up.y) / (hh * hh); if (along > 0.8 && (nrm.x * up.x + nrm.y * up.y) / hh > 0.5) res.part = 'top_of_head'; }
    return res;
  }
  const sideName = s => s === 'L' ? 'left' : 'right';

  // ------------------------------------------------------------------------------------------ comparison
  function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; }
  const tolFactor = t => typeof t === 'number' ? t : (TOLERANCE_PRESETS[t || 'usual'] || 1);

  /** compare(refContour, drawingLines, alignment, opts) -> { ok, samples, regions, items, flagged, notes, info }
      refContour: from contour() of the REFERENCE (mask or line route), in its working px; drawingLines: from lineMap() of the DRAWING; alignment: drawing source px -> reference source px.
      opts: { tolerance: 'usual'|'strict'|'relaxed'|factor, tolerances: {outline: v}, bodyPoints, search: 0.12, imageSize: {w,h} (reference working size, for the frame test) }
      sample: { i, ref: {x,y}, d (signed % of height, + outside), found, frame, strength, match: {x,y} (reference source px) }
      region: { from, to (sample indexes, may wrap), sign (+1 outside / -1 inside), peak: {d, i, ref, match}, mean, extent (fraction of the perimeter), area, name: {part, side, position, by}, band: { reference: [{x,y}], drawing: [{x,y}] } }
      item: { key, family: 'outline', section: 'outline', unit: '%', value (signed peak), tolerance, flagged, severity, part, side, position, approximate, sentence: { key, n, part, side, position }, region, rankScore }
      notes: [{ key: 'outline_not_followed', part, side, position }] for stretches over 10% of the perimeter with no matching stroke. */
  function compare(C, L, al, opts) {
    const o = Object.assign({ tolerance: 'usual', search: SEARCH }, opts || {});
    if (!C || !L || !al || !al.ok) return { ok: false, reason: 'missing contour, drawing lines or alignment', samples: [], regions: [], items: [], flagged: [], notes: [] };
    const kxr = C.kx, kyr = C.ky, Hs = C.height * kyr, N = C.N, W = o.search * C.height, step = Math.max(0.5, STEP * C.height), K = Math.floor(W / step), S = 2 * K + 1;
    const factor = tolFactor(o.tolerance), tolT = Object.assign({}, TOLERANCE, TOLERANCE_TUNED, o.tolerances || {}), tol = tolT.outline * factor;
    const cs = Math.cos(al.rotation), sn = Math.sin(al.rotation), invS = 1 / al.scale;
    // reference source px -> drawing working px
    const toDraw = (x, y) => { const px = (x - al.tx) * invS, py = (y - al.ty) * invS; return { x: (cs * px + sn * py) / L.kx, y: (-sn * px + cs * py) / L.ky }; };
    const dirToDraw = (x, y) => { const px = x * invS, py = y * invS; return { x: (cs * px + sn * py), y: (-sn * px + cs * py) }; };
    const fw = o.imageSize ? o.imageSize.w : C.w, fh = o.imageSize ? o.imageSize.h : C.h, fm = FRAME * Math.max(fw, fh);
    const sample = new Float32Array(N * S), pos = [];
    const frame = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const p = C.pts[i], nrm = C.normals[i], tn = { x: -nrm.y, y: nrm.x };
      frame[i] = p.x < fm || p.y < fm || p.x > fw - fm || p.y > fh - fm ? 1 : 0;
      const tg = dirToDraw(tn.x * kxr, tn.y * kyr), tAng = Math.atan2(tg.y, tg.x);
      for (let s = 0; s < S; s++) {
        const dd = (s - K) * step, qx = (p.x + nrm.x * dd) * kxr, qy = (p.y + nrm.y * dd) * kyr, q = toDraw(qx, qy);
        const st = bilinear(L.strength, L.w, L.h, q.x, q.y);
        if (st <= 0.02) { sample[i * S + s] = 0; continue; }
        const ix = Math.round(q.x), iy = Math.round(q.y), a = ix >= 0 && iy >= 0 && ix < L.w && iy < L.h ? L.ori[iy * L.w + ix] : 0;
        let dl = Math.abs(a - tAng) % Math.PI; if (dl > Math.PI / 2) dl = Math.PI - dl;
        sample[i * S + s] = st * (dl <= 0.61 ? 1 : 0.25) * (1 - 0.35 * Math.abs(s - K) / K);
      }
    }
    // Circular Viterbi: run over N + 2*OV samples (wrapped modulo N) and read out the steady-state middle N samples.
    const NS = S + 1, MU = 0.2 * step / C.height * 100, TAU = 0.15, ENTER = 0.2, OV = Math.min(20, Math.floor(N / 4)), M = N + 2 * OV;
    const cost = new Float32Array(M * NS), back = new Int16Array(M * NS);
    for (let m = 0; m < M; m++) {
      const i = (m - OV + N) % N;
      for (let s = 0; s < NS; s++) {
        const em = s === S ? -TAU : -sample[i * S + s]; let best = 1e9, arg = 0;
        if (m === 0) { best = 0; } else {
          const prev = (m - 1) * NS;
          if (s === S) { for (let t = 0; t < NS; t++) { const c = cost[prev + t] + (t === S ? 0 : ENTER); if (c < best) { best = c; arg = t; } } }
          else { const lo = Math.max(0, s - 14), hi = Math.min(S - 1, s + 14); let c0 = cost[prev + S] + ENTER; best = c0; arg = S; for (let t = lo; t <= hi; t++) { const c = cost[prev + t] + MU * Math.abs(t - s); if (c < best) { best = c; arg = t; } } }
        }
        cost[m * NS + s] = best + em; back[m * NS + s] = arg;
      }
    }
    let bs = 0, bc = 1e9; for (let s = 0; s < NS; s++) if (cost[(M - 1) * NS + s] < bc) { bc = cost[(M - 1) * NS + s]; bs = s; }
    const state = new Int16Array(N), costs = new Float32Array(N);
    for (let m = M - 1; m >= 0; m--) { if (m >= OV && m < OV + N) { const i = m - OV; state[i] = bs; costs[i] = cost[m * NS + bs]; } bs = back[m * NS + bs]; }
    // samples
    const raw = new Float32Array(N), found = new Uint8Array(N);
    for (let i = 0; i < N; i++) { found[i] = state[i] !== S && !frame[i] ? 1 : 0; raw[i] = found[i] ? (state[i] - K) * step / C.height * 100 : NaN; }
    // running median over 3% of the perimeter (found samples only), circular
    const win = Math.max(2, Math.round(0.015 * N)), d = new Float32Array(N);
    for (let i = 0; i < N; i++) { if (!found[i]) { d[i] = NaN; continue; } const v = []; for (let k = -win; k <= win; k++) { const j = ((i + k) % N + N) % N; if (found[j]) v.push(raw[j]); } d[i] = median(v); }
    const samples = []; for (let i = 0; i < N; i++) { const p = C.pts[i], nrm = C.normals[i], dd = Number.isFinite(d[i]) ? d[i] : null; samples.push({ i, ref: { x: p.x * kxr, y: p.y * kyr }, d: dd, found: dd !== null, frame: !!frame[i], strength: dd !== null ? -costs[i] : 0, match: dd !== null ? { x: (p.x + nrm.x * dd / 100 * C.height) * kxr, y: (p.y + nrm.y * dd / 100 * C.height) * kyr } : null }); }
    // style-adaptive tolerance: when a drawing has higher baseline contour noise (stylised sketches), lift the effective tolerance so faithful stylised drawings aren't over-flagged
    const foundAbs = samples.filter(s => s.found).map(s => Math.abs(s.d));
    const medAbs = median(foundAbs) || 0;
    const styleMode = o.style || 'auto';
    const effTol = styleMode === 'realistic' ? tol : styleMode === 'stylised' ? Math.max(tol * 1.35, 4.2 * medAbs) : Math.max(tol, 3.8 * medAbs);
    // regions: runs of |d| > effTol with one sign, gaps of up to 1% of the perimeter bridged, at least 2% of the perimeter long
    const gapMax = Math.max(1, Math.round(0.01 * N)), minLen = Math.max(3, Math.round(MIN_REGION * N)), over = i => samples[i].found && Math.abs(samples[i].d) > effTol;
    let start0 = 0; for (let i = 0; i < N; i++) if (!over(i)) { start0 = i; break; } // rotate so a run does not wrap
    const regions = []; let cur = null, gap = 0;
    const close = () => { if (!cur) return; while (gap > 0 && cur.idx.length && !over(cur.idx[cur.idx.length - 1])) { cur.idx.pop(); gap--; } if (cur.idx.length >= minLen) regions.push(cur); cur = null; gap = 0; };
    for (let k = 0; k < N; k++) {
      const i = (start0 + k) % N, ov = over(i), sg = ov ? Math.sign(samples[i].d) : 0;
      if (ov) { if (cur && cur.sign !== sg) close(); if (!cur) cur = { sign: sg, idx: [] }; cur.idx.push(i); gap = 0; }
      else if (cur) { gap++; if (gap > gapMax || !samples[i].found && gap > gapMax) { close(); } else cur.idx.push(i); }
    }
    close();
    const ctx = { body: o.bodyPoints || null, box: { x: C.box.x * kxr, y: C.box.y * kyr, w: C.box.w * kxr, h: C.box.h * kyr } };
    const regs = regions.map(r => {
      const idx = r.idx, vals = idx.map(i => samples[i].d).filter(v => v !== null), ab = vals.map(Math.abs); let pk = idx[0], pv = 0; for (const i of idx) if (samples[i].found && Math.abs(samples[i].d) > pv) { pv = Math.abs(samples[i].d); pk = i; }
      // robust peak: median of the three largest, so one stray stroke does not set the number
      const top = ab.slice().sort((a, b) => b - a).slice(0, 3), peakVal = r.sign * median(top);
      const meanAbs = ab.reduce((s, v) => s + v, 0) / Math.max(1, ab.length);
      const nrm = C.normals[pk], name = nameRegion(samples[pk].ref, nrm, ctx);
      return { from: idx[0], to: idx[idx.length - 1], sign: r.sign, peak: { d: peakVal, i: pk, ref: samples[pk].ref, match: samples[pk].match }, mean: r.sign * meanAbs, extent: idx.length / N, area: ab.reduce((s, v) => s + v, 0) / N, name,
        band: { reference: idx.map(i => samples[i].ref), drawing: idx.map(i => samples[i].match || samples[i].ref) } };
    }).filter(r => Math.abs(r.mean) >= 0.65 * effTol).sort((a, b) => Math.abs(b.peak.d) * b.extent - Math.abs(a.peak.d) * a.extent);
    // items
    const items = regs.slice(0, MAX_REGIONS).map((r, n) => {
      const nm = r.name, v = r.peak.d, a = Math.abs(v), disp = (() => { let rr = Math.round(a); if (a > effTol && rr <= effTol) rr = Math.floor(effTol) + 1; return rr; })(), out = v > 0;
      const top = nm.part === 'top_of_head', key = top ? (out ? 'top_of_head_too_high' : 'top_of_head_too_low') : 'outline_' + (out ? 'too_far_out' : 'too_far_in');
      const hv = Math.abs(v) / effTol;
      return { key: 'outline_' + n, family: 'outline', section: 'outline', kind: 'outline', unit: '%', value: v, raw: v, tolerance: effTol, flagged: true, locked: false, approximate: false, severity: a >= 2 * effTol ? 'major' : 'minor', side: nm.side, part: nm.part, position: nm.position, by: nm.by, points: [], span: null, arrows: [], groupedUnder: null, reliability: 'exact',
        sentence: { key, n: disp, part: nm.by === 'body' ? nm.part : null, side: nm.by === 'body' ? nm.side : null, position: nm.by === 'body' ? null : nm.position }, region: r, rankScore: hv * 0.8 };
    });
    // gaps: stretches with no matching stroke
    const notes = []; { let run = []; const flush = () => { if (run.length >= 0.1 * N) { const mid = samples[run[run.length >> 1]], nm = nameRegion(mid.ref, C.normals[run[run.length >> 1]], ctx); notes.push({ key: 'outline_not_followed', part: nm.by === 'body' ? nm.part : null, side: nm.by === 'body' ? nm.side : null, position: nm.position, extent: run.length / N, from: run[0], to: run[run.length - 1] }); } run = []; };
      for (let k = 0; k < N; k++) { const i = (start0 + k) % N; if (!samples[i].found && !samples[i].frame) run.push(i); else flush(); } flush(); }
    const nf = samples.filter(s => !s.frame), foundShare = nf.length ? nf.filter(s => s.found).length / nf.length : 0;
    return { ok: true, samples, regions: regs, items, flagged: items.slice(), notes, info: { tolerance: effTol, baseTolerance: tol, medAbs, style: styleMode, tolerancePreset: factor, subjectHeightPx: Hs, perimeterPx: C.perimeter * kxr, foundShare, samples: N, maxAbs: Math.max(0, ...samples.filter(s => s.found).map(s => Math.abs(s.d))) },
      tolerance: { factor, base: tolT } };
  }

  /** analyse(opts) -> report { ok, reason, contour, drawingLines, mask, ...compare() }
      opts: { reference: { mask } | { gray } (a mask from the selfie segmenter, or a gray reference drawn with lines: line route), drawing: { gray } | { lines },
              alignment, bodyPoints, seed: { reference?: {x,y}, drawing?: {x,y} } (taps in each image's source px, for cluttered images), tolerance, tolerances, search }
      The reference outline comes from the mask when given, else from the line route of the reference gray (with its seed). */
  function analyse(o) {
    let mask = o.reference && o.reference.mask, route = null;
    if (!mask && o.reference && o.reference.gray) { route = lineRoute(o.reference.gray, { seed: o.seed && o.seed.reference }); if (!route.ok) return { ok: false, reason: route.reason || 'no reference outline', needsSeed: !(o.seed && o.seed.reference) }; mask = route.mask; }
    if (!mask) return { ok: false, reason: 'no reference mask or image' };
    const C = contour(mask); if (!C) return { ok: false, reason: 'no reference contour' };
    const lines = o.drawing && (o.drawing.lines || (o.drawing.gray && lineMap(o.drawing.gray)));
    if (!lines) return { ok: false, reason: 'no drawing image' };
    const rep = compare(C, lines, o.alignment, { tolerance: o.tolerance, tolerances: o.tolerances, style: o.style, bodyPoints: o.bodyPoints, search: o.search, imageSize: { w: mask.w, h: mask.h } });
    return Object.assign(rep, { contour: C, mask, route });
  }

  /** edgeAgreement(contour, lines) -> fraction (0..1) of the contour samples that have a stroke within 1.5% of the height (is a segmenter mask trustworthy on this image?). */
  function edgeAgreement(C, L) {
    if (!C || !L) return 0; let hit = 0; const r = Math.max(2, 0.015 * C.height);
    for (let i = 0; i < C.N; i++) { const p = C.pts[i], nrm = C.normals[i]; let ok = false; for (let d = -r; d <= r && !ok; d += 1) if (bilinear(L.strength, L.w, L.h, (p.x + nrm.x * d) * C.kx / L.kx, (p.y + nrm.y * d) * C.ky / L.ky) > 0.25) ok = true; if (ok) hit++; }
    return hit / C.N;
  }

  DC.Outline = { grayFromImage, maskFromSegment, lineMap, lineRoute, contour, compare, analyse, nameRegion, edgeAgreement, TOLERANCE, TOLERANCE_TUNED, TOLERANCE_PRESETS, POSITIONS, SEARCH,
    _ops: { ccLargest, fillHoles, morph, bboxOf, blur, traceOuter } };
})();
