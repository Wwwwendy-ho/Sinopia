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
    noseBridge: 168, noseTip: 1, noseBase: 2, noseAlaR: 209, noseAlaL: 429,            // alae: the nose wings (129 / 358 follow the drawn outline of the wing less steadily)
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
    eye_spacing: 4.5, eye_height_R: 3.75, eye_height_L: 3.75, eye_tilt: 3.95, nose_length: 3.95, mouth_height: 3.95,
    mouth_width: 8.7, chin_length: 7.9,
    jaw_width: 10, jaw_width_high: 10,
    // not covered by the planted-error benchmark; set from the natural CUFS discrepancy (p95 + margin)
    nose_width: 4.5, brow_height_R: 4.5, brow_height_L: 4.5,
    head_tilt: 3,                                           // degrees
  };
  // Mean detector bias on sketches: mean over the 188 CUFS pairs of (measure on the sketch's landmarks minus
  // measure on the photo's landmarks), same engine, % of EC. Subtracted before comparing. Source:
  // bench planted-*.json natBiasCorrected (mediapipe, face-api tiny) for the seven benchmarked measures;
  // the rest were measured with this engine by bench/proportions-validate.html (natural run).
  const BIAS = {
    mediapipe: { eye_spacing: 0.55, eye_height_R: -0.51, eye_height_L: -0.57, eye_tilt: 0.06, nose_length: -0.08, nose_width: 1.03,
      mouth_height: 0.32, mouth_width: 0.06, chin_length: -0.29, jaw_width: 1.18, jaw_width_high: 1.82, brow_height_R: 0.06, brow_height_L: 0.17, head_tilt: 0.17 },
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
    mediapipe: { eye_spacing: 0.75, eye_height_R: 0.72, eye_height_L: 0.70, eye_tilt: 0.78, nose_length: 0.71, mouth_height: 0.76, mouth_width: 0.90, chin_length: 0.36, jaw_width: 0.31, jaw_width_high: 0.31 },
    faceapi: { eye_spacing: 0.43, eye_height_R: 0.32, eye_height_L: 0.32, eye_tilt: 0.32, nose_length: 0.66, mouth_height: 0.43, mouth_width: 0.26, chin_length: 0.08, jaw_width: 0.16, jaw_width_high: 0.16 },
  };
  // Per-detector tolerance multiplier (face-api landmarks are noisier and shrink imposed displacements).
  // Head pose from the nose-tip offset across the eye line, in eye distances (about 0.0091 per degree of yaw; sin(yaw) = proxy / perSin).
  // diff: heads turned differently (was 0.15, which almost never fired); large: either head far from frontal (about 25 degrees).
  const POSE = { diff: 0.09, large: 0.25, perSin: 0.52, compensate: true };
  // ---- Noise-aware decisions (robustness v2). Natural sketch-vs-photo differences are about 2.5x larger on stylised drawings (FS2K) than on
  // close pencil copies (CUFS). The noise proxy is the median residual of 18 stable points after the robust fit (% of EC; CUFS median 1.1,
  // FS2K 2.7). From it: tolerances widen (x clamp(noise / r0, 1, M)), the bias of the width items grows (slope per unit above biasFrom, up
  // to biasSpan), and the gain moves from the realistic to the stylised table. DECIDE_GAIN is the pooled gain the thresholds were tuned with
  // (flag decisions); the displayed value uses the style-interpolated GAIN so the percentages stay honest. Calibrated on the calibration
  // halves only (id hash), see review/proportions-engine.md.
  const ADAPT = { r0: 1.4, M: 1.5, biasFrom: 2, biasSpan: 1, realistic: 1.0, stylised: 3.0 };
  const BIAS_SLOPE = { mediapipe: { eye_spacing: 1.85, nose_width: 1.27, mouth_height: 0.44 } };
  const GAIN_STYLISED = { mediapipe: { eye_spacing: 0.53, eye_height_R: 0.72, eye_height_L: 0.70, eye_tilt: 0.78, nose_length: 0.55, mouth_height: 0.51, mouth_width: 0.55, chin_length: 0.5, jaw_width: 0.31, jaw_width_high: 0.31 } };
  const DECIDE_GAIN = { mediapipe: { eye_spacing: 0.60, eye_height_R: 0.72, eye_height_L: 0.70, eye_tilt: 0.78, nose_length: 0.61, mouth_height: 0.59, mouth_width: 0.67, chin_length: 0.5, jaw_width: 0.31, jaw_width_high: 0.31 } };
  const STYLES = ['auto', 'realistic', 'stylised'];
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
  // eyeUnit: used when either face has no chin (hand-placed points with Skip): both faces are then measured in units of 1.9 x the
  // eye spacing instead of eye-line-to-chin, so the two frames still mean the same thing. With no nose, mouth or chin the midline
  // is unknown and the frame is not turned.
  const EYE_UNIT = 1.9;
  function frameOf(P, eyeUnit) {
    const A = P.eyeMid; let sx = 0, sy = 0;
    for (const q of [P.noseBase, P.mouthMid, P.chin]) if (q) { sx += q.x - A.x; sy += q.y - A.y; }
    const theta = (sx || sy) ? Math.atan2(sx, sy) : 0, c = Math.cos(theta), s = Math.sin(theta);
    const ec = Math.max(1e-6, eyeUnit ? EYE_UNIT * dist(P.eyeR, P.eyeL) : dist(P.chin, A));
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
    if (!Dp.eyeMid || !Rp.eyeMid) return { ok: false, reason: 'missing eyeMid' };
    const eyeUnit = !(Dp.chin && Rp.chin), hasMidline = !!((Dp.noseBase || Dp.mouthMid || Dp.chin) && (Rp.noseBase || Rp.mouthMid || Rp.chin));
    const fd = frameOf(Dp, eyeUnit), fr = frameOf(Rp, eyeUnit);
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
    // fit residuals (% of EC) of the stable points: how far the drawing's landmarks sit from the reference's after the best similarity.
    // A noise / style proxy: a close copy leaves little, a stylised or loose drawing leaves more.
    const resid = names.map(n => Math.hypot(ND[n].x - (k * NR[n].x + t.x), ND[n].y - (k * NR[n].y + t.y)) * 100).sort((a, b) => a - b);
    const residual = resid.length ? { median: resid[resid.length >> 1], mean: resid.reduce((s, v) => s + v, 0) / resid.length, max: resid[resid.length - 1], n: resid.length } : { median: 0, mean: 0, max: 0, n: 0 };
    const locked = (LOCK_BY_SIZE[sizeUsed] || []).concat(pinUsed !== 'auto' && LOCK_BY_PIN[pinUsed] ? LOCK_BY_PIN[pinUsed] : []);
    return {
      ok: true, scale, rotation: phi, rotationDeg: deg(phi), tx, ty, matchTilt, eyeUnit, hasMidline,
      tiltDiff: hasMidline ? -deg(fd.theta - fr.theta) : 0,
      size: { requested: o.size || 'auto', used: sizeUsed, note },
      pin: { requested: typeof pinReq === 'object' ? 'custom' : pinReq, used: pinUsed, reference: pinR, drawing: pinD },
      locked: Array.from(new Set(locked)),
      frame: { k, t, drawing: { ox: fd.A.x, oy: fd.A.y, theta: fd.theta, ec: fd.ec }, reference: { ox: fr.A.x, oy: fr.A.y, theta: fr.theta, ec: fr.ec } },
      unit: eyeUnit ? { reference: [copy(Rp.eyeR), copy(Rp.eyeL)], drawing: [copy(Dp.eyeR), copy(Dp.eyeL)], ecReference: fr.ec, ecDrawing: fd.ec }
        : { reference: [copy(Rp.eyeMid), copy(Rp.chin)], drawing: [copy(Dp.eyeMid), copy(Dp.chin)], ecReference: fr.ec, ecDrawing: fd.ec },
      fit: { kind: 'robust-l1-irls', iterations, names, residual },
    };
  }
  /** residuals(drawingFs, referenceFs, alignment, names) -> sorted % of EC distances of the named points after the alignment (the aligned frame, rotated and
      scaled as in measure). `names` defaults to the stable points. Used as a noise / style proxy. */
  const RESIDUAL_NAMES = ['eyeL', 'eyeR', 'noseBase', 'mouthL', 'mouthR', 'chin', 'jawLowL', 'jawLowR', 'jawHighL', 'jawHighR', 'cheekL', 'cheekR', 'noseAlaL', 'noseAlaR', 'eyeCornerOuterL', 'eyeCornerOuterR', 'browMidL', 'browMidR'];
  function residuals(DF, RF, al, names) {
    const Dp = resolve(DF), Rp = resolve(RF), fd = frameOf(Dp, al.eyeUnit), fr = frameOf(Rp, al.eyeUnit), { k, t } = al.frame, out = [];
    for (const n of (names || RESIDUAL_NAMES)) if (Dp[n] && Rp[n]) { const a = toN(fd, Dp[n]), b = toN(fr, Rp[n]); out.push(Math.hypot((a.x - t.x) / k - b.x, (a.y - t.y) / k - b.y) * 100); }
    return out.sort((x, y) => x - y);
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

  // ------------------------------------------------------------------------------------------ robustness helpers
  /** withoutRegions(fs, missing) -> copy of the features without the points of regions that are not drawn ('nose' | 'mouth' | 'chin'),
      so the engine neither measures nor aligns on landmarks the face finder made up. */
  const REGION_POINTS = { nose: ['noseTip', 'noseBase', 'noseAlaR', 'noseAlaL'], mouth: ['mouthR', 'mouthL', 'mouthCentre', 'lipUpper', 'lipLower'], chin: ['chin', 'jawLowR', 'jawLowL', 'jawHighR', 'jawHighL'] };
  function withoutRegions(fs, missing) {
    const pts = Object.assign({}, fs.points); for (const r of (missing || [])) for (const n of (REGION_POINTS[r] || [])) pts[n] = null;
    return { source: fs.source, flipped: fs.flipped, points: pts, dropped: (missing || []).slice() };
  }
  /** Which items cannot be measured when a region is not drawn (for the "not checked" note). */
  const REGION_ITEMS = { nose: ['nose_length', 'nose_width'], mouth: ['mouth_height', 'mouth_width'], chin: ['chin_length', 'jaw_width', 'jaw_width_high'] };

  /** mirrorScore(drawingPoints, referencePoints) -> correlation (-1..1) of the left/right asymmetry patterns of two MediaPipe faces, or null.
      31 symmetric landmark pairs in the midline frame (nose bridge -> chin), in eye-distance units: the residual asymmetry (one eye
      higher, one cheek wider) is a property of the person, so a mirrored drawing correlates negatively with its photo. */
  const SYM = [[33, 263], [133, 362], [159, 386], [145, 374], [70, 300], [63, 293], [105, 334], [66, 296], [107, 336], [129, 358], [98, 327], [61, 291], [37, 267], [84, 314], [205, 425], [50, 280], [116, 345], [132, 361], [172, 397], [234, 454], [58, 288], [93, 323], [136, 365], [150, 379], [127, 356], [162, 389], [21, 251], [54, 284], [103, 332], [67, 297], [468, 473]];
  function asymVec(p) {
    const a = p[168], b = p[152], ang = Math.atan2(b.x - a.x, b.y - a.y), c = Math.cos(ang), s = Math.sin(ang), iod = Math.hypot(p[468].x - p[473].x, p[468].y - p[473].y), v = [];
    if (!(iod > 1e-6)) return null;
    const T = i => { const x = p[i].x - a.x, y = p[i].y - a.y; return { x: (x * c - y * s) / iod, y: (x * s + y * c) / iod }; };
    for (const [l, r] of SYM) { const A = T(l), B = T(r); v.push(A.x + B.x, B.y - A.y); }
    return v;
  }
  function mirrorScore(dp, rp) {
    if (!dp || !rp || dp.length < 478 || rp.length < 478) return null;
    const a = asymVec(dp), b = asymVec(rp); if (!a || !b) return null;
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length; let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
    return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : null;
  }
  const MIRROR = { threshold: 0, flippedMin: 0.2 }; // prompt when corr(drawing, photo) < threshold and corr(flipped drawing, photo) > flippedMin

  /** pickFaces(drawingFaces, referenceFaces) -> { d, r, cost } indexes of the pair that match best: for every pair the drawing is
      coarsely aligned to the reference (robust fit) and the pair with the smallest leftover (median residual of 18 stable points)
      wins; a small penalty per rank keeps the larger face on ties. Faces: [{ points, detector }]. */
  function pickFaces(DFs, RFs, opts) {
    const o = opts || {}, nd = (DFs || []).length, nr = (RFs || []).length;
    if (nd <= 1 && nr <= 1) return { d: 0, r: 0, cost: null, multiple: false };
    let best = { d: 0, r: 0, cost: Infinity };
    for (let i = 0; i < nd; i++) for (let j = 0; j < nr; j++) {
      let cost = Infinity;
      try {
        const D = features(DFs[i].points, DFs[i].detector || DFs[i].source), R = features(RFs[j].points, RFs[j].detector || RFs[j].source), al = align(D, R, {});
        if (al.ok) { const rs = residuals(D, R, al); if (rs.length >= 6) cost = rs[rs.length >> 1] + (o.rankPenalty === undefined ? 0.5 : o.rankPenalty) * (i + j); }
      } catch (_) { /* a face that cannot be measured never wins */ }
      if (cost < best.cost) best = { d: i, r: j, cost };
    }
    if (!isFinite(best.cost)) return { d: 0, r: 0, cost: null, multiple: true };
    return Object.assign(best, { multiple: true });
  }
  // ------------------------------------------------------------------------------------------ items
  // terms: [point, axis, weight]. value = sum(weight * (drawing coord - reference coord)) in the aligned, midline-compensated
  // frame, in units of 100 * EC. movable: the points an arrow moves (the others are fixed by the reference).
  // dir: [name when value < 0, name when value > 0]. sentence: key per direction (templates live in the UI's catalogue).
  const ITEMS = [
    { key: 'eye_spacing', feature: 'eyes', kind: 'proportion', side: 'both', rel: 'high', terms: [['eyeL', 'x', .5], ['eyeCornerInnerL', 'x', .5], ['eyeR', 'x', -.5], ['eyeCornerInnerR', 'x', -.5]], alt: [['eyeL', 'x', 1], ['eyeR', 'x', -1]], arrowK: .5, movable: ['eyeR', 'eyeL'], span: ['eyeR', 'eyeL'], dir: ['too_close', 'too_far_apart'], sentence: ['eyes_too_close', 'eyes_too_far_apart'], width: true },
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
    const Dp = resolve(DF), Rp = resolve(RF), fd = frameOf(Dp, al.eyeUnit), fr = frameOf(Rp, al.eyeUnit), { k, t } = al.frame;
    const factor = tolFactor(o.tolerance) * (DETECTOR_TOLERANCE_SCALE[DF.source] || 1), preset = typeof o.tolerance === 'string' ? o.tolerance : (o.tolerance === undefined ? 'usual' : 'custom');
    const gainT = o.gain === 'none' ? {} : (o.gain && typeof o.gain === 'object' ? o.gain : (GAIN[DF.source] || {}));
    const adaptive = DF.source === 'mediapipe' && RF.source === 'mediapipe' && o.bias !== 'none' && o.gain !== 'none' && !(o.gain && typeof o.gain === 'object') && !(o.bias && typeof o.bias === 'object');
    const styleMode = STYLES.includes(o.style) ? o.style : 'auto';
    const resList = adaptive && styleMode === 'auto' && !al.eyeUnit ? residuals(DF, RF, al) : []; // eye-spacing units (no chin): the residual is not comparable, so Auto assumes a realistic copy
    const noise = styleMode === 'realistic' ? ADAPT.realistic : styleMode === 'stylised' ? ADAPT.stylised : (resList.length >= 8 ? resList[resList.length >> 1] : ADAPT.realistic);
    const tolMul = adaptive ? Math.min(ADAPT.M, Math.max(1, noise / ADAPT.r0)) : 1, lvl = adaptive ? (tolMul - 1) / (ADAPT.M - 1) : 0;
    const rc = adaptive ? Math.min(ADAPT.biasSpan, Math.max(0, noise - ADAPT.biasFrom)) : 0, slopeT = adaptive ? (BIAS_SLOPE.mediapipe || {}) : {};
    const gainS = adaptive ? GAIN_STYLISED.mediapipe : {}, gainD = adaptive ? DECIDE_GAIN.mediapipe : {};
    const biasT = o.bias === 'none' ? {} : (o.bias && typeof o.bias === 'object' ? o.bias : (BIAS[DF.source] || {}));
    const N2 = n => { const q = toN(fd, Dp[n]); return { x: (q.x - t.x) / k, y: (q.y - t.y) / k }; }; // drawing point in the aligned reference frame
    const NR = n => toN(fr, Rp[n]);
    const items = [], locked = new Set(al.locked);
    // pose: nose offset from the eye midline as a fraction of eye distance
    const yawOf = (P, f) => { const nt = P.noseTip || P.noseBase; if (!nt) return 0; const a = toN(f, nt), e = toN(f, P.eyeMid), r = toN(f, P.eyeR), l = toN(f, P.eyeL); return (a.x - e.x) / Math.max(1e-6, Math.abs(l.x - r.x)); };
    const pose = { drawingYaw: yawOf(Dp, fd), referenceYaw: yawOf(Rp, fr) };
    pose.differs = Math.abs(pose.drawingYaw - pose.referenceYaw) > POSE.diff;
    pose.large = Math.max(Math.abs(pose.drawingYaw), Math.abs(pose.referenceYaw)) > POSE.large;
    pose.which = pose.large ? (Math.abs(pose.drawingYaw) > POSE.large && Math.abs(pose.referenceYaw) > POSE.large ? 'both' : Math.abs(pose.drawingYaw) > POSE.large ? 'drawing' : 'reference') : null;
    const cosYaw = y => Math.sqrt(1 - Math.min(0.85, (y / POSE.perSin) ** 2)), yawComp = o.yawComp === undefined ? POSE.compensate : !!o.yawComp;
    const widthScale = cosYaw(pose.referenceYaw) / cosYaw(pose.drawingYaw); // a width on a head turned by theta is cos(theta) of its frontal width
    pose.compensated = yawComp && Math.abs(widthScale - 1) > 1e-4;
    const warnings = []; if (pose.differs) warnings.push({ key: 'heads_turned_differently', drawing: pose.drawingYaw, reference: pose.referenceYaw });
    if (pose.large) warnings.push({ key: 'head_turned_far', which: pose.which, drawing: pose.drawingYaw, reference: pose.referenceYaw });
    if (al.size.note) warnings.push({ key: 'size_fallback', note: al.size.note });

    const toRefPx = p => apply(al, p);
    for (const it0 of (o.items || ITEMS)) {
      let it = it0; // an item may name a fallback definition (alt) for faces that lack a point (hand-placed points have no eye corners)
      if (!it.terms.every(([n]) => Dp[n] && Rp[n])) { if (it.alt && it.alt.every(([n]) => Dp[n] && Rp[n])) it = Object.assign({}, it, { terms: it.alt, arrowK: 1 }); else continue; }
      let raw = 0, wD = 0, wR = 0; for (const [n, ax, w] of it.terms) { const a = N2(n)[ax], b = NR(n)[ax]; raw += w * (a - b); wD += w * a; wR += w * b; }
      raw *= 100;
      if (it.width && yawComp) raw = 100 * (wD * widthScale - wR); // widths of a turned head: compare at the same (frontal) yaw
      items.push(finish(it, raw));
    }
    // head tilt (degrees, clockwise +); needs a midline (nose, mouth or chin) in both faces
    if (al.hasMidline !== false) {
      const raw = al.tiltDiff;
      items.push(finish({ key: 'head_tilt', feature: 'head', kind: 'tilt', side: null, rel: 'high', unit: 'deg', dir: ['tilted_anticlockwise', 'tilted_clockwise'], sentence: ['head_tilted_anticlockwise', 'head_tilted_clockwise'], terms: [], movable: [], degrees: true }, raw));
    }
    function finish(it, raw) {
      const unit = it.unit || '%', isLocked = locked.has(it.key);
      const bias = (typeof biasT[it.key] === 'number' ? biasT[it.key] : 0) + (slopeT[it.key] || 0) * rc;
      const gcl = v => Math.max(1 / MAX_GAIN_CORRECTION, Math.min(1, typeof v === 'number' ? v : 1));
      const gLo = gcl(gainT[it.key]), gain = typeof gainS[it.key] === 'number' ? gLo + (gcl(gainS[it.key]) - gLo) * lvl : gLo;
      const gDec = typeof gainD[it.key] === 'number' ? gcl(gainD[it.key]) : gain; // decisions use the pooled gain the thresholds were tuned with
      const value = (raw - bias) / gain, tol = (it.tol !== undefined ? it.tol : TOLERANCE[it.key]) * factor * tolMul * gDec / gain;
      const over = !isLocked && Math.abs(value) > tol;
      const severity = !over ? 'none' : (it.possibleOnly ? 'possible' : (Math.abs(value) >= 2 * tol ? 'major' : 'minor'));
      const pos = value > 0, direction = Math.abs(value) < 1e-9 ? null : it.dir[pos ? 1 : 0];
      const item = {
        key: it.key, feature: it.feature, kind: it.kind, unit, value, raw, bias, percent: displayPercent(value, tol), direction, severity, tolerance: tol,
        flagged: over, locked: isLocked, approximate: !!(it.width && (pose.differs || pose.large)), side: it.side, reliability: it.rel,
        points: Array.from(new Set(it.terms.map(x => x[0]))), span: it.span || null, pointData: {}, arrows: [], groupedUnder: null,
        sentence: over || Math.abs(value) > 0 ? { key: it.sentence[pos ? 1 : 0], [unit === 'deg' ? 'd' : 'n']: item_n(value, tol, unit), side: it.side } : null,
        rankScore: over ? (it.possibleOnly ? -1000 : 0) + Math.abs(value) / tol : 0,
      };
      // arrows: minimum-norm move of the movable points along the term axes that cancels the (bias-corrected) value
      if (it.terms.length && !isLocked) {
        const movW = it.terms.filter(([n]) => it.movable.includes(n)), den = movW.reduce((s, [, , w]) => s + w * w, 0) || 1, per = {};
        const scaleN = unit === '%' ? value / 100 : 0;
        for (const [n, ax, w] of movW) { const e = (per[n] = per[n] || { x: 0, y: 0 }); e[ax] += -scaleN * w / den * (it.arrowK || 1); }
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
    const style = { mode: styleMode, noise, adaptive, level: lvl, factor: tolMul, label: lvl >= 0.5 ? 'stylised' : 'realistic' };
    return {
      ok: true, items, byKey, flagged, close, locked: Array.from(locked), groups, warnings, pose, style, tilt: byKey.head_tilt,
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
    if (!Dp.chin || !Rp.chin) return null;
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

  // ------------------------------------------------------------------------------------------ free point pairs (non-face subjects)
  // The user marks the same spots on the reference and on the drawing. pairs: [{ drawing: {x,y}, reference: {x,y} }] (each in its own
  // image's pixels). alignPairs fits scale + translation (never a turn) by the same robust L1 / IRLS fit as the face alignment, so a
  // single wrongly matched spot does not drag the others. measurePairs reports, for every pair, how far the drawing's spot is from
  // where the reference puts it, as a % of the reference points' overall spread (the diagonal of their bounding box).
  const PAIR_TOLERANCE = 4;                                 // usual, % of the spread; Strict = 0.72x, Relaxed = 2x; major = 2x
  const PAIRS_MAX = 12;
  const pairOk = p => p && ok(p.drawing) && ok(p.reference);
  function spreadOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return Math.hypot(x1 - x0, y1 - y0);
  }
  /** alignPairs(pairs) -> alignment (same fields place() needs: scale, rotation 0, tx, ty) or { ok: false, reason }. Needs two pairs. */
  function alignPairs(pairs) {
    const list = (pairs || []).filter(pairOk);
    if (list.length < 2) return { ok: false, reason: 'needs two pairs' };
    const R = list.map(p => p.reference), D = list.map(p => p.drawing), sr = spreadOf(R), sd = spreadOf(D);
    if (!(sr > 1e-6 && sd > 1e-6)) return { ok: false, reason: 'points too close together' };
    const cr = meanPts(R), cd = meanPts(D), nr = {}, nd = {}, names = [];
    list.forEach((_, i) => { names.push(i); nr[i] = { x: (R[i].x - cr.x) / sr, y: (R[i].y - cr.y) / sr }; nd[i] = { x: (D[i].x - cd.x) / sd, y: (D[i].y - cd.y) / sd }; });
    const f = fitJoint(nr, nd, names); // nr = k * nd + t
    const scale = f.k * sr / sd;
    if (!(scale > 0 && Number.isFinite(scale))) return { ok: false, reason: 'degenerate fit' };
    const tx = cr.x + f.t.x * sr - scale * cd.x, ty = cr.y + f.t.y * sr - scale * cd.y;
    return { ok: true, scale, rotation: 0, rotationDeg: 0, tx, ty, matchTilt: false, tiltDiff: 0, size: { requested: 'pairs', used: 'pairs', note: null },
      pin: { requested: 'auto', used: 'auto', reference: cr, drawing: cd }, locked: [], spread: sr, pairs: list.length,
      unit: { reference: [R[0], R[1]], drawing: [D[0], D[1]], ecReference: sr, ecDrawing: sd }, fit: { kind: 'robust-l1-irls', iterations: f.iterations } };
  }
  /** measurePairs(pairs, alignment, { tolerance }) -> { ok, items, flagged (largest first), close: [pair numbers], summary }
      item: { index (1-based pair number), dx, dy (drawing minus reference, % of the spread, + = right / down), magnitude, severity, flagged,
              tolerance, direction ('too_far_left' | 'too_far_right' | 'too_high' | 'too_low', the larger axis), sentence: { key, k, n },
              arrow: { from: drawing point, to: where the reference puts it (drawing px) }, rankScore } */
  function measurePairs(pairs, al, options) {
    if (!al || !al.ok) return { ok: false, items: [], flagged: [], close: [], summary: { count: 0, major: 0 } };
    const o = options || {}, list = (pairs || []).filter(pairOk), sr = al.spread, tol = PAIR_TOLERANCE * tolFactor(o.tolerance);
    const items = list.map((p, i) => {
      const q = apply(al, p.drawing), dx = (q.x - p.reference.x) / sr * 100, dy = (q.y - p.reference.y) / sr * 100, mag = Math.hypot(dx, dy);
      const horizontal = Math.abs(dx) >= Math.abs(dy), over = mag > tol;
      const direction = horizontal ? (dx < 0 ? 'too_far_left' : 'too_far_right') : (dy < 0 ? 'too_high' : 'too_low');
      return { key: 'pair' + (i + 1), index: i + 1, dx, dy, magnitude: mag, tolerance: tol, flagged: over, severity: !over ? 'none' : (mag >= 2 * tol ? 'major' : 'minor'), direction,
        sentence: { key: 'point_' + direction, k: i + 1, n: Math.max(1, Math.round(horizontal ? Math.abs(dx) : Math.abs(dy))) },
        arrow: { from: copy(p.drawing), to: invert(al, p.reference) }, rankScore: mag / tol };
    });
    const flagged = items.filter(i => i.flagged).sort((a, b) => b.rankScore - a.rankScore);
    return { ok: true, items, flagged, close: items.filter(i => !i.flagged).map(i => i.index), tolerance: { factor: tolFactor(o.tolerance), base: PAIR_TOLERANCE },
      summary: { count: flagged.length, major: flagged.filter(i => i.severity === 'major').length, overPercent: tol } };
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
    features, fromPoints, resolve, align, residuals, RESIDUAL_NAMES, measure, distortionGrid, analyse, alignPairs, measurePairs, PAIRS_MAX, PAIR_TOLERANCE, apply, invert, toLayerTransform, displayPercent,
    withoutRegions, REGION_ITEMS, mirrorScore, MIRROR, pickFaces, TOLERANCE, TOLERANCE_PRESETS, BIAS, GAIN, POSE, ADAPT, BIAS_SLOPE, GAIN_STYLISED, DECIDE_GAIN, STYLES, MAX_GAIN_CORRECTION, DETECTOR_TOLERANCE_SCALE, ITEM_KEYS, INDEX: { mediapipe: MP, faceapi: FA }, SIZE_MODES,
  };
})();

