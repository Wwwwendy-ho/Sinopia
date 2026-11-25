// Body (figure) proportions engine: pure functions (no DOM, no network). Compares two sets of NAMED BODY POINTS (placed by hand,
// or mapped from MediaPipe's Pose Landmarker) and returns structured discrepancies (keys and numbers, no English).
// Method, tolerances and validation numbers: review/proportions-body-hands-outline.md. Same contract as proportions.js (the face engine).
//
// Public API (window.DrawingCompare.BodyProportions)
//   fromPoints(named, opts?)      named {name: {x,y}} (subject's OWN left/right) -> fs { source, points, foreshortened, derived }
//   fromPose(pose, opts?)         one pose from DC.Landmarks.pose().poses[i] (33 points) -> fs (source 'pose')
//   resolve(fs)                   points + derived points (neck if absent, shoulderMid, hipC, headH ...)
//   align(drawingFs, referenceFs, opts)   similarity (scale + translation, rotation 0 unless matchTilt) drawing -> reference px
//   measure(drawingFs, referenceFs, alignment, opts)   report { items, flagged, close, groups, warnings, notChecked, info, ... }
//   analyse(drawingFs, referenceFs, opts)   align + measure in one call
//   mirrorCheck(drawingFs, referenceFs, alignment)   { mirrored, direct, swapped } (is the drawing a left/right mirror?)
//   apply / invert / toLayerTransform   the alignment similarity (same maths as DC.Proportions)
//
// Point names (subject's own side; L / R suffix): headTop, chin, neck (pit of the neck), shoulderL/R, elbowL/R, wristL/R, hipL/R, kneeL/R,
// ankleL/R; optional heelL/R, toeL/R (balance only). Missing points are fine: items that need them are skipped and listed in notChecked.
// Segments: upperArm (shoulder-elbow), forearm (elbow-wrist), thigh (hip-knee), shin (knee-ankle), each side.
//
// Conventions: pixel coordinates of each image (origin top-left, y down); alignment maps drawing -> reference:
//   p_ref = scale * R(rotation) * p_draw + (tx, ty), rotation in radians, positive = clockwise on screen (0 unless matchTilt).
//   Discrepancies are "drawing minus reference" after alignment, then (raw - bias) / gain. Units: heads (reference head height, or the
//   fallback named in report.unit.kind) for figure-scale lengths and placements, % of the reference segment for single segments,
//   degrees for angles (clockwise on screen +). Items measured "in the lean-removed frame" first rotate each figure about its pit of
//   the neck so that its torso axis (neck to hip centre) is straight down.
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const DC = root.DrawingCompare = root.DrawingCompare || {};

  // ------------------------------------------------------------------------------------------ names and tables
  const SIDES = ['R', 'L'];
  const NAMES = ['headTop', 'chin', 'neck', 'shoulderR', 'shoulderL', 'elbowR', 'elbowL', 'wristR', 'wristL', 'hipR', 'hipL', 'kneeR', 'kneeL', 'ankleR', 'ankleL', 'heelR', 'heelL', 'toeR', 'toeL'];
  const SEGMENTS = { upperArm: ['shoulder', 'elbow'], forearm: ['elbow', 'wrist'], thigh: ['hip', 'knee'], shin: ['knee', 'ankle'] };
  const SEG_ORDER = ['upperArm', 'forearm', 'thigh', 'shin'];
  const POSE_INDEX = { nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8, mouthL: 9, mouthR: 10, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32 };
  const POSE_VISIBILITY = 0.5, NECK_RAISE = 0.12;

  // Usual tolerances (after bias/gain). Units: heads, %, degrees. Starting values are SPEC-phase3 3.4; TUNED (below) overrides them
  // with the values chosen on the calibration half of the planted suite (review/proportions-body-hands-outline.md).
  const TOLERANCE_PRESETS = { strict: 0.72, usual: 1, relaxed: 2 };
  const TOLERANCE_SPEC = { height: 0.2, legs: 0.2, leg: 0.2, torso: 5, shoulder_width: 6, hip_width: 7, segment: 7, reach: 0.2, shoulder_tilt: 3, hip_tilt: 3, contrapposto: 4, limb_angle: 6, gesture_lean: 4, gesture_bow: 3, lean: 3, balance: 0.15, joint: 0.2 };
  const TOLERANCE_TUNED = {};   // filled in by the validation (see end of file)
  const TOLERANCE = Object.assign({}, TOLERANCE_SPEC);
  // bias / gain per detector source: value = (raw - bias) / gain, gain floored at MIN_GAIN. Manual points: bias 0, gain 1.
  const MIN_GAIN = 0.5;
  // Pose source (reference detected by the Pose Landmarker, drawing placed by hand): median signed value of each item over 169 found figures of PoPArt originals,
  // drawing = COCO ground truth as manual points, reference = detected pose (review document, "Pose path"). The BlazePose joints and the COCO / coach joints are
  // not defined identically (limbs read shorter, hips narrower in the detector), so the offsets are removed before comparing.
  const BIAS = { manual: {}, pose: { torso: 2.8, shoulder_width: 2.0, hip_width: 26.0, segment_upperArm: 15.2, segment_forearm: 24.0, segment_thigh: 27.8, segment_shin: 19.6, reach: 0.05, height: 0.55, leg: 0.68, legs: 0.41, shoulder_tilt: -0.8, hip_tilt: -1.6, contrapposto: 0.9, limb_angle: -2.0, lean: 0.8, gesture_lean: 0.75, gesture_bow: 2.6, balance: 0.04 } };
  const GAIN = { manual: {}, pose: {} };
  // Extra noise of a source relative to hand-placed points: tolerances grow by the larger of the two sides' factor.
  const SOURCE_SCALE = { manual: 1, pose: 1.0 };
  const WEIGHT = 1.0, RELIABILITY = { exact: 1, approx: 0.5, possible: 0.3 };
  const POSE_DIFFERENT_DEG = 25;
  // Tap / detector noise model: rms radial error of one point, in head heights (a tap placed with the zoom lens is about 0.5 to 1% of a figure about 7.5 heads tall = 0.055 heads; plain taps 1 to 2% = 0.11 heads, pass opts.tapNoise).
  // Items are only flagged beyond KAPPA x their expected noise (set by the planted-error sweep, see the review document).
  const TAP_NOISE = { manual: 0.055, pose: 0.3 };
  const KAPPA = 4.5;

  // ------------------------------------------------------------------------------------------ small math
  const ok = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const copy = p => ({ x: p.x, y: p.y });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const swapSide = n => /R$/.test(n) ? n.slice(0, -1) + 'L' : /L$/.test(n) ? n.slice(0, -1) + 'R' : n;
  /** clockwise-on-screen angle (degrees) of vector v from straight down: (0, 1) -> 0, (-1, 0) -> +90. */
  const cw = v => deg(Math.atan2(-v.x, v.y));
  const wrap180 = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };
  /** fold an angle of an undirected line into (-90, 90] */
  const foldLine = a => { a = wrap180(a); if (a > 90) a -= 180; else if (a <= -90) a += 180; return a; };
  const rot = (p, o, phi) => { const c = Math.cos(phi), s = Math.sin(phi), x = p.x - o.x, y = p.y - o.y; return { x: o.x + c * x - s * y, y: o.y + s * x + c * y }; };

  // ------------------------------------------------------------------------------------------ features
  const round1 = v => Math.round(v * 10) / 10;
  /** fromPoints(named, opts) -> fs. opts: { source: 'manual', foreshortened: { 'forearmL': true | ratio } } (a segment key = part + side;
      true = "the artist marked this limb as foreshortened"). Hand-placed points: a missing neck is derived from the shoulders. */
  function fromPoints(named, opts) {
    const o = opts || {}, pts = {};
    for (const k of NAMES) pts[k] = named && ok(named[k]) ? copy(named[k]) : null;
    const fs = { source: o.source || 'manual', points: pts, foreshortened: Object.assign({}, o.foreshortened || {}), derived: {}, flipped: false };
    return fs;
  }
  const poolPts = (p, ids) => { const a = ids.map(i => p[i]).filter(Boolean); return a.length ? { x: a.reduce((s, q) => s + q.x, 0) / a.length, y: a.reduce((s, q) => s + q.y, 0) / a.length } : null; };
  /** fromPose(pose, opts) -> fs. pose: { points: [33 {x,y,z,visibility}], world: [33 {x,y,z}] } from DC.Landmarks.pose(). A point is used only when its
      visibility >= opts.minVisibility (0.5). neck = shoulder midpoint raised 0.12 x shoulder width toward the head; chin and crown come from the face
      points: along the head axis (eye midpoint -> mouth midpoint, a), chin = mouth midpoint + 0.8 a, crown = eye midpoint - 1.8 a (anatomical canon, NOT
      calibrated against ground truth: COCO and PoPArt have no head-top or chin labels), so head-based units from a detected pose are approximate (fs.approx.head).
      Foreshortening of each segment = (2D length / 2D torso) / (3D length / 3D torso) from worldLandmarks; below 0.8 the segment is foreshortened. */
  function fromPose(pose, opts) {
    const o = Object.assign({ minVisibility: POSE_VISIBILITY }, opts || {}), P = {}, vis = {};
    const get = i => { const p = pose.points[i]; return p && Number.isFinite(p.x) && (p.visibility === undefined || p.visibility >= o.minVisibility) ? copy(p) : null; };
    for (const k of Object.keys(POSE_INDEX)) { P[k] = get(POSE_INDEX[k]); vis[k] = pose.points[POSE_INDEX[k]] ? pose.points[POSE_INDEX[k]].visibility : null; }
    const pts = {}; for (const k of NAMES) pts[k] = P[k] || null;
    const sM = P.shoulderL && P.shoulderR ? mid(P.shoulderL, P.shoulderR) : null, hM = P.hipL && P.hipR ? mid(P.hipL, P.hipR) : null;
    if (sM) {
      const sw = dist(P.shoulderL, P.shoulderR); let ax = { x: 0, y: -1 };
      if (hM && dist(sM, hM) > 1e-6) { const d = dist(sM, hM); ax = { x: (sM.x - hM.x) / d, y: (sM.y - hM.y) / d }; }
      pts.neck = { x: sM.x + ax.x * NECK_RAISE * sw, y: sM.y + ax.y * NECK_RAISE * sw };
    }
    const eyeM = poolPts(P, ['eyeL', 'eyeR']), mouthM = poolPts(P, ['mouthL', 'mouthR']), earM = poolPts(P, ['earL', 'earR']);
    if (eyeM && mouthM) {
      const a = sub(mouthM, eyeM); pts.chin = { x: mouthM.x + 0.8 * a.x, y: mouthM.y + 0.8 * a.y }; pts.headTop = { x: eyeM.x - 1.8 * a.x, y: eyeM.y - 1.8 * a.y };
    }
    const fs = { source: 'pose', points: pts, foreshortened: {}, derived: { neck: !!pts.neck, chin: !!pts.chin, headTop: !!pts.headTop }, approx: { head: true }, flipped: false, visibility: vis, earMid: earM };
    // foreshortening from the world landmarks
    const W = pose.world;
    if (W && W.length >= 33 && sM && hM) {
      const wp = i => W[i] && Number.isFinite(W[i].x) ? W[i] : null, w3 = (a, b) => (a && b) ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null;
      const wsM = wp(11) && wp(12) ? { x: (W[11].x + W[12].x) / 2, y: (W[11].y + W[12].y) / 2, z: (W[11].z + W[12].z) / 2 } : null, whM = wp(23) && wp(24) ? { x: (W[23].x + W[24].x) / 2, y: (W[23].y + W[24].y) / 2, z: (W[23].z + W[24].z) / 2 } : null;
      const t3 = w3(wsM, whM), t2 = dist(sM, hM);
      if (t3 > 1e-6 && t2 > 1e-6) for (const sg of SEG_ORDER) for (const s of SIDES) {
        const [a, b] = SEGMENTS[sg], na = a + s, nb = b + s;
        if (!(pts[na] && pts[nb])) continue;
        const l3 = w3(wp(POSE_INDEX[na]), wp(POSE_INDEX[nb])); if (!(l3 > 1e-6)) continue;
        fs.foreshortened[sg + s] = (dist(pts[na], pts[nb]) / t2) / (l3 / t3);
      }
    }
    return fs;
  }
  const FORESHORTEN_BELOW = 0.8;
  const foreshort = (fs, key) => { const v = fs.foreshortened && fs.foreshortened[key]; return v === true ? 0.5 : (typeof v === 'number' ? v : 1); };

  /** resolve(fs) -> { P: points (+ derived), headH, unit } .
      Derived: shoulderMid, hipC, neck (from shoulders when not given), headH (crown to chin when both). unit: { kind: 'head' | 'torso' | 'shoulders', px }
      is the length of "one head" used for figure-scale units; fallbacks (head from torso / 2.8, then shoulder width / 1.9) are named in kind. */
  function resolve(fs) {
    const P = {}; for (const k of Object.keys(fs.points)) if (ok(fs.points[k])) P[k] = fs.points[k];
    if (P.shoulderL && P.shoulderR) P.shoulderMid = mid(P.shoulderL, P.shoulderR);
    if (P.hipL && P.hipR) P.hipC = mid(P.hipL, P.hipR);
    if (!P.neck && P.shoulderMid) {
      let ax = { x: 0, y: -1 }; if (P.hipC && dist(P.shoulderMid, P.hipC) > 1e-6) { const d = dist(P.shoulderMid, P.hipC); ax = { x: (P.shoulderMid.x - P.hipC.x) / d, y: (P.shoulderMid.y - P.hipC.y) / d }; }
      const sw = dist(P.shoulderL, P.shoulderR); P.neck = { x: P.shoulderMid.x + ax.x * NECK_RAISE * sw, y: P.shoulderMid.y + ax.y * NECK_RAISE * sw }; P.neckDerived = true;
    }
    const headH = P.headTop && P.chin ? dist(P.headTop, P.chin) : null;
    const torso = P.neck && P.hipC ? dist(P.neck, P.hipC) : null, sw = P.shoulderL && P.shoulderR ? dist(P.shoulderL, P.shoulderR) : null;
    const unit = headH ? { kind: 'head', px: headH } : torso ? { kind: 'torso', px: torso / 2.8 } : sw ? { kind: 'shoulders', px: sw / 1.9 } : null;
    return { P, headH, torso, shoulderWidth: sw, unit };
  }

  // ------------------------------------------------------------------------------------------ robust fits (L1 via IRLS)
  const EPS = 0.004;
  function solveLinear(A, b) {
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
  // all fits below work on normalised points (unit = a figure spread), D ~ k R + t
  function fitJoint(D, R, names) {
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
  function fitScaleAbout(D, R, names, pD, pR) {
    let k = 1;
    for (let it = 0; it < 40; it++) {
      let num = 0, den = 0;
      for (const n of names) for (const ax of ['x', 'y']) { const d = D[n][ax] - pD[ax], r = R[n][ax] - pR[ax], w = 1 / Math.max(Math.abs(d - k * r), EPS); num += w * d * r; den += w * r * r; }
      const nk = den > 1e-12 ? num / den : k, dd = Math.abs(nk - k); k = nk; if (dd < 1e-8) break;
    }
    return k;
  }
  function fitShift(D, R, names, k) {
    const t = { x: 0, y: 0 };
    for (const ax of ['x', 'y']) {
      let v = 0;
      for (let it = 0; it < 40; it++) { let sw = 0, sv = 0; for (const n of names) { const e = D[n][ax] - k * R[n][ax], w = 1 / Math.max(Math.abs(e - v), EPS); sw += w; sv += w * e; } const nv = sv / sw, d = Math.abs(nv - v); v = nv; if (d < 1e-8) break; }
      t[ax] = v;
    }
    return t;
  }

  // ------------------------------------------------------------------------------------------ alignment
  const SIZE_MODES = ['auto', 'head', 'torso', 'shoulders', 'height', 'custom'];
  const PIN_MODES = ['auto', 'neck', 'hips', 'foot'];
  const FIT_NAMES = ['shoulderL', 'shoulderR', 'hipL', 'hipR', 'neck', 'headTop'];
  const LOCK_BY_SIZE = { head: [], torso: ['torso'], shoulders: ['shoulder_width'], height: ['height'], custom: [], auto: [] };
  const lowestFoot = P => { const f = ['ankleR', 'ankleL'].filter(n => P[n]); return f.length ? f.reduce((a, b) => P[a].y >= P[b].y ? a : b) : null; };
  const footPoint = (P, s) => P['heel' + s] && P['toe' + s] ? mid(P['heel' + s], P['toe' + s]) : P['ankle' + s] || null;
  const figureHeight = (P, unitP) => P.headTop && (P.ankleR || P.ankleL) ? Math.max(P.ankleR ? P.ankleR.y : -1e9, P.ankleL ? P.ankleL.y : -1e9) - P.headTop.y : null;

  /** align(drawingFs, referenceFs, options) -> alignment
      options: { size: 'auto'|'head'|'torso'|'shoulders'|'height'|'custom' (default 'auto' = robust L1 fit over shoulders, hips, pit of the neck and head top),
                 custom: { drawing: [p,p], reference: [p,p] },
                 pin: 'auto'|'neck'|'hips'|'foot'|{x,y,drawing?:{x,y}} ({x,y} in REFERENCE pixels), matchTilt: false }
      returns { ok, scale, rotation, rotationDeg, tx, ty, size:{requested,used,note}, pin:{requested,used,reference,drawing}, locked, fit:{names,residual}, leanDiff,
                matchTilt } or { ok:false, reason }. A pin makes the pinned pair coincide and refits the scale about it. */
  function align(DF, RF, options) {
    const o = options || {}, matchTilt = !!o.matchTilt, D = resolve(DF), R = resolve(RF), Dp = D.P, Rp = R.P;
    const names = FIT_NAMES.filter(n => Dp[n] && Rp[n]);
    if (names.length < 3) return { ok: false, reason: 'needs at least three of the shoulders, hips, neck and head top in both pictures' };
    // normalise by each figure's spread about the centroid of the fit points
    const cen = (P) => { let x = 0, y = 0; for (const n of names) { x += P[n].x; y += P[n].y; } return { x: x / names.length, y: y / names.length }; };
    const spread = (P, c) => Math.sqrt(names.reduce((s, n) => s + (P[n].x - c.x) ** 2 + (P[n].y - c.y) ** 2, 0) / names.length) || 1;
    const cD = cen(Dp), cR = cen(Rp), sD = spread(Dp, cD), sR = spread(Rp, cR);
    const ND = {}, NR = {}, nd = p => ({ x: (p.x - cD.x) / sD, y: (p.y - cD.y) / sD }), nr = p => ({ x: (p.x - cR.x) / sR, y: (p.y - cR.y) / sR });
    for (const n of names) { ND[n] = nd(Dp[n]); NR[n] = nr(Rp[n]); }
    // fixed scale (drawing px -> reference px = 1 / ratio) from a size measure
    let sizeUsed = SIZE_MODES.includes(o.size) ? o.size : 'auto', note = null, ratio = null; // ratio = drawing measure / reference measure
    const meas = { head: P => P.headTop && P.chin ? dist(P.headTop, P.chin) : null, torso: P => P.neck && P.hipC ? dist(P.neck, P.hipC) : null, shoulders: P => P.shoulderL && P.shoulderR ? dist(P.shoulderL, P.shoulderR) : null, height: P => figureHeight(P) };
    if (sizeUsed === 'custom') {
      const c = o.custom;
      if (c && c.drawing && c.reference && c.drawing.length === 2 && c.reference.length === 2) ratio = dist(c.drawing[0], c.drawing[1]) / dist(c.reference[0], c.reference[1]);
      else { sizeUsed = 'auto'; note = 'custom size needs two points in each image: sized by robust auto'; }
    } else if (meas[sizeUsed]) {
      const a = meas[sizeUsed](Dp), b = meas[sizeUsed](Rp);
      if (a > 0 && b > 0) ratio = a / b; else { note = 'the ' + sizeUsed + ' measure is missing: sized by robust auto'; sizeUsed = 'auto'; }
    }
    if (ratio !== null && !(ratio > 0 && Number.isFinite(ratio))) { ratio = null; note = 'degenerate size measure: sized by robust auto'; sizeUsed = 'auto'; }
    const SCALE_PAIRS = [
      ['headTop', 'chin', 1.0], ['shoulderL', 'shoulderR', 1.0], ['hipL', 'hipR', 0.8], ['neck', 'hipC', 1.0],
      ['shoulderR', 'elbowR', 0.7], ['shoulderL', 'elbowL', 0.7], ['elbowR', 'wristR', 0.6], ['elbowL', 'wristL', 0.6],
      ['hipR', 'kneeR', 0.7], ['hipL', 'kneeL', 0.7], ['kneeR', 'ankleR', 0.6], ['kneeL', 'ankleL', 0.6],
    ];
    function multiPartScale(Dp_, Rp_) {
      const ratios = []; let totalW = 0;
      for (const [a, b, w] of SCALE_PAIRS) {
        if (!(Dp_[a] && Dp_[b] && Rp_[a] && Rp_[b])) continue;
        const dD = dist(Dp_[a], Dp_[b]), dR = dist(Rp_[a], Rp_[b]);
        if (dD > 1e-6 && dR > 1e-6) { ratios.push({ lr: Math.log(dD / dR), w }); totalW += w; }
      }
      if (ratios.length < 4 || totalW <= 0) return null;
      ratios.sort((x, y) => x.lr - y.lr);
      let acc = 0, half = totalW / 2;
      for (let i = 0; i < ratios.length; i++) {
        acc += ratios[i].w;
        if (acc >= half) return Math.exp(ratios[i].lr);
      }
      return Math.exp(ratios[ratios.length - 1].lr);
    }
    const kFixed = ratio === null ? null : (ratio * sR / sD); // in normalised units: ND = k NR + t -> k = (dMeasure / sD) / (rMeasure / sR)
    const multiRatio = kFixed === null ? multiPartScale(Dp, Rp) : null;
    const kAuto = kFixed !== null ? kFixed : (multiRatio !== null ? multiRatio * sR / sD : null);
    const auto = kAuto === null ? fitJoint(ND, NR, names) : { k: kAuto, t: fitShift(ND, NR, names, kAuto), iterations: 0 };
    const fitKind = kFixed !== null ? 'fixed-size' : (multiRatio !== null ? 'robust-multipart-l1' : 'robust-l1-irls');
    // pin
    const pinReq = o.pin === undefined ? 'auto' : o.pin;
    let pinUsed = 'auto', pinD = null, pinR = null, k = auto.k, t = auto.t;
    const pinPair = name => name === 'neck' ? ['neck', 'neck'] : name === 'hips' ? ['hipC', 'hipC'] : name === 'foot' ? (() => { const f = lowestFoot(Rp); return f && Dp[f] ? [f, f] : null; })() : null;
    if (typeof pinReq === 'string' && PIN_MODES.includes(pinReq) && pinReq !== 'auto' && pinPair(pinReq) && Dp[pinPair(pinReq)[0]] && Rp[pinPair(pinReq)[1]]) {
      const [a, b] = pinPair(pinReq); pinUsed = pinReq; pinD = Dp[a]; pinR = Rp[b];
      const pdn = nd(pinD), prn = nr(pinR);
      if (kAuto === null) k = fitScaleAbout(ND, NR, names, pdn, prn);
      t = { x: pdn.x - k * prn.x, y: pdn.y - k * prn.y };
    } else if (pinReq && typeof pinReq === 'object' && ok(pinReq)) {
      pinUsed = 'custom'; pinR = { x: pinReq.x, y: pinReq.y };
      const prn = nr(pinR), pdn = ok(pinReq.drawing) ? nd(pinReq.drawing) : { x: auto.k * prn.x + auto.t.x, y: auto.k * prn.y + auto.t.y };
      pinD = { x: cD.x + pdn.x * sD, y: cD.y + pdn.y * sD };
      if (kAuto === null) k = fitScaleAbout(ND, NR, names, pdn, prn);
      t = { x: pdn.x - k * prn.x, y: pdn.y - k * prn.y };
    } else { pinD = { x: cD.x + t.x * sD, y: cD.y + t.y * sD }; pinR = copy(cR); }
    // drawing -> reference pixels: p_ref = cR + sR * ((p - cD)/sD - t) / k   (rotation 0)
    const scale = sR / (sD * k);
    const leanD = Dp.neck && Dp.hipC ? cw(sub(Dp.hipC, Dp.neck)) : 0, leanR = Rp.neck && Rp.hipC ? cw(sub(Rp.hipC, Rp.neck)) : 0;
    const phi = matchTilt && Dp.neck && Dp.hipC && Rp.neck && Rp.hipC ? rad(leanR - leanD) : 0, c = Math.cos(phi), s = Math.sin(phi);
    // translation so that pinD maps to pinR whatever the rotation
    const tx = pinR.x - scale * (c * pinD.x - s * pinD.y), ty = pinR.y - scale * (s * pinD.x + c * pinD.y);
    const resid = names.map(n => Math.hypot(ND[n].x - (k * NR[n].x + t.x), ND[n].y - (k * NR[n].y + t.y)) * sR).sort((a, b) => a - b);
    const unitPx = R.unit ? R.unit.px : null;
    return {
      ok: true, scale, rotation: phi, rotationDeg: deg(phi), tx, ty, matchTilt,
      size: { requested: o.size || 'auto', used: sizeUsed, note },
      pin: { requested: typeof pinReq === 'object' ? 'custom' : pinReq, used: pinUsed, reference: pinR, drawing: pinD },
      locked: (LOCK_BY_SIZE[sizeUsed] || []).slice(), leanDiff: leanD - leanR,
      fit: { kind: fitKind, names, iterations: auto.iterations, residual: { median: median(resid), max: resid.length ? resid[resid.length - 1] : 0, medianHeads: unitPx ? median(resid) / unitPx : null } },
    };
  }
  /** apply(alignment, p) -> drawing point in reference pixels */
  function apply(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation); return { x: al.scale * (c * p.x - s * p.y) + al.tx, y: al.scale * (s * p.x + c * p.y) + al.ty }; }
  /** invert(alignment, p) -> reference point in drawing pixels */
  function invert(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation), x = (p.x - al.tx) / al.scale, y = (p.y - al.ty) / al.scale; return { x: c * x + s * y, y: -s * x + c * y }; }
  function invertVec(al, v) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation), x = v.x / al.scale, y = v.y / al.scale; return { x: c * x + s * y, y: -s * x + c * y }; }
  /** toLayerTransform(alignment, drawingSize, referenceSize) -> {x, y, scale, angle} (see DC.Proportions.toLayerTransform) */
  function toLayerTransform(al, dSize, rSize) { const c = apply(al, { x: dSize.w / 2, y: dSize.h / 2 }); return { x: c.x - rSize.w / 2, y: c.y - rSize.h / 2, scale: al.scale, angle: al.rotation }; }

  // ------------------------------------------------------------------------------------------ measure
  const tolFactor = t => typeof t === 'number' ? t : (TOLERANCE_PRESETS[t || 'usual'] || 1);
  function displayCount(v, tol, dec) { // whole number (or one decimal for heads); a value over the tolerance never shows as within it
    const a = Math.abs(v);
    if (dec) { let r = round1(a); if (a > tol && r <= tol + 1e-9) r = Math.floor(tol * 10 + 1e-9) / 10 + 0.1; return Math.round(r * 10) / 10; }
    let r = Math.round(a); if (a > tol && r <= tol) r = Math.floor(tol) + 1; return r;
  }
  const famOf = key => key;
  const sideName = s => s === 'L' ? 'left' : s === 'R' ? 'right' : null;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /** measure(drawingFs, referenceFs, alignment, options) -> report
      options: { tolerance: 'strict'|'usual'|'relaxed'|factor, tolerances: { family: value } (override), bias: 'auto'|'none'|{family:v}, gain: 'auto'|'none'|{family:v},
                 sourceScale: false (turn the per-source tolerance multiplier off) }
      report: { ok, items: [all measured items in a fixed order], byKey, flagged: [ranked], close: [keys within tolerance, not locked], locked, groups, warnings, notChecked,
                info: { headsTall:{drawing,reference}, unit, ... }, tooDifferent, tolerance: {preset, factor}, summary: {count, possible, major}, source }
      item: { key, family, section: 'body', kind: 'length'|'placement'|'angle'|'balance', unit: 'heads'|'%'|'deg', value (signed, drawing minus reference, bias/gain corrected),
              raw, tolerance, flagged, locked, approximate, severity: 'none'|'minor'|'major'|'possible', side: 'left'|'right'|'both'|null (subject's own), part,
              points: [names], span: [nameA, nameB]|null (for the bracket), arrows: [{ point, drawing: {from,to}, reference: {from,to} }],
              sentence: { key, h | n | d, side, part, ... }, groupedUnder, rankScore, reliability: 'exact'|'approx' }
      Sign: + = drawing larger (taller, longer, wider), hand lower, foot further right in the picture, angle more clockwise on screen, lean more to the picture-right. */
  function measure(DF, RF, al, options) {
    const o = options || {};
    if (!al || !al.ok) return { ok: false, reason: al && al.reason || 'no alignment', items: [], flagged: [], close: [], locked: [], groups: [], warnings: [], notChecked: [] };
    const D = resolve(DF), R = resolve(RF), Rp = R.P, factor = tolFactor(o.tolerance);
    const preset = typeof o.tolerance === 'string' ? o.tolerance : (o.tolerance === undefined ? 'usual' : 'custom');
    const srcScale = o.sourceScale === false ? 1 : Math.max(SOURCE_SCALE[DF.source] || 1, SOURCE_SCALE[RF.source] || 1);
    const biasT = o.bias === 'none' ? {} : (o.bias && typeof o.bias === 'object' ? o.bias : (BIAS[DF.source] || {}));
    const gainT = o.gain === 'none' ? {} : (o.gain && typeof o.gain === 'object' ? o.gain : (GAIN[DF.source] || {}));
    const tolT = Object.assign({}, TOLERANCE, o.tolerances || {});
    const unit = R.unit; if (!unit) return { ok: false, reason: 'no unit (head, torso or shoulders missing in the reference)', items: [], flagged: [], close: [], locked: [], groups: [], warnings: [], notChecked: [] };
    const u = unit.px;
    // drawing points in reference px
    const Dm = {}; for (const k of Object.keys(D.P)) if (D.P[k] && typeof D.P[k].x === 'number') Dm[k] = apply(al, D.P[k]);
    const dNeck = Dm.neck, rNeck = Rp.neck;
    const dHip = Dm.hipL && Dm.hipR ? mid(Dm.hipL, Dm.hipR) : null, rHip = Rp.hipC || null;
    const leanOf = (neck, hip) => neck && hip ? cw(sub(hip, neck)) : null;
    const leanD = leanOf(dNeck, dHip), leanR = leanOf(rNeck, rHip);
    // lean-removed frame: rotate about each figure's neck so that neck -> hip centre points straight down
    const fixD = p => leanD === null || !dNeck ? p : rot(p, dNeck, rad(-leanD)), fixR = p => leanR === null || !rNeck ? p : rot(p, rNeck, rad(-leanR));
    const items = [], notChecked = new Set(), warnings = [], locked = new Set(al.locked || []);
    const has = (a, b, ...names) => names.every(n => a[n] && b[n]);
    const sdName = s => sideName(s);
    // Expected size of the tap / detector noise on each item (same unit as the item): the tolerance never goes below KAPPA x this, so a short segment,
    // a narrow hip or a far-away figure (where one tap is a large part of the measure) needs a bigger difference before it is called a difference.
    // r = rms radial error of ONE point in reference pixels (TAP_NOISE x one head); both images contribute: tot = sqrt(2) r.
    const kappa = o.kappa === undefined ? KAPPA : o.kappa, rms = o.tapNoise === 'none' ? 0 : (typeof o.tapNoise === 'number' ? o.tapNoise : Math.max(TAP_NOISE[DF.source] || 0, TAP_NOISE[RF.source] || 0)) * u, tot = Math.SQRT2 * rms;
    const lenR = (a, b) => Rp[a] && Rp[b] ? dist(Rp[a], Rp[b]) : null, sw = lenR('shoulderL', 'shoulderR'), hw = lenR('hipL', 'hipR'), torsoR = R.torso;
    const chordR = (() => { const f = lowestFoot(Rp); return Rp.headTop && f ? dist(Rp.headTop, Rp[f]) : (torsoR ? 3 * torsoR : null); })();
    const segLen = key => { const m = /^(?:seg|ang)_(\w+)_([RL])$/.exec(key); return m ? lenR(SEGMENTS[m[1]][0] + m[2], SEGMENTS[m[1]][1] + m[2]) : null; };
    // two shared error sources besides the taps: the scale of the fit (sigma_k, relative) and the lean removal (sigma_lean, radians)
    const fitN = (al.fit && al.fit.names || []).filter(n => Rp[n]), cR = fitN.length ? { x: fitN.reduce((s, n) => s + Rp[n].x, 0) / fitN.length, y: fitN.reduce((s, n) => s + Rp[n].y, 0) / fitN.length } : null;
    const sFit = cR ? Math.sqrt(fitN.reduce((s, n) => s + (Rp[n].x - cR.x) ** 2 + (Rp[n].y - cR.y) ** 2, 0)) : 0, kScale = sFit > 1e-6 && al.size.used === 'auto' ? (al.fit && al.fit.kind === 'robust-multipart-l1' ? 0.7 : 1) * tot / (Math.SQRT2 * sFit) : 0, leanRad = torsoR > 1e-6 ? tot / torsoR : 0;
    const figH = figureHeightIn(Rp), legLen = (() => { const a = ['R', 'L'].map(s => lenR('hip' + s, 'ankle' + s)).filter(Boolean); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; })();
    function noiseSd(key, family) {
      if (!(rms > 0)) return 0; const inv = v => v > 1e-6 ? tot / v : 0, h2 = (...v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      switch (family) {
        case 'height': return h2(tot / u, (figH || 0) / u * kScale);
        case 'legs': case 'leg': return h2(tot / u, legLen / u * kScale);
        case 'reach': { const s = key.slice(-1), w = Rp['wrist' + s], hp = Rp['hip' + s]; return w && hp ? h2(tot / u, dist(w, hp) / u * h2(kScale, leanRad)) : tot / u; }
        case 'balance': return tot / u;
        case 'joint': { const p = Rp[key.slice(6)]; return h2(1.5 * tot / u, p && Rp.neck ? dist(p, Rp.neck) / u * h2(kScale, leanRad) : 0); }
        case 'torso': return h2(100 * inv(torsoR), 100 * kScale); case 'shoulder_width': return h2(100 * inv(sw), 100 * kScale); case 'hip_width': return h2(100 * inv(hw), 100 * kScale);
        case 'segment': return h2(100 * inv(segLen(key)), 100 * kScale); case 'limb_angle': return deg(h2(inv(segLen(key)), leanRad));
        case 'shoulder_tilt': return deg(h2(inv(sw), leanRad)); case 'hip_tilt': return deg(h2(inv(hw), leanRad));
        case 'contrapposto': return deg(h2(inv(sw), inv(hw), leanRad)); case 'lean': return deg(inv(torsoR));
        case 'gesture_lean': return deg(inv(chordR)); case 'gesture_bow': return 150 * inv(chordR);
        default: return 0;
      }
    }    function add(key, family, kind, unitName, raw, extra) {
      const e = extra || {};
      const biasV = typeof biasT[e.tolFamily || family] === 'number' ? biasT[e.tolFamily || family] : (typeof biasT[family] === 'number' ? biasT[family] : 0), gain = Math.max(MIN_GAIN, typeof gainT[family] === 'number' ? gainT[family] : 1);
      const value = (raw - biasV) / gain, base = tolT[e.tolFamily || family] !== undefined ? tolT[e.tolFamily || family] : (tolT[family] !== undefined ? tolT[family] : 1);
      const sd = noiseSd(key, family), floor = base * factor * srcScale * (e.tolMul || 1), tol = Math.max(floor, kappa * sd * factor), isLocked = locked.has(family) || locked.has(key);
      const approx = !!e.approximate, over = !isLocked && Math.abs(value) > tol;
      const severity = !over ? 'none' : (e.possibleOnly ? 'possible' : (Math.abs(value) >= 2 * tol ? 'major' : 'minor'));
      const it = { key, family, section: 'body', kind, unit: unitName, value, raw, tolerance: tol, flagged: over, locked: isLocked, approximate: approx, severity, side: e.side === undefined ? null : e.side, part: e.part || null,
        points: e.points || [], span: e.span || null, arrows: e.arrows || [], pointData: {}, sentence: null, groupedUnder: null, reliability: approx ? 'approx' : 'exact',
        rankScore: over ? Math.abs(value) / tol * WEIGHT * (e.possibleOnly ? RELIABILITY.possible : (approx ? RELIABILITY.approx : RELIABILITY.exact)) : 0 };
      for (const n of it.points) if (D.P[n] && Rp[n]) it.pointData[n] = { drawing: copy(D.P[n]), reference: copy(Rp[n]), drawingInReference: Dm[n] ? copy(Dm[n]) : null };
      if (e.sentence) it.sentence = e.sentence(value, tol);
      items.push(it); return it;
    }
    const arrowTo = (names, vec) => names.map(n => { // arrow on the drawing's point n by drawing-px vector vec
      const a = D.P[n]; return { point: n, drawing: { from: copy(a), to: { x: a.x + vec.x, y: a.y + vec.y } }, reference: { from: copy(Dm[n]), to: apply(al, { x: a.x + vec.x, y: a.y + vec.y }) } };
    });

    // ---- height (full figure) and info
    const fhD = figureHeightIn(Dm), fhR = figureHeightIn(Rp);
    const info = { unit, headsTall: { drawing: (() => { const own = figureHeightIn(D.P); return own !== null && D.headH ? own / D.headH : (own !== null ? own / (D.unit ? D.unit.px : 1) : null); })(), reference: fhR !== null ? fhR / u : null }, leanDrawing: leanD, leanReference: leanR };
    if (fhD !== null && fhR !== null) {
      const raw = (fhD - fhR) / u;
      add('height', 'height', 'length', 'heads', raw, { points: ['headTop', 'ankleR', 'ankleL'].filter(n => D.P[n] && Rp[n]), span: ['headTop', Dm.ankleL && Dm.ankleR ? (Dm.ankleL.y > Dm.ankleR.y ? 'ankleL' : 'ankleR') : (Dm.ankleL ? 'ankleL' : 'ankleR')],
        sentence: (v, tol) => ({ key: v > 0 ? 'figure_too_tall' : 'figure_too_short', h: displayCount(v, tol, true) }) });
    } else if (D.P.headTop && Rp.headTop) notChecked.add('height');
    // ---- torso, widths
    if (D.torso && R.torso && has(D.P, Rp, 'neck') && D.P.hipC && Rp.hipC) {
      add('torso', 'torso', 'length', '%', (dist(Dm.neck, dHip) - dist(rNeck, rHip)) / dist(rNeck, rHip) * 100, { points: ['neck'], span: ['neck', 'hipC'], sentence: (v, tol) => ({ key: v > 0 ? 'torso_too_long' : 'torso_too_short', n: displayCount(v, tol) }) });
    } else notChecked.add('torso');
    if (has(Dm, Rp, 'shoulderL', 'shoulderR')) add('shoulder_width', 'shoulder_width', 'length', '%', (dist(Dm.shoulderL, Dm.shoulderR) - dist(Rp.shoulderL, Rp.shoulderR)) / dist(Rp.shoulderL, Rp.shoulderR) * 100, { side: 'both', points: ['shoulderR', 'shoulderL'], span: ['shoulderR', 'shoulderL'], sentence: (v, tol) => ({ key: v > 0 ? 'shoulders_too_wide' : 'shoulders_too_narrow', n: displayCount(v, tol) }) }); else notChecked.add('shoulder_width');
    if (has(Dm, Rp, 'hipL', 'hipR')) add('hip_width', 'hip_width', 'length', '%', (dist(Dm.hipL, Dm.hipR) - dist(Rp.hipL, Rp.hipR)) / dist(Rp.hipL, Rp.hipR) * 100, { side: 'both', points: ['hipR', 'hipL'], span: ['hipR', 'hipL'], sentence: (v, tol) => ({ key: v > 0 ? 'hips_too_wide' : 'hips_too_narrow', n: displayCount(v, tol) }) }); else notChecked.add('hip_width');
    // ---- segments
    const segInfo = {}; // key -> {value(%), lenD, lenR, a, b, approx}
    for (const sg of SEG_ORDER) for (const s of SIDES) {
      const [a, b] = SEGMENTS[sg], na = a + s, nb = b + s, key = 'seg_' + sg + '_' + s;
      if (!(Dm[na] && Dm[nb] && Rp[na] && Rp[nb])) { if (D.P[na] || D.P[nb] || Rp[na] || Rp[nb]) notChecked.add(sg + s); continue; }
      const lD = dist(Dm[na], Dm[nb]), lR = dist(Rp[na], Rp[nb]); if (lR < 1e-6) continue;
      const fD = foreshort(DF, sg + s), fR = foreshort(RF, sg + s), approx = Math.min(fD, fR) < FORESHORTEN_BELOW;
      const raw = (lD - lR) / lR * 100;
      const vecR = sub(Rp[nb], Rp[na]), vecDpx = invertVec(al, vecR);
      const toV = { x: D.P[na].x + vecDpx.x - D.P[nb].x, y: D.P[na].y + vecDpx.y - D.P[nb].y };
      const it = add(key, 'segment', 'length', '%', raw, { tolFamily: 'segment_' + sg, side: sdName(s), part: sg, approximate: approx, points: [na, nb], span: [na, nb], arrows: arrowTo([nb], toV),
        sentence: (v, tol) => ({ key: sdName(s) + '_' + sg + (v > 0 ? '_too_long' : '_too_short'), n: displayCount(v, tol), side: sdName(s), part: sg }) });
      segInfo[key] = { it, lD, lR, na, nb, sg, s, approx };
    }
    // ---- legs (hip to ankle along the knee), per leg and together
    const legV = {};
    for (const s of SIDES) { const a = segInfo['seg_thigh_' + s], b = segInfo['seg_shin_' + s]; if (a && b) legV[s] = { v: ((a.lD + b.lD) - (a.lR + b.lR)) / u, approx: a.approx || b.approx }; }
    const legKeys = Object.keys(legV);
    if (legKeys.length) {
      const legsTol = (tolT.legs !== undefined ? tolT.legs : 0.2) * factor * srcScale;
      const together = legKeys.length === 2 && Math.abs(legV.R.v - legV.L.v) <= legsTol;
      if (together) {
        const raw = (legV.R.v + legV.L.v) / 2, ankles = ['ankleR', 'ankleL'], pts = ['hipR', 'hipL', 'kneeR', 'kneeL', 'ankleR', 'ankleL'];
        const arrs = []; for (const s of SIDES) { const a = segInfo['seg_thigh_' + s], b = segInfo['seg_shin_' + s], vR = sub(Rp['ankle' + s], Rp['hip' + s]), vD = sub(Dm['ankle' + s], Dm['hip' + s]); const d = invertVec(al, { x: vR.x - vD.x, y: vR.y - vD.y }); arrs.push(...arrowTo(['ankle' + s], d)); }
        add('legs', 'legs', 'length', 'heads', raw, { side: 'both', part: 'legs', approximate: legV.R.approx || legV.L.approx, points: pts, span: ['hipC', 'ankleL'], arrows: arrs, sentence: (v, tol) => ({ key: v > 0 ? 'legs_too_long' : 'legs_too_short', h: displayCount(v, tol, true) }) });
      } else for (const s of legKeys) {
        const vR = sub(Rp['ankle' + s], Rp['hip' + s]), vD = sub(Dm['ankle' + s], Dm['hip' + s]);
        add('leg_' + s, 'leg', 'length', 'heads', legV[s].v, { side: sdName(s), part: 'leg', approximate: legV[s].approx, points: ['hip' + s, 'knee' + s, 'ankle' + s], span: ['hip' + s, 'ankle' + s], arrows: arrowTo(['ankle' + s], invertVec(al, { x: vR.x - vD.x, y: vR.y - vD.y })),
          sentence: (v, tol) => ({ key: sdName(s) + '_leg' + (v > 0 ? '_too_long' : '_too_short'), h: displayCount(v, tol, true), side: sdName(s), part: 'leg' }) });
      }
    }
    // ---- reach: wrist height against the same side's hip, lean-removed
    for (const s of SIDES) {
      if (!(Dm['wrist' + s] && Dm['hip' + s] && Rp['wrist' + s] && Rp['hip' + s])) continue;
      const raw = ((fixD(Dm['wrist' + s]).y - fixD(Dm['hip' + s]).y) - (fixR(Rp['wrist' + s]).y - fixR(Rp['hip' + s]).y)) / u;
      const refTarget = { x: 0, y: -raw * u }; // move the wrist up/down in the lean-free frame; to drawing px (lean free ~ image frame, small error)
      add('reach_' + s, 'reach', 'placement', 'heads', raw, { side: sdName(s), part: 'hand', approximate: Math.min(foreshort(DF, 'forearm' + s), foreshort(RF, 'forearm' + s), foreshort(DF, 'upperArm' + s), foreshort(RF, 'upperArm' + s)) < FORESHORTEN_BELOW, points: ['hip' + s, 'wrist' + s], arrows: arrowTo(['wrist' + s], invertVec(al, refTarget)),
        sentence: (v, tol) => ({ key: sdName(s) + (v > 0 ? '_hand_hangs_too_low' : '_hand_hangs_too_high'), h: displayCount(v, tol, true), side: sdName(s), part: 'hand' }) });
    }
    // ---- tilts and contrapposto (lean-removed frame, line R -> L folded to (-90, 90], clockwise +)
    const tiltOf = (fix, P, a, b) => P[a] && P[b] ? foldLine(deg(Math.atan2(fix(P[b]).y - fix(P[a]).y, fix(P[b]).x - fix(P[a]).x))) : null;
    const tilts = {};
    for (const [fam, a, b, plural] of [['shoulder_tilt', 'shoulderR', 'shoulderL', 'shoulders'], ['hip_tilt', 'hipR', 'hipL', 'hips']]) {
      const tD = tiltOf(fixD, Dm, a, b), tR = tiltOf(fixR, Rp, a, b); if (tD === null || tR === null) { notChecked.add(fam); continue; }
      tilts[fam] = { d: tD, r: tR };
      const diff = wrap180(tD - tR);
      add(fam, fam, 'angle', 'deg', diff, { side: 'both', part: plural, points: [a, b], span: [a, b], sentence: (v, tol) => {
        const n = displayCount(v, tol), other = Math.sign(tD) * Math.sign(tR) < 0 && Math.abs(tD) > tol && Math.abs(tR) > tol;
        const more = Math.abs(tD) > Math.abs(tR); // the drawing's tilt is bigger in size
        return { key: plural + (other ? '_tilt_other_way' : (more ? '_tilted_more' : '_tilted_less')), d: n, cw: v > 0, part: plural };
      } });
    }
    if (tilts.shoulder_tilt && tilts.hip_tilt) {
      const diff = wrap180((tilts.shoulder_tilt.d - tilts.hip_tilt.d) - (tilts.shoulder_tilt.r - tilts.hip_tilt.r));
      const opposedD = Math.abs(tilts.shoulder_tilt.d - tilts.hip_tilt.d), opposedR = Math.abs(tilts.shoulder_tilt.r - tilts.hip_tilt.r);
      add('contrapposto', 'contrapposto', 'angle', 'deg', diff, { side: 'both', part: 'shoulders_hips', points: ['shoulderR', 'shoulderL', 'hipR', 'hipL'], sentence: (v, tol) => ({ key: opposedD < opposedR ? 'shoulders_hips_less_opposed' : 'shoulders_hips_more_opposed', d: displayCount(v, tol), part: 'shoulders_hips' }) });
    }
    // ---- limb angles (lean-removed)
    const angs = [];
    for (const sg of SEG_ORDER) for (const s of SIDES) {
      const si = segInfo['seg_' + sg + '_' + s]; if (!si) continue;
      const aD = cw(sub(fixD(Dm[si.nb]), fixD(Dm[si.na]))), aR = cw(sub(fixR(Rp[si.nb]), fixR(Rp[si.na]))), diff = wrap180(aD - aR); angs.push(Math.abs(diff));
      // rotate the drawing's distal point about the proximal one by -diff to cancel: arrow
      const vec = sub(D.P[si.nb], D.P[si.na]), c = Math.cos(rad(-diff)), sN = Math.sin(rad(-diff)), nv = { x: c * vec.x - sN * vec.y, y: sN * vec.x + c * vec.y };
      add('ang_' + sg + '_' + s, 'limb_angle', 'angle', 'deg', diff, { tolFamily: 'limb_angle', side: sdName(s), part: sg, approximate: si.approx, points: [si.na, si.nb], span: [si.na, si.nb], arrows: arrowTo([si.nb], { x: nv.x - vec.x, y: nv.y - vec.y }),
        sentence: (v, tol) => ({ key: sdName(s) + '_' + sg + (v > 0 ? '_turned_clockwise' : '_turned_anticlockwise'), d: displayCount(v, tol), side: sdName(s), part: sg }) });
    }
    const tooDifferent = angs.length >= 4 && median(angs) > POSE_DIFFERENT_DEG;
    if (tooDifferent) warnings.push({ key: 'poses_too_different', medianDeg: median(angs) });
    // ---- lean
    if (leanD !== null && leanR !== null) {
      add('lean', 'lean', 'angle', 'deg', leanD - leanR, { part: 'figure', points: ['neck'], span: ['neck', 'hipC'], sentence: (v, tol) => ({ key: v > 0 ? 'figure_leans_more_picture_right' : 'figure_leans_more_picture_left', d: displayCount(v, tol) }) });
    } else notChecked.add('lean');
    // ---- gesture line: parabola through head top, neck, hip centre and the standing foot (aligned image frame)
    const gFoot = lowestFoot(Rp), gesture = P => { const f = gFoot; if (!(P.headTop && P.neck && P.hipC && f && P[f])) return null; const a = P.headTop, b = footPoint(P, f.slice(-1)) || P[f], ch = sub(b, a), L = Math.hypot(ch.x, ch.y); if (L < 1e-6) return null;
      const ux = ch.x / L, uy = ch.y / L; let num = 0, den = 0; for (const q of [P.neck, P.hipC]) { const v = sub(q, a), t = (v.x * ux + v.y * uy) / L, off = -(v.x * uy) + v.y * ux, w = 4 * t * (1 - t); num += off * w; den += w * w; } // off: signed distance, + to the right of the chord direction in y-down
      return { lean: cw(ch), bow: den > 1e-9 ? num / den / L * 100 : 0, chord: L }; };
    const gD = gesture(Dm), gR = gesture(Rp);
    if (gD && gR) {
      add('gesture_lean', 'gesture_lean', 'angle', 'deg', wrap180(gD.lean - gR.lean), { part: 'gesture', points: ['headTop', 'neck', 'hipC'], sentence: (v, tol) => ({ key: v > 0 ? 'gesture_leans_more_clockwise' : 'gesture_leans_less_clockwise', d: displayCount(v, tol), part: 'gesture' }) });
      const same = gD.bow * gR.bow >= 0 || Math.abs(gR.bow) < 1;
      add('gesture_bow', 'gesture_bow', 'placement', '%', gD.bow - gR.bow, { part: 'gesture', points: ['headTop', 'neck', 'hipC'], sentence: (v, tol) => ({ key: same ? (Math.abs(gD.bow) > Math.abs(gR.bow) ? 'gesture_more_curved' : 'gesture_straighter') : 'gesture_curves_other_way', n: displayCount(v, tol), part: 'gesture' }) });
    }
    // ---- balance: standing foot against the plumb line through the pit of the neck (aligned image frame)
    const stand = (() => { const f = ['R', 'L'].filter(s => Rp['ankle' + s]); if (!f.length) return null; const ys = f.map(s => Rp['ankle' + s].y), mx = Math.max(...ys); return f.filter((s, i) => ys[i] >= mx - 0.15 * u); })();
    if (stand && dNeck && rNeck && stand.every(s => footPoint(Dm, s) && footPoint(Rp, s))) {
      const offD = stand.reduce((a, s) => a + footPoint(Dm, s).x, 0) / stand.length - dNeck.x, offR = stand.reduce((a, s) => a + footPoint(Rp, s).x, 0) / stand.length - rNeck.x, raw = (offD - offR) / u;
      const foot = stand.length === 1 ? 'ankle' + stand[0] : 'ankleR';
      add('balance', 'balance', 'balance', 'heads', raw, { part: 'foot', points: stand.map(s => 'ankle' + s).concat(['neck']), arrows: arrowTo(stand.map(s => 'ankle' + s), invertVec(al, { x: -raw * u, y: 0 })),
        sentence: (v, tol) => ({ key: v > 0 ? 'standing_foot_too_far_right' : 'standing_foot_too_far_left', h: displayCount(v, tol, true), part: 'foot' }) });
      const xs = ['R', 'L'].filter(s => Dm['ankle' + s]).flatMap(s => ['ankle', 'heel', 'toe'].map(n => Dm[n + s]).filter(Boolean).map(p => p.x));
      if (xs.length >= 2 && ['R', 'L'].every(s => Dm['ankle' + s]) && (dNeck.x < Math.min(...xs) - 0.1 * u || dNeck.x > Math.max(...xs) + 0.1 * u)) warnings.push({ key: 'balance_outside_feet', side: dNeck.x < Math.min(...xs) ? 'picture_left' : 'picture_right' });
    } else notChecked.add('balance');
    // ---- joint placement not explained by a segment item: offset from the neck in the lean-removed frame, in heads
    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    const segFlag = (sg, s) => { const a = byKey['seg_' + sg + '_' + s], b = byKey['ang_' + sg + '_' + s]; return (a && a.flagged) || (b && b.flagged); };
    const legsFlag = s => (byKey.legs && byKey.legs.flagged) || (byKey['leg_' + s] && byKey['leg_' + s].flagged);
    for (const s of SIDES) for (const [jn, chain] of [['elbow', [['upperArm']]], ['wrist', [['upperArm'], ['forearm']]], ['knee', [['thigh']]], ['ankle', [['thigh'], ['shin']]]]) {
      const name = jn + s; if (!(Dm[name] && Rp[name] && Dm.neck && rNeck)) continue;
      const explained = chain.some(([sg]) => segFlag(sg, s)) || ((jn === 'knee' || jn === 'ankle') && legsFlag(s)) || (jn === 'wrist' && byKey['reach_' + s] && byKey['reach_' + s].flagged);
      const a = sub(fixD(Dm[name]), fixD(dNeck)), b = sub(fixR(Rp[name]), fixR(rNeck)), dx = (a.x - b.x) / u, dy = (a.y - b.y) / u, mag = Math.hypot(dx, dy);
      const horizontal = Math.abs(dx) >= Math.abs(dy), raw = horizontal ? dx : dy;
      const it = add('joint_' + name, 'joint', 'placement', 'heads', mag * Math.sign(raw || 1), { side: sdName(s), part: jn, points: [name], tolMul: 1, arrows: arrowTo([name], invertVec(al, { x: -dx * u, y: -dy * u })),
        sentence: v => ({ key: sdName(s) + '_' + jn + '_too_' + (horizontal ? (dx > 0 ? 'far_right' : 'far_left') : (dy > 0 ? 'low' : 'high')), h: displayCount(mag, 0, true), side: sdName(s), part: jn }) });
      if (explained && it.flagged) { it.flagged = false; it.severity = 'none'; it.rankScore = 0; it.explained = true; }
    }
    byKey.__ = null;
    // ---- knock-on grouping
    const groups = [], flagged0 = k => { const i = items.find(x => x.key === k); return i && i.flagged && !i.locked ? i : null; };
    const effect = (cause, eff, sentence, relation) => { if (!eff || eff.groupedUnder || eff === cause) return; eff.groupedUnder = cause.key; let g = groups.find(x => x.cause === cause.key); if (!g) groups.push(g = { cause: cause.key, effects: [] }); g.effects.push({ key: eff.key, relation, sentence, value: eff.value }); };
    const legsItem = flagged0('legs');
    for (const s of SIDES) {
      const lg = legsItem || flagged0('leg_' + s);
      if (lg) {
        for (const sg of ['thigh', 'shin']) { const e = flagged0('seg_' + sg + '_' + s); if (e && Math.sign(e.value) === Math.sign(lg.value)) effect(lg, e, null, 'part_of'); }
        for (const jn of ['knee', 'ankle']) { const e = items.find(x => x.key === 'joint_' + jn + s && x.explained); if (e) effect(lg, e, { key: 'joint_moves_with', part: jn, side: sdName(s) }, 'follows'); }
      }
      for (const sg of ['upperArm', 'forearm', 'thigh', 'shin']) {
        const seg = flagged0('seg_' + sg + '_' + s); if (!seg || seg.groupedUnder) continue;
        if (sg === 'forearm' || sg === 'upperArm') { const r = flagged0('reach_' + s); if (r && Math.sign(r.value) === Math.sign(seg.value) * (sg ? 1 : 1)) effect(seg, r, { key: 'hand_moves_with', side: sdName(s), part: 'hand' }, 'follows'); }
        const distal = sg === 'shin' || sg === 'thigh' ? ['knee', 'ankle'] : ['elbow', 'wrist'];
        for (const jn of distal) { const e = items.find(x => x.key === 'joint_' + jn + s && x.explained); if (e && !e.groupedUnder) effect(seg, e, { key: 'joint_moves_with', part: jn, side: sdName(s) }, 'follows'); }
      }
    }
    const shW = flagged0('shoulder_width'); if (shW) for (const s of SIDES) { const e = flagged0('seg_upperArm_' + s); /* separate item */ void e; }
    if (flagged0('lean')) for (const f of ['gesture_lean']) { const e = flagged0(f); if (e) effect(flagged0('lean'), e, null, 'explained_by'); }
    // foreshortening notes
    const fsKeys = []; for (const si of Object.values(segInfo)) if (si.approx) fsKeys.push({ part: si.sg, side: sdName(si.s), drawing: foreshort(DF, si.sg + si.s), reference: foreshort(RF, si.sg + si.s) });
    if (fsKeys.length) warnings.push({ key: fsKeys.length > Object.keys(segInfo).length / 2 ? 'much_foreshortened' : 'foreshortened', segments: fsKeys });
    if (unit.kind !== 'head') warnings.push({ key: 'head_unit_estimated', kind: unit.kind });
    if (DF.approx && DF.approx.head || RF.approx && RF.approx.head) warnings.push({ key: 'head_from_detector' });
    if (al.size.note) warnings.push({ key: 'size_fallback', note: al.size.note });
    const rank = (a, b) => b.rankScore - a.rankScore || Math.abs(b.value) / (b.tolerance || 1) - Math.abs(a.value) / (a.tolerance || 1);
    const flagged = tooDifferent ? [] : items.filter(i => i.flagged && !i.explained).sort(rank);
    const close = items.filter(i => !i.flagged && !i.locked && !i.explained).map(i => i.key);
    if (tooDifferent) for (const i of items) { i.hiddenByDifference = true; }
    return {
      ok: true, items, byKey: Object.fromEntries(items.map(i => [i.key, i])), flagged, close, locked: Array.from(locked), groups, warnings, notChecked: Array.from(notChecked), info, tooDifferent, unit,
      tolerance: { preset, factor, sourceScale: srcScale, base: tolT }, source: { drawing: DF.source, reference: RF.source },
      summary: { count: flagged.filter(i => i.severity !== 'possible').length, possible: flagged.filter(i => i.severity === 'possible').length, major: flagged.filter(i => i.severity === 'major').length },
    };
  }
  const rad2deg = r => r * 180 / Math.PI;
  function figureHeightIn(P) { return P.headTop && (P.ankleR || P.ankleL) ? Math.max(P.ankleR ? P.ankleR.y : -1e9, P.ankleL ? P.ankleL.y : -1e9) - P.headTop.y : null; }

  /** mirrorCheck(drawingFs, referenceFs, alignment) -> { mirrored, direct, swapped } : median joint offset (heads, lean-removed, from the neck) with the
      names as given and with left and right swapped. mirrored when swapping lowers it by more than 40% and the direct offset exceeds 0.25 heads. */
  function mirrorCheck(DF, RF, al) {
    const D = resolve(DF), R = resolve(RF), u = R.unit && R.unit.px; if (!u || !al || !al.ok || !D.P.neck || !R.P.neck) return { mirrored: false, direct: null, swapped: null };
    const dN = apply(al, D.P.neck), leanD = D.P.hipC ? cw(sub(apply(al, D.P.hipC), dN)) : 0, leanR = R.P.hipC ? cw(sub(R.P.hipC, R.P.neck)) : 0;
    const fD = p => sub(rot(apply(al, p), dN, rad(-leanD)), dN), fR = p => sub(rot(p, R.P.neck, rad(-leanR)), R.P.neck);
    const js = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'], dd = [], sw = [];
    for (const j of js) for (const s of SIDES) { const a = j + s, b = j + swapSide(s); if (D.P[a] && R.P[a]) dd.push(dist(fD(D.P[a]), fR(R.P[a])) / u); if (D.P[b] && R.P[a]) sw.push(dist(fD(D.P[b]), fR(R.P[a])) / u); }
    const direct = median(dd), swapped = median(sw);
    return { mirrored: direct !== null && swapped !== null && direct > 0.25 && swapped < 0.6 * direct, direct, swapped };
  }

  /** analyse(drawingFs, referenceFs, options) -> { alignment, report }  (options: align + measure options) */
  function analyse(DF, RF, options) { const o = options || {}, alignment = align(DF, RF, o); return { alignment, report: measure(DF, RF, alignment, o) }; }

  DC.BodyProportions = {
    fromPoints, fromPose, resolve, align, measure, analyse, mirrorCheck, apply, invert, toLayerTransform,
    NAMES, SEGMENTS, SEG_ORDER, POSE_INDEX, SIZE_MODES, PIN_MODES, TOLERANCE, TOLERANCE_SPEC, TOLERANCE_TUNED, TOLERANCE_PRESETS, BIAS, GAIN, SOURCE_SCALE, TAP_NOISE, KAPPA, MIN_GAIN, FORESHORTEN_BELOW, POSE_DIFFERENT_DEG,
    // limit-free helpers the UI and the validation reuse
    lowestFoot, footPoint, swapSide,
    _math: { fitJoint, fitScaleAbout, fitShift, median, wrap180, foldLine, cw, rot, solveLinear, displayCount },
  };
})();
