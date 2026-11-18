// Proportions engine: pure functions (no DOM, no network) that turn two sets of face landmarks into
// per-feature proportion / placement discrepancies, an alignment, and a distortion grid.
// See review/proportions-engine.md for the method, tolerances, bias table and limitations.
//
// Public API (window.DrawingCompare.Proportions):
//   features(points, source)            named landmark set from a detector's raw points
//   fromPoints(named, source)           same, from hand-placed named points (manual mode)
//   resolve(fs)                         primary + derived points (eyeMid, mouthMid, browR, browL)
//   align(drawingFs, referenceFs, opts) similarity + frame + locked features
//   measure(drawingFs, referenceFs, alignment, opts)   report: items, flagged, close, groups, warnings
//   distortionGrid(drawingFs, referenceFs, alignment, {cols, rows})
//   analyse(drawingFace, referenceFace, opts)           features + align + measure (+ grid) in one call
//   apply / invert / toLayerTransform   helpers for the alignment similarity
//
// Conventions
//   * Pixel coordinates are the source image's own (origin top-left, y down).
//   * Names with R / L are the SUBJECT'S OWN right / left: the subject's right eye is on the image's left.
//   * Similarity maps drawing -> reference: p_ref = scale * R(rotation) * p_draw + (tx, ty);
//     rotation is radians, positive = clockwise on screen (same as Layer.angle), 0 unless matchTilt.
//   * All discrepancies are "drawing minus reference", in % of the REFERENCE's eye-mid-to-chin distance (EC),
//     measured in a frame rotated so each face's midline (nose base, mouth, chin) is vertical.
//   * Tilt is in degrees, positive = clockwise on screen.
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const DC = root.DrawingCompare = root.DrawingCompare || {};

  // ------------------------------------------------------------------------------------------ landmark indices
  // MediaPipe Face Landmarker (478 points). R = subject's right = image left.
  const MP = {
    eyeR: 468, eyeL: 473,                                   // iris centres
    eyeCornerOuterR: 33, eyeCornerInnerR: 133, eyeCornerInnerL: 362, eyeCornerOuterL: 263,
    eyelidUpperR: 159, eyelidLowerR: 145, eyelidUpperL: 386, eyelidLowerL: 374,
    browOuterR: 70, browMidR: 105, browInnerR: 107, browInnerL: 336, browMidL: 334, browOuterL: 300,
    noseBridge: 168, noseTip: 1, noseBase: 2, noseAlaR: 129, noseAlaL: 358,
    mouthR: 61, mouthL: 291, lipUpper: 0, lipLower: 17,     // 0 = top of upper lip, 17 = bottom of lower lip
    chin: 152,
    jawLowR: 136, jawLowL: 365, jawHighR: 132, jawHighL: 361, cheekR: 234, cheekL: 454,
    hairline: 10,                                           // top of the forehead mesh (hairline, not the crown)
  };
  const MP_CENTRE = [13, 14];                               // inner lips: mouthCentre = mean
  // face-api.js 68 points (jaw 0-16, brows 17-26, nose 27-35, eyes 36-47, mouth 48-67).
  const FA = {
    eyeCornerOuterR: 36, eyeCornerInnerR: 39, eyeCornerInnerL: 42, eyeCornerOuterL: 45,
    browOuterR: 17, browMidR: 19, browInnerR: 21, browInnerL: 22, browMidL: 24, browOuterL: 26,
    noseBridge: 27, noseTip: 30, noseBase: 33, noseAlaR: 31, noseAlaL: 35,
    mouthR: 48, mouthL: 54, lipUpper: 51, lipLower: 57,
    chin: 8, jawLowR: 5, jawLowL: 11, jawHighR: 3, jawHighL: 13, cheekR: 1, cheekL: 15,
  };
  const FA_EYE_R = [36, 37, 38, 39, 40, 41], FA_EYE_L = [42, 43, 44, 45, 46, 47], FA_CENTRE = [62, 66];
  const FA_LID = { eyelidUpperR: [37, 38], eyelidLowerR: [40, 41], eyelidUpperL: [43, 44], eyelidLowerL: [46, 47] };
  const PRIMARY = ['eyeR', 'eyeL', 'eyeCornerOuterR', 'eyeCornerInnerR', 'eyeCornerInnerL', 'eyeCornerOuterL',
    'eyelidUpperR', 'eyelidLowerR', 'eyelidUpperL', 'eyelidLowerL',
    'browOuterR', 'browMidR', 'browInnerR', 'browInnerL', 'browMidL', 'browOuterL',
    'noseBridge', 'noseTip', 'noseBase', 'noseAlaR', 'noseAlaL',
    'mouthR', 'mouthL', 'mouthCentre', 'lipUpper', 'lipLower', 'chin',
    'jawLowR', 'jawLowL', 'jawHighR', 'jawHighL', 'cheekR', 'cheekL', 'hairline'];

  // ------------------------------------------------------------------------------------------ tolerances and bias
  // Usual tolerance, % of EC, applied AFTER bias and gain correction. Chosen by a sweep on the planted suite (maximise detection
  // at >= 4% with controls false alarms <= 5% and unplanted false alarms on planted cases <= 5%): core 3.5, mouth width 6.5,
  // chin 7 (DECISIONS.md had 3 / 5 / 5, which were chosen before gain correction). Strict = 0.72x (controls false alarm about
  // 10%), Relaxed = 2x. Major = 2x tolerance. In-sample: tuned and scored on the same suite.
  // possibleOnly: never reported as minor/major, only 'possible' above the tolerance (detector too unreliable).
  // reliability: how much the benchmark trusts the measure on sketches (UI may show a caution).
  const TOLERANCE_PRESETS = { strict: 0.72, usual: 1, relaxed: 2 };
  const TOLERANCE = {
    eye_spacing: 3.5, eye_height_R: 3.5, eye_height_L: 3.5, eye_tilt: 3.5, nose_length: 3.5, mouth_height: 3.5,
    mouth_width: 6.5, chin_length: 7,
    jaw_width: 10, jaw_width_high: 10,
    // not covered by the planted-error benchmark; set from the natural CUFS discrepancy (p95 + margin)
    nose_width: 4, brow_height_R: 4, brow_height_L: 4,
    head_tilt: 3,                                           // degrees
  };
  // Mean detector bias on sketches: mean over the 188 CUFS pairs of (measure on the sketch's landmarks minus
  // measure on the photo's landmarks), same engine, % of EC. Subtracted before comparing. Source:
  // bench planted-*.json natBiasCorrected (mediapipe, face-api tiny) for the seven benchmarked measures;
  // the rest were measured with this engine by bench/proportions-validate.html (natural run).
  const BIAS = {
    mediapipe: { eye_spacing: 0.70, eye_height_R: -0.14, eye_height_L: -0.16, eye_tilt: 0.02, nose_length: 0.40, nose_width: 0.61,
      mouth_height: 0.35, mouth_width: 0.13, chin_length: -0.40, jaw_width: 1.18, jaw_width_high: 1.82, brow_height_R: 0.24, brow_height_L: 0.43, head_tilt: 0.17 },
    faceapi: { eye_spacing: 1.61, eye_height_R: 0, eye_height_L: 0, eye_tilt: 0.12, nose_length: 0.26, nose_width: 0,
      mouth_height: 0.64, mouth_width: 0.67, chin_length: -0.40, jaw_width: 0.74, jaw_width_high: 0, brow_height_R: 0, brow_height_L: 0, head_tilt: 0 },
  };
  // Detector gain: the detector under-follows displacements drawn into a sketch (measured / planted, median over single-error
  // planted cases >= 4%, bias-corrected). measure() divides the bias-corrected value by the gain so reported percentages match the
  // real drawn error. The correction factor is capped at MAX_GAIN_CORRECTION (so a gain below 0.5 is treated as 0.5: chin and jaw
  // stay under-reported and are 'possible'-only / weakly reliable). Estimated by bench/proportions-validate.html (PV.gains).
  const MAX_GAIN_CORRECTION = 2;
  // MediaPipe: n = 64 single-error cases per feature (eye heights 30 / 34); jaw_width_high assumed equal to jaw_width; items not
  // planted (brows, nose width, head tilt) use 1. face-api (tiny): measured on only 7 to 21 cases per feature (every 4th case),
  // so indicative; nearly all are below 0.5 and are capped at a factor of 2; eye heights use the eye_tilt gain.
  const GAIN = {
    mediapipe: { eye_spacing: 0.85, eye_height_R: 0.72, eye_height_L: 0.70, eye_tilt: 0.78, nose_length: 0.71, mouth_height: 0.76, mouth_width: 0.90, chin_length: 0.36, jaw_width: 0.31, jaw_width_high: 0.31 },
    faceapi: { eye_spacing: 0.43, eye_height_R: 0.32, eye_height_L: 0.32, eye_tilt: 0.32, nose_length: 0.66, mouth_height: 0.43, mouth_width: 0.26, chin_length: 0.08, jaw_width: 0.16, jaw_width_high: 0.16 },
  };
  // Per-detector tolerance multiplier (face-api landmarks are noisier and shrink imposed displacements).
  const DETECTOR_TOLERANCE_SCALE = { mediapipe: 1, faceapi: 1, manual: 1 };

  // ------------------------------------------------------------------------------------------ small math
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const meanPts = a => ({ x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ok = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const copy = p => ({ x: p.x, y: p.y });
  const deg = r => r * 180 / Math.PI;
  function solveLinear(A, b) { // Gauss with partial pivoting; A n x n arrays (copied), b length n
    const n = b.length, M = A.map((r, i) => r.slice().concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12;
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let c = n - 1; c >= 0; c--) { let s = M[c][n]; for (let j = c + 1; j < n; j++) s -= M[c][j] * x[j]; x[c] = s / (M[c][c] || 1e-12); }
    return x;
  }

  // ------------------------------------------------------------------------------------------ features
  function sourceOf(points, source) {
    if (source === 'mediapipe' || source === 'faceapi' || source === 'manual') return source;
    if (source === 'mp' || source === 'mp478' || source === 'mp468') return 'mediapipe';
    if (source === 'fa68' || source === 'face-api') return 'faceapi';
    if (points && points.length >= 468) return 'mediapipe';
    if (points && points.length === 68) return 'faceapi';
    throw new Error('Proportions.features: unknown landmark source (' + (points && points.length) + ' points)');
  }
  const swapSide = name => /R$/.test(name) ? name.slice(0, -1) + 'L' : /L$/.test(name) ? name.slice(0, -1) + 'R' : name;

  /** features(points, source) -> { source, flipped, points: { name: {x,y} } }
      points: detector points ({x,y} in source-image pixels); source: 'mediapipe' (478/468 points) | 'faceapi' (68), or inferred
      from the count. Names: see PRIMARY (eye centres/corners/eyelids, brow ends and middles, nose bridge/tip/base/alae,
      mouth corners/centre/upper/lower lip, chin, jaw at two heights (jawLow = near the jaw angle, jawHigh = higher up),
      cheeks, hairline (MediaPipe only; null for face-api)). If the face is mirrored (the subject's right eye on the right of the
      picture) R and L are swapped so that the names stay anatomical for the picture as shown. */
  function features(points, source) {
    const src = sourceOf(points, source), pts = {};
    const get = i => { const p = points[i]; return ok(p) ? copy(p) : null; };
    if (src === 'mediapipe') {
      for (const name of Object.keys(MP)) pts[name] = get(MP[name]);
      pts.mouthCentre = points[13] && points[14] ? mid(points[13], points[14]) : null;
    } else {
      for (const name of Object.keys(FA)) pts[name] = get(FA[name]);
      pts.eyeR = meanPts(FA_EYE_R.map(i => points[i])); pts.eyeL = meanPts(FA_EYE_L.map(i => points[i]));
      for (const k of Object.keys(FA_LID)) pts[k] = meanPts(FA_LID[k].map(i => points[i]));
      pts.mouthCentre = meanPts(FA_CENTRE.map(i => points[i]));
      pts.hairline = null;
    }
    const fs = { source: src, flipped: false, points: pts };
    if (ok(pts.eyeR) && ok(pts.eyeL) && pts.eyeR.x > pts.eyeL.x) {
      const sw = {}; for (const k of Object.keys(pts)) sw[swapSide(k)] = pts[k]; fs.points = sw; fs.flipped = true;
    }
    return fs;
  }
  /** fromPoints(named, source='manual') -> same shape as features(), from named {x,y} points (e.g. five hand-placed points:
      eyeR, eyeL, noseBase, mouthCentre, chin). Missing points are fine; items that need them are skipped. */
  function fromPoints(named, source) {
    const pts = {}; for (const k of PRIMARY) pts[k] = ok(named[k]) ? copy(named[k]) : null;
    for (const k of Object.keys(named)) if (!(k in pts) && ok(named[k])) pts[k] = copy(named[k]);
    return { source: source || 'manual', flipped: false, points: pts };
  }
  /** resolve(fs) -> all points incl. derived ones: eyeMid, mouthMid (mid of the corners; the centre if no corners), browR, browL (mean of the three). */
  function resolve(fs) {
    const p = {}; for (const k of Object.keys(fs.points)) if (ok(fs.points[k])) p[k] = fs.points[k];
    if (p.eyeR && p.eyeL) p.eyeMid = mid(p.eyeR, p.eyeL);
    if (p.mouthR && p.mouthL) p.mouthMid = mid(p.mouthR, p.mouthL); else if (p.mouthCentre) p.mouthMid = copy(p.mouthCentre);
    if (!p.noseBase && p.noseTip) p.noseBase = copy(p.noseTip);
    for (const s of ['R', 'L']) { const a = ['browOuter', 'browMid', 'browInner'].map(n => p[n + s]); if (a.every(Boolean)) p['brow' + s] = meanPts(a); }
    return p;
  }

  // ------------------------------------------------------------------------------------------ frames
  /** Frame of one face: origin = eye midpoint, rotated so the midline (eyes -> nose base, mouth, chin) is vertical, scaled by EC. */
  function frameOf(P) {
    const A = P.eyeMid; let sx = 0, sy = 0;
    for (const q of [P.noseBase, P.mouthMid, P.chin]) if (q) { sx += q.x - A.x; sy += q.y - A.y; }
    const theta = Math.atan2(sx, sy), c = Math.cos(theta), s = Math.sin(theta), ec = dist(P.chin, A);
    return { A, theta, c, s, ec };
  }
  const toN = (f, p) => { const x = p.x - f.A.x, y = p.y - f.A.y; return { x: (x * f.c - y * f.s) / f.ec, y: (x * f.s + y * f.c) / f.ec }; };
  const fromN = (f, n) => { const x = n.x * f.ec, y = n.y * f.ec; return { x: f.A.x + x * f.c + y * f.s, y: f.A.y - x * f.s + y * f.c }; };
  const FIT_NAMES = ['eyeL', 'eyeR', 'noseBase', 'mouthL', 'mouthR', 'chin', 'jawLowL', 'jawLowR'];

  // ------------------------------------------------------------------------------------------ robust fits (L1 via IRLS)
  const EPS = 0.004;
  function fitJoint(D, R, names) { // scale k + translation t, joint
    let k = 1, tx = 0, ty = 0, it = 0;
    for (; it < 40; it++) {
      const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (const n of names) for (const ax of ['x', 'y']) {
        const resid = D[n][ax] - (k * R[n][ax] + (ax === 'x' ? tx : ty)), w = 1 / Math.max(Math.abs(resid), EPS);
        const row = [R[n][ax], ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0], v = D[n][ax];
        for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) S[i][j] += w * row[i] * row[j]; b[i] += w * row[i] * v; }
      }
      const sol = solveLinear(S, b), d = Math.abs(sol[0] - k) + Math.abs(sol[1] - tx) + Math.abs(sol[2] - ty);
      k = sol[0]; tx = sol[1]; ty = sol[2]; if (d < 1e-7) break;
    }
    return { k, t: { x: tx, y: ty }, iterations: it };
  }
  function fitScaleAbout(D, R, names, pD, pR) { // scale only, with a pinned pair (pD <-> pR)
    let k = 1, it = 0;
    for (; it < 40; it++) {
      let num = 0, den = 0;
      for (const n of names) for (const ax of ['x', 'y']) {
        const d = D[n][ax] - pD[ax], r = R[n][ax] - pR[ax], w = 1 / Math.max(Math.abs(d - k * r), EPS);
        num += w * d * r; den += w * r * r;
      }
      const nk = den > 1e-12 ? num / den : k, dd = Math.abs(nk - k); k = nk; if (dd < 1e-8) break;
    }
    return { k, iterations: it };
  }
  function fitShift(D, R, names, k) { // translation only, scale given
    const t = { x: 0, y: 0 };
    for (const ax of ['x', 'y']) {
      let v = 0;
      for (let it = 0; it < 40; it++) {
        let sw = 0, sv = 0;
        for (const n of names) { const e = D[n][ax] - k * R[n][ax], w = 1 / Math.max(Math.abs(e - v), EPS); sw += w; sv += w * e; }
        const nv = sv / sw, d = Math.abs(nv - v); v = nv; if (d < 1e-8) break;
      }
      t[ax] = v;
    }
    return t;
  }

  // ------------------------------------------------------------------------------------------ align
  const SIZE_MODES = ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'];
  const PIN_NAMES = { eyes: 'eyeMid', nose: 'noseBase', chin: 'chin', mouth: 'mouthCentre' };
  const LOCK_BY_SIZE = { eyeChin: ['chin_length'], eyeSpacing: ['eye_spacing'], head: [], custom: [], auto: [] };
  const LOCK_BY_PIN = { nose: ['nose_length'], chin: ['chin_length'], mouth: ['mouth_height'], eyes: [] };

  /** align(drawingFs, referenceFs, options) -> alignment
      options: { size: 'auto'|'head'|'eyeChin'|'eyeSpacing'|'custom' (default 'auto'),
                 custom: { drawing: [p1,p2], reference: [p1,p2] }   // two points in each image, for size 'custom'
                 pin: 'auto'|'eyes'|'nose'|'chin'|'mouth'|{x,y,[drawing:{x,y}]}  // {x,y} in REFERENCE pixels
                 matchTilt: false }
      returns { scale, rotation, rotationDeg, tx, ty,            // drawing -> reference similarity (rotation 0 unless matchTilt)
                tiltDiff,                                         // degrees, drawing midline tilt minus reference's, clockwise +
                size: {requested, used, note}, pin: {requested, used, reference, drawing},
                locked: [item keys that cannot be flagged],
                frame: {k, t, drawing:{...}, reference:{...}},    // used by measure()
                unit: { reference: [p,p], drawing: [p,p], ecReference, ecDrawing },  // the eye-line-to-chin measure that "%" refers to
                fit: {...}, matchTilt, ok: true }
      Auto size = L1 / IRLS fit of scale + translation over eyes, nose base, mouth corners, chin and jaw, in the midline-
      compensated frame (a single mis-drawn feature does not move the fit). A pin replaces the translation (the pinned pair
      coincides exactly) and the scale is re-fitted about the pin. For a custom pin {x,y} with no `drawing` partner, the drawing
      point that sat there under the best fit becomes the partner. */
  function align(DF, RF, options) {
    const o = options || {}, matchTilt = !!o.matchTilt;
    const Dp = resolve(DF), Rp = resolve(RF);
    for (const n of ['eyeMid', 'chin', 'mouthMid', 'noseBase']) if (!Dp[n] || !Rp[n]) return { ok: false, reason: 'missing ' + n };
    const fd = frameOf(Dp), fr = frameOf(Rp);
    const names = FIT_NAMES.filter(n => Dp[n] && Rp[n]);
    const ND = {}, NR = {}; for (const n of Object.keys(Dp)) if (Rp[n]) { ND[n] = toN(fd, Dp[n]); NR[n] = toN(fr, Rp[n]); }
    let sizeUsed = SIZE_MODES.includes(o.size) ? o.size : 'auto', note = null, kFixed = null;
    if (sizeUsed === 'head') {
      if (ND.hairline && NR.hairline) kFixed = (ND.chin.y - ND.hairline.y) / (NR.chin.y - NR.hairline.y);
      else { sizeUsed = 'eyeChin'; note = 'no hairline point: sized by eye line to chin'; }
    }
    if (sizeUsed === 'eyeSpacing') kFixed = Math.abs(ND.eyeL.x - ND.eyeR.x) / Math.abs(NR.eyeL.x - NR.eyeR.x);
    if (sizeUsed === 'custom') {
      const c = o.custom;
      if (c && c.drawing && c.reference && c.drawing.length === 2 && c.reference.length === 2) {
        const a = [toN(fd, c.drawing[0]), toN(fd, c.drawing[1])], b = [toN(fr, c.reference[0]), toN(fr, c.reference[1])];
        kFixed = dist(a[0], a[1]) / dist(b[0], b[1]);
      } else { sizeUsed = 'eyeChin'; note = 'custom size needs two points in each image: sized by eye line to chin'; }
    }
    if (sizeUsed === 'eyeChin') kFixed = 1;
    if (kFixed !== null && !(kFixed > 0 && Number.isFinite(kFixed))) { kFixed = 1; note = 'degenerate size measure: sized by eye line to chin'; sizeUsed = 'eyeChin'; }

    // translation / pin
    const pinReq = o.pin === undefined ? 'auto' : o.pin;
    let k, t, pinUsed = 'auto', pinD = null, pinR = null, iterations = 0;
    const auto = kFixed === null ? fitJoint(ND, NR, names) : { k: kFixed, t: fitShift(ND, NR, names, kFixed), iterations: 0 };
    if (typeof pinReq === 'string' && PIN_NAMES[pinReq] && Dp[PIN_NAMES[pinReq]] && Rp[PIN_NAMES[pinReq]]) {
      const nm = PIN_NAMES[pinReq]; pinUsed = pinReq;
      k = kFixed !== null ? kFixed : (() => { const f = fitScaleAbout(ND, NR, names, ND[nm], NR[nm]); iterations = f.iterations; return f.k; })();
      t = { x: ND[nm].x - k * NR[nm].x, y: ND[nm].y - k * NR[nm].y };
      pinD = Dp[nm]; pinR = Rp[nm];
    } else if (pinReq && typeof pinReq === 'object' && ok(pinReq)) {
      pinUsed = 'custom'; pinR = { x: pinReq.x, y: pinReq.y };
      const nr = toN(fr, pinR);
      let nd;
      if (ok(pinReq.drawing)) nd = toN(fd, pinReq.drawing);
      else nd = { x: auto.k * nr.x + auto.t.x, y: auto.k * nr.y + auto.t.y };
      pinD = fromN(fd, nd);
      k = kFixed !== null ? kFixed : (() => { const f = fitScaleAbout(ND, NR, names, nd, nr); iterations = f.iterations; return f.k; })();
      t = { x: nd.x - k * nr.x, y: nd.y - k * nr.y };
    } else { k = auto.k; t = auto.t; iterations = auto.iterations; pinD = fromN(fd, t); pinR = copy(fr.A); }

    // similarity in pixels
    const scale = fr.ec / (k * fd.ec), phi = matchTilt ? fd.theta - fr.theta : 0, c = Math.cos(phi), s = Math.sin(phi);
    const tx = pinR.x - scale * (c * pinD.x - s * pinD.y), ty = pinR.y - scale * (s * pinD.x + c * pinD.y);
    const locked = (LOCK_BY_SIZE[sizeUsed] || []).concat(pinUsed !== 'auto' && LOCK_BY_PIN[pinUsed] ? LOCK_BY_PIN[pinUsed] : []);
    return {
      ok: true, scale, rotation: phi, rotationDeg: deg(phi), tx, ty, matchTilt,
      tiltDiff: -deg(fd.theta - fr.theta),
      size: { requested: o.size || 'auto', used: sizeUsed, note },
      pin: { requested: typeof pinReq === 'object' ? 'custom' : pinReq, used: pinUsed, reference: pinR, drawing: pinD },
      locked: Array.from(new Set(locked)),
      frame: { k, t, drawing: { ox: fd.A.x, oy: fd.A.y, theta: fd.theta, ec: fd.ec }, reference: { ox: fr.A.x, oy: fr.A.y, theta: fr.theta, ec: fr.ec } },
      unit: { reference: [copy(Rp.eyeMid), copy(Rp.chin)], drawing: [copy(Dp.eyeMid), copy(Dp.chin)], ecReference: fr.ec, ecDrawing: fd.ec },
      fit: { kind: 'robust-l1-irls', iterations, names },
    };
  }
  /** apply(alignment, p) -> drawing point in reference pixels */
  function apply(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation); return { x: al.scale * (c * p.x - s * p.y) + al.tx, y: al.scale * (s * p.x + c * p.y) + al.ty }; }
  /** invert(alignment, p) -> reference point in drawing pixels */
  function invert(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation), x = (p.x - al.tx) / al.scale, y = (p.y - al.ty) / al.scale; return { x: c * x + s * y, y: -s * x + c * y }; }
  /** toLayerTransform(alignment, drawingSize, referenceSize) -> {x, y, scale, angle}: the drawing layer's transform relative to the
      reference image centre, in REFERENCE pixels (multiply x,y,scale by the reference's display scale for Layer: x,y offsets of
      the drawing centre from the reference centre, `scale` = drawing px -> reference px, `angle` radians). */
  function toLayerTransform(al, dSize, rSize) {
    const c = apply(al, { x: dSize.w / 2, y: dSize.h / 2 });
    return { x: c.x - rSize.w / 2, y: c.y - rSize.h / 2, scale: al.scale, angle: al.rotation };
  }

  // ------------------------------------------------------------------------------------------ items
  // terms: [point, axis, weight]. value = sum(weight * (drawing coord - reference coord)) in the aligned, midline-compensated
  // frame, in units of 100 * EC. movable: the points an arrow moves (the others are fixed by the reference).
  // dir: [name when value < 0, name when value > 0]. sentence: key per direction (templates live in the UI's catalogue).
  const ITEMS = [
    { key: 'eye_spacing', feature: 'eyes', kind: 'proportion', side: 'both', rel: 'high', terms: [['eyeL', 'x', 1], ['eyeR', 'x', -1]], movable: ['eyeR', 'eyeL'], span: ['eyeR', 'eyeL'], dir: ['too_close', 'too_far_apart'], sentence: ['eyes_too_close', 'eyes_too_far_apart'], width: true },
    { key: 'eye_height_R', feature: 'eyes', kind: 'placement', side: 'right', rel: 'high', terms: [['eyeR', 'y', -1]], movable: ['eyeR'], dir: ['too_low', 'too_high'], sentence: ['eye_too_low', 'eye_too_high'] },
    { key: 'eye_height_L', feature: 'eyes', kind: 'placement', side: 'left', rel: 'high', terms: [['eyeL', 'y', -1]], movable: ['eyeL'], dir: ['too_low', 'too_high'], sentence: ['eye_too_low', 'eye_too_high'] },
    { key: 'eye_tilt', feature: 'eyes', kind: 'tilt', side: 'both', rel: 'high', terms: [['eyeL', 'y', 1], ['eyeR', 'y', -1]], movable: ['eyeR', 'eyeL'], dir: ['tilted_anticlockwise', 'tilted_clockwise'], sentence: ['eye_line_tilted_anticlockwise', 'eye_line_tilted_clockwise'], degrees: true },
    { key: 'brow_height_R', feature: 'brows', kind: 'placement', side: 'right', rel: 'unvalidated', terms: [['eyeR', 'y', 1], ['browR', 'y', -1]], movable: ['browR'], dir: ['too_low', 'too_high'], sentence: ['brow_too_low', 'brow_too_high'] },
    { key: 'brow_height_L', feature: 'brows', kind: 'placement', side: 'left', rel: 'unvalidated', terms: [['eyeL', 'y', 1], ['browL', 'y', -1]], movable: ['browL'], dir: ['too_low', 'too_high'], sentence: ['brow_too_low', 'brow_too_high'] },
    { key: 'nose_length', feature: 'nose', kind: 'proportion', side: null, rel: 'high', terms: [['noseBase', 'y', 1]], movable: ['noseBase'], span: ['eyeMid', 'noseBase'], dir: ['too_short', 'too_long'], sentence: ['nose_too_short', 'nose_too_long'] },
    { key: 'nose_width', feature: 'nose', kind: 'proportion', side: 'both', rel: 'unvalidated', terms: [['noseAlaL', 'x', 1], ['noseAlaR', 'x', -1]], movable: ['noseAlaR', 'noseAlaL'], span: ['noseAlaR', 'noseAlaL'], dir: ['too_narrow', 'too_wide'], sentence: ['nose_too_narrow', 'nose_too_wide'], width: true },
    { key: 'mouth_height', feature: 'mouth', kind: 'placement', side: null, rel: 'high', terms: [['mouthL', 'y', .5], ['mouthR', 'y', .5]], movable: ['mouthR', 'mouthL'], span: ['eyeMid', 'mouthMid'], dir: ['too_high', 'too_low'], sentence: ['mouth_too_high', 'mouth_too_low'] },
    { key: 'mouth_width', feature: 'mouth', kind: 'proportion', side: 'both', rel: 'medium', terms: [['mouthL', 'x', 1], ['mouthR', 'x', -1]], movable: ['mouthR', 'mouthL'], span: ['mouthR', 'mouthL'], dir: ['too_narrow', 'too_wide'], sentence: ['mouth_too_narrow', 'mouth_too_wide'], width: true },
    { key: 'chin_length', feature: 'chin', kind: 'placement', side: null, rel: 'low', terms: [['chin', 'y', 1]], movable: ['chin'], span: ['eyeMid', 'chin'], dir: ['too_high', 'too_low'], sentence: ['chin_too_high', 'chin_too_low'] },
    { key: 'jaw_width', feature: 'jaw', kind: 'proportion', side: 'both', rel: 'low', possibleOnly: true, terms: [['jawLowL', 'x', 1], ['jawLowR', 'x', -1]], movable: ['jawLowR', 'jawLowL'], span: ['jawLowR', 'jawLowL'], dir: ['too_narrow', 'too_wide'], sentence: ['jaw_too_narrow', 'jaw_too_wide'], width: true },
    { key: 'jaw_width_high', feature: 'jaw', kind: 'proportion', side: 'both', rel: 'low', possibleOnly: true, terms: [['jawHighL', 'x', 1], ['jawHighR', 'x', -1]], movable: ['jawHighR', 'jawHighL'], span: ['jawHighR', 'jawHighL'], dir: ['too_narrow', 'too_wide'], sentence: ['jaw_too_narrow', 'jaw_too_wide'], width: true },
  ];
  const ITEM_KEYS = ITEMS.map(i => i.key).concat(['head_tilt']);

  function tolFactor(t) { return typeof t === 'number' ? t : (TOLERANCE_PRESETS[t || 'usual'] || 1); }
  /** Whole-number percentage for display: rounds, but a value over the tolerance never shows as "within" it. */
  function displayPercent(v, tol) { const a = Math.abs(v); let r = Math.round(a); if (a > tol && r <= tol) r = Math.floor(tol) + 1; return r; }
  function rotateVec(f, vx, vy) { return { x: f.c * vx + f.s * vy, y: -f.s * vx + f.c * vy }; } // Rot(-theta)

  /** measure(drawingFs, referenceFs, alignment, options) -> report
      options: { tolerance: 'strict'|'usual'|'relaxed'|factor (default 'usual'), bias: 'sketch'|'none'|{key:value} (default 'sketch') }
      report: { items: [item...] (fixed order, all measured items incl. head_tilt),
                flagged: [item...] ranked (largest multiple of its tolerance first, 'possible' last),
                close: [keys within tolerance and not locked], locked: [keys], groups: [...], warnings: [...],
                pose: {...}, tilt: item, tolerance: {preset, factor}, summary: {count, possible, major, overPercent}, source, bias }
      item: { key, feature, kind: 'proportion'|'placement'|'tilt', unit: '%'|'deg',
              value (signed, bias-corrected), raw, bias, percent (whole number for display),
              direction ('too_long'... or null), severity: 'none'|'minor'|'major'|'possible',
              tolerance, flagged, locked, approximate, side: 'left'|'right'|'both'|null (subject's own), reliability,
              points: [names], span: [nameA, nameB]|null,
              pointData: { name: { drawing:{x,y}, reference:{x,y}, drawingInReference:{x,y} } },
              arrows: [{ point, drawing: {from,to}, reference: {from,to} }]   // drawing point -> where the reference says it belongs,
                                                                               // in drawing pixels and in reference pixels
              sentence: { key, n | d, side }, groupedUnder: key|null, rankScore }
      Sign: drawing minus reference. eye_spacing/nose_width/mouth_width/jaw_width + = wider; nose_length + = longer (nose base lower);
      mouth_height + = lower; chin_length + = lower; eye_height_* and brow_height_* + = HIGHER; eye_tilt + = eye line tilted clockwise
      (subject's right eye higher); head_tilt degrees + = drawing tilted more clockwise than the reference. */
  function measure(DF, RF, al, options) {
    const o = options || {};
    if (!al || !al.ok) return { ok: false, reason: al && al.reason || 'no alignment', items: [], flagged: [], close: [], locked: [], groups: [], warnings: [] };
    const Dp = resolve(DF), Rp = resolve(RF), fd = frameOf(Dp), fr = frameOf(Rp), { k, t } = al.frame;
    const factor = tolFactor(o.tolerance) * (DETECTOR_TOLERANCE_SCALE[DF.source] || 1), preset = typeof o.tolerance === 'string' ? o.tolerance : (o.tolerance === undefined ? 'usual' : 'custom');
    const gainT = o.gain === 'none' ? {} : (o.gain && typeof o.gain === 'object' ? o.gain : (GAIN[DF.source] || {}));
    const biasT = o.bias === 'none' ? {} : (o.bias && typeof o.bias === 'object' ? o.bias : (BIAS[DF.source] || {}));
    const N2 = n => { const q = toN(fd, Dp[n]); return { x: (q.x - t.x) / k, y: (q.y - t.y) / k }; }; // drawing point in the aligned reference frame
    const NR = n => toN(fr, Rp[n]);
    const items = [], locked = new Set(al.locked);
    // pose: nose offset from the eye midline as a fraction of eye distance
    const yawOf = (P, f) => { const nt = P.noseTip || P.noseBase, a = toN(f, nt), e = toN(f, P.eyeMid), r = toN(f, P.eyeR), l = toN(f, P.eyeL); return (a.x - e.x) / Math.max(1e-6, Math.abs(l.x - r.x)); };
    const pose = { drawingYaw: yawOf(Dp, fd), referenceYaw: yawOf(Rp, fr) }; pose.differs = Math.abs(pose.drawingYaw - pose.referenceYaw) > 0.15;
    const warnings = []; if (pose.differs) warnings.push({ key: 'heads_turned_differently', drawing: pose.drawingYaw, reference: pose.referenceYaw });
    if (al.size.note) warnings.push({ key: 'size_fallback', note: al.size.note });

    const toRefPx = p => apply(al, p);
    for (const it of ITEMS) {
      if (!it.terms.every(([n]) => Dp[n] && Rp[n])) continue;
      let raw = 0; for (const [n, ax, w] of it.terms) raw += w * (N2(n)[ax] - NR(n)[ax]);
      raw *= 100;
      items.push(finish(it, raw));
    }
    // head tilt (degrees, clockwise +)
    {
      const raw = al.tiltDiff;
      items.push(finish({ key: 'head_tilt', feature: 'head', kind: 'tilt', side: null, rel: 'high', unit: 'deg', dir: ['tilted_anticlockwise', 'tilted_clockwise'], sentence: ['head_tilted_anticlockwise', 'head_tilted_clockwise'], terms: [], movable: [], degrees: true }, raw));
    }
    function finish(it, raw) {
      const unit = it.unit || '%', isLocked = locked.has(it.key);
      const bias = typeof biasT[it.key] === 'number' ? biasT[it.key] : 0, gain = Math.max(1 / MAX_GAIN_CORRECTION, Math.min(1, typeof gainT[it.key] === 'number' ? gainT[it.key] : 1));
      const value = (raw - bias) / gain, tol = TOLERANCE[it.key] * factor;
      const over = !isLocked && Math.abs(value) > tol;
      const severity = !over ? 'none' : (it.possibleOnly ? 'possible' : (Math.abs(value) >= 2 * tol ? 'major' : 'minor'));
      const pos = value > 0, direction = Math.abs(value) < 1e-9 ? null : it.dir[pos ? 1 : 0];
      const item = {
        key: it.key, feature: it.feature, kind: it.kind, unit, value, raw, bias, percent: displayPercent(value, tol), direction, severity, tolerance: tol,
        flagged: over, locked: isLocked, approximate: !!(it.width && pose.differs), side: it.side, reliability: it.rel,
        points: Array.from(new Set(it.terms.map(x => x[0]))), span: it.span || null, pointData: {}, arrows: [], groupedUnder: null,
        sentence: over || Math.abs(value) > 0 ? { key: it.sentence[pos ? 1 : 0], [unit === 'deg' ? 'd' : 'n']: item_n(value, tol, unit), side: it.side } : null,
        rankScore: over ? (it.possibleOnly ? -1000 : 0) + Math.abs(value) / tol : 0,
      };
      // arrows: minimum-norm move of the movable points along the term axes that cancels the (bias-corrected) value
      if (it.terms.length && !isLocked) {
        const movW = it.terms.filter(([n]) => it.movable.includes(n)), den = movW.reduce((s, [, , w]) => s + w * w, 0) || 1, per = {};
        const scaleN = unit === '%' ? value / 100 : 0;
        for (const [n, ax, w] of movW) { const e = (per[n] = per[n] || { x: 0, y: 0 }); e[ax] += -scaleN * w / den; }
        for (const n of item.points) item.pointData[n] = { drawing: copy(Dp[n]), reference: copy(Rp[n]), drawingInReference: toRefPx(Dp[n]) };
        for (const n of Object.keys(per)) {
          const d = rotateVec(fd, per[n].x * fd.ec * k, per[n].y * fd.ec * k), a = Dp[n], b = { x: a.x + d.x, y: a.y + d.y };
          item.arrows.push({ point: n, drawing: { from: copy(a), to: b }, reference: { from: toRefPx(a), to: toRefPx(b) } });
        }
      } else for (const n of item.points) if (Dp[n] && Rp[n]) item.pointData[n] = { drawing: copy(Dp[n]), reference: copy(Rp[n]), drawingInReference: toRefPx(Dp[n]) };
      if (it.key === 'head_tilt') { item.pointData = {}; }
      return item;
    }
    function item_n(value, tol, unit) { return unit === 'deg' ? Math.round(Math.abs(value)) : displayPercent(value, tol); }

    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    // ---- knock-on grouping (SPEC 2: "the mouth sits low because the nose is long")
    const groups = [], flag = k2 => byKey[k2] && byKey[k2].flagged && !byKey[k2].locked;
    const same = (a, b) => Math.sign(a.value) === Math.sign(b.value);
    const effect = (cause, eff, sentenceKey, relation) => {
      eff.groupedUnder = cause.key;
      let g = groups.find(x => x.cause === cause.key); if (!g) groups.push(g = { cause: cause.key, effects: [] });
      g.effects.push({ key: eff.key, relation, sentence: sentenceKey ? { key: sentenceKey, n: eff.percent } : null, value: eff.value });
    };
    let lowest = null; // the item the chin can follow
    if (flag('nose_length')) lowest = byKey.nose_length;
    if (flag('mouth_height')) {
      const m = byKey.mouth_height, n = byKey.nose_length;
      if (n && flag('nose_length') && same(m, n) && Math.abs(m.value - n.value) <= m.tolerance) { effect(n, m, m.value > 0 ? 'mouth_with_it_low' : 'mouth_with_it_high', 'follows'); lowest = n; }
      else lowest = m;
    }
    if (flag('chin_length') && lowest && same(byKey.chin_length, lowest) && Math.abs(byKey.chin_length.value - lowest.value) <= byKey.chin_length.tolerance)
      effect(lowest, byKey.chin_length, byKey.chin_length.value > 0 ? 'chin_with_it_low' : 'chin_with_it_high', 'follows');
    const eR = byKey.eye_height_R, eL = byKey.eye_height_L, tl = byKey.eye_tilt;
    if (eR && eL && flag('eye_height_R') && flag('eye_height_L') && same(eR, eL) && Math.abs(eR.value - eL.value) <= tl.tolerance) {
      const [c, e] = Math.abs(eR.value) >= Math.abs(eL.value) ? [eR, eL] : [eL, eR]; effect(c, e, 'both_eyes_with_it', 'moves_with');
    }
    if (tl && tl.flagged && (flag('eye_height_R') || flag('eye_height_L'))) { const c = flag('eye_height_R') && flag('eye_height_L') ? (Math.abs(eR.value) >= Math.abs(eL.value) ? eR : eL) : (flag('eye_height_R') ? eR : eL); if (!tl.groupedUnder) effect(c, tl, null, 'explained_by'); }

    const flagged = items.filter(i => i.flagged).sort((a, b) => b.rankScore - a.rankScore || Math.abs(b.value) - Math.abs(a.value));
    const close = items.filter(i => !i.flagged && !i.locked).map(i => i.key);
    return {
      ok: true, items, byKey, flagged, close, locked: Array.from(locked), groups, warnings, pose, tilt: byKey.head_tilt,
      tolerance: { preset, factor, usualBase: TOLERANCE },
      summary: { count: flagged.filter(i => i.severity !== 'possible').length, possible: flagged.filter(i => i.severity === 'possible').length, major: flagged.filter(i => i.severity === 'major').length, overPercent: Math.round(TOLERANCE.eye_spacing * factor * 100) / 100 },
      source: { drawing: DF.source, reference: RF.source }, bias: o.bias === 'none' ? 'none' : biasT === BIAS[DF.source] ? 'sketch:' + DF.source : 'custom',
    };
  }

  // ------------------------------------------------------------------------------------------ thin-plate spline + grid
  const GRID_NAMES = ['eyeR', 'eyeL', 'eyeCornerOuterR', 'eyeCornerInnerR', 'eyeCornerInnerL', 'eyeCornerOuterL', 'browOuterR', 'browMidR', 'browInnerR', 'browInnerL', 'browMidL', 'browOuterL',
    'noseBridge', 'noseTip', 'noseBase', 'noseAlaR', 'noseAlaL', 'mouthR', 'mouthL', 'mouthCentre', 'lipUpper', 'lipLower', 'chin', 'jawLowR', 'jawLowL', 'jawHighR', 'jawHighL', 'cheekR', 'cheekL', 'hairline'];
  function tps(src, dst, lambda) {
    const n = src.length, U = r2 => (r2 < 1e-12 ? 0 : r2 * Math.log(r2));
    const A = [], bx = [], by = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(n + 3).fill(0);
      for (let j = 0; j < n; j++) row[j] = U((src[i].x - src[j].x) ** 2 + (src[i].y - src[j].y) ** 2) + (i === j ? lambda : 0);
      row[n] = 1; row[n + 1] = src[i].x; row[n + 2] = src[i].y; A.push(row); bx.push(dst[i].x); by.push(dst[i].y);
    }
    for (let r = 0; r < 3; r++) { const row = new Array(n + 3).fill(0); for (let j = 0; j < n; j++) row[j] = r === 0 ? 1 : r === 1 ? src[j].x : src[j].y; A.push(row); bx.push(0); by.push(0); }
    const wx = solveLinear(A, bx), wy = solveLinear(A, by);
    return p => { let x = wx[n] + wx[n + 1] * p.x + wx[n + 2] * p.y, y = wy[n] + wy[n + 1] * p.x + wy[n + 2] * p.y; for (let i = 0; i < n; i++) { const u = U((p.x - src[i].x) ** 2 + (p.y - src[i].y) ** 2); x += wx[i] * u; y += wy[i] * u; } return { x, y }; };
  }
  const polyArea = q => { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; a += p.x * r.y - r.x * p.y; } return Math.abs(a) / 2; };

  /** distortionGrid(drawingFs, referenceFs, alignment, { cols, rows, sub, smooth, lambda }) ->
      { cols, rows, cell: {w,h} (reference px), origin, ec,
        reference: { h: [polyline...], v: [polyline...] },          // the square grid on the reference, reference px
        drawingAligned: { h, v },                                    // the same lines as the drawing bends them, in reference px (overlay)
        drawing: { h, v },                                           // ... in the drawing's own source px
        cells: [{ col, row, center, area, sx, sy, value, smoothed, kind: 'stretched'|'squashed'|'none' }]  // row-major
        landmarks: n }
      Thin-plate spline from reference landmarks to the drawing's landmarks (after the alignment); lambda (default 0.002 in EC^2) smooths
      detector noise. Squares are 16% of EC wide by default and cover the brows to below the chin; pass cols/rows to override.
      value = area of the bent cell / area of the square - 1 (+ = drawing larger = stretched); smoothed = 3x3 mean, `kind` uses |smoothed| >= 0.04. */
  function distortionGrid(DF, RF, al, opt) {
    const o = opt || {}, Dp = resolve(DF), Rp = resolve(RF);
    if (!al || !al.ok) return null;
    const names = GRID_NAMES.filter(n => Dp[n] && Rp[n]); if (names.length < 6) return null;
    const ec = al.unit.ecReference, lam = (o.lambda === undefined ? 0.002 : o.lambda);
    const src = names.map(n => ({ x: Rp[n].x / ec, y: Rp[n].y / ec })), dst = names.map(n => { const p = apply(al, Dp[n]); return { x: p.x / ec, y: p.y / ec }; });
    const f = tps(src, dst, lam);
    const bt = ['browOuterR', 'browOuterL', 'browMidR', 'browMidL', 'browInnerR', 'browInnerL'].filter(n => Rp[n]).map(n => Rp[n].y), top = (bt.length ? Math.min(...bt) : Rp.eyeMid.y - 0.3 * ec) - 0.18 * ec;
    const bottom = Rp.chin.y + 0.16 * ec, wide = Math.max(Rp.cheekR && Rp.cheekL ? Math.abs(Rp.cheekL.x - Rp.cheekR.x) : 0, Rp.jawHighR && Rp.jawHighL ? Math.abs(Rp.jawHighL.x - Rp.jawHighR.x) : 0, 1.0 * ec) * 1.18;
    const q = 0.16 * ec, cols = o.cols || Math.max(2, Math.ceil(wide / q)), rows = o.rows || Math.max(2, Math.ceil((bottom - top) / q));
    const cw = o.cols ? wide / cols : q, ch = o.rows ? (bottom - top) / rows : q, cx = (Rp.eyeMid.x + Rp.chin.x) / 2, x0 = cx - cols * cw / 2, y0 = top, sub = o.sub || 4;
    const ref = { h: [], v: [] }, aligned = { h: [], v: [], }, own = { h: [], v: [] };
    const warp = p => { const w = f({ x: p.x / ec, y: p.y / ec }); return { x: w.x * ec, y: w.y * ec }; };
    const line = (a, b, n) => { const pl = [], pa = [], po = []; for (let i = 0; i <= n; i++) { const p = { x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, w = warp(p); pl.push(p); pa.push(w); po.push(invert(al, w)); } return [pl, pa, po]; };
    for (let j = 0; j <= rows; j++) { const [a, b, c] = line({ x: x0, y: y0 + j * ch }, { x: x0 + cols * cw, y: y0 + j * ch }, cols * sub); ref.h.push(a); aligned.h.push(b); own.h.push(c); }
    for (let i = 0; i <= cols; i++) { const [a, b, c] = line({ x: x0 + i * cw, y: y0 }, { x: x0 + i * cw, y: y0 + rows * ch }, rows * sub); ref.v.push(a); aligned.v.push(b); own.v.push(c); }
    const cells = [], val = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const c4 = [{ x: x0 + i * cw, y: y0 + j * ch }, { x: x0 + (i + 1) * cw, y: y0 + j * ch }, { x: x0 + (i + 1) * cw, y: y0 + (j + 1) * ch }, { x: x0 + i * cw, y: y0 + (j + 1) * ch }].map(warp);
      const area = polyArea(c4), v = area / (cw * ch) - 1, sx = (dist(c4[0], c4[1]) + dist(c4[3], c4[2])) / 2 / cw - 1, sy = (dist(c4[0], c4[3]) + dist(c4[1], c4[2])) / 2 / ch - 1;
      cells.push({ col: i, row: j, center: { x: x0 + (i + .5) * cw, y: y0 + (j + .5) * ch }, area, sx, sy, value: v, smoothed: v, kind: 'none' }); val.push(v);
    }
    const thr = o.threshold === undefined ? 0.04 : o.threshold;
    for (const c of cells) {
      let s = 0, n = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = c.col + di, b = c.row + dj; if (a >= 0 && b >= 0 && a < cols && b < rows) { s += val[b * cols + a]; n++; } }
      c.smoothed = s / n; c.kind = Math.abs(c.smoothed) < thr ? 'none' : (c.smoothed > 0 ? 'stretched' : 'squashed');
    }
    return { cols, rows, cell: { w: cw, h: ch }, origin: { x: x0, y: y0 }, ec, reference: ref, drawingAligned: aligned, drawing: own, cells, landmarks: names.length };
  }

  // ------------------------------------------------------------------------------------------ convenience
  /** analyse(drawingFace, referenceFace, options) -> { drawing: fs, reference: fs, alignment, report, grid? }
      faces: { points, detector|source } as returned by DC.Landmarks.detect (faces[0]). options: align + measure options plus grid: {cols,rows}|true. */
  function analyse(dFace, rFace, options) {
    const o = options || {}, D = features(dFace.points, dFace.detector || dFace.source), R = features(rFace.points, rFace.detector || rFace.source);
    const alignment = align(D, R, o), report = measure(D, R, alignment, o), out = { drawing: D, reference: R, alignment, report };
    if (o.grid) out.grid = distortionGrid(D, R, alignment, o.grid === true ? {} : o.grid);
    return out;
  }

  DC.Proportions = {
    features, fromPoints, resolve, align, measure, distortionGrid, analyse, apply, invert, toLayerTransform, displayPercent,
    TOLERANCE, TOLERANCE_PRESETS, BIAS, GAIN, MAX_GAIN_CORRECTION, DETECTOR_TOLERANCE_SCALE, ITEM_KEYS, INDEX: { mediapipe: MP, faceapi: FA }, SIZE_MODES,
  };
})();

