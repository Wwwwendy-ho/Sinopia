// Hand proportions engine: pure functions (no DOM, no network). Compares two hands given as NAMED POINTS (hand-placed 7-point coach, or
// mapped from MediaPipe's Hand Landmarker 21 points) and returns structured discrepancies (keys and numbers, no English).
// Method, tolerances and validation numbers: review/proportions-body-hands-outline.md. Needs js/proportions-body.js loaded first (shared fits).
//
// Public API (window.DrawingCompare.HandProportions)
//   COACH                          the 7 points the coach asks for, in order (Skip allowed for any)
//   fromPoints(named, opts?)       named {name: {x,y}} -> fs { source:'manual', points, interpolated:{name:true}, side }
//   fromLandmarks(hand, opts?)     one hand from DC.Landmarks.hands().hands[i] (21 points) -> fs (source 'detector')
//   resolve(fs)                    points + interpolated middle/ring knuckles, palm length, palm axis
//   align(drawingFs, referenceFs, opts)   similarity (scale + translation; rotation 0 unless matchTilt) drawing -> reference px
//   measure(drawingFs, referenceFs, alignment, opts)   report (items, flagged, close, groups, warnings, notChecked, info)
//   analyse(drawingFs, referenceFs, opts)   align + measure
//   apply / invert                 the alignment similarity
//
// Names: wrist; thumbCmc (1), thumbMcp (2), thumbIp (3), thumbTip (4); indexKnuckle (5), indexPip, indexDip, indexTip (8); middle* (9-12); ring* (13-16);
// little* (17-20). The 7-point coach: wrist, thumbTip, indexKnuckle, littleKnuckle, indexTip, middleTip, littleTip. The middle and ring knuckles are then
// interpolated along the knuckle line (fraction 0.343 and 0.676, arched away from the wrist) and the ring tip from its neighbours; every interpolated point is marked and the items that
// would rest on it (ring finger length, spreads of the ring finger) are skipped.
// Frames: palm frame = origin wrist, axis toward the middle knuckle (unit = palm length of the reference); hand rotation removed per hand.
// Units: % of the reference finger (finger lengths), % of the reference palm length (placements, palm width, hand size), degrees (angles, clockwise +).
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const DC = root.DrawingCompare = root.DrawingCompare || {};
  const M = DC.BodyProportions && DC.BodyProportions._math;
  if (!M) throw new Error('HandProportions needs js/proportions-body.js loaded first');
  const { fitJoint, fitScaleAbout, fitShift, median, wrap180, foldLine, rot } = M;

  const FINGERS = ['index', 'middle', 'ring', 'little'];
  const JOINTS = ['Knuckle', 'Pip', 'Dip', 'Tip'];
  const LM_INDEX = { wrist: 0, thumbCmc: 1, thumbMcp: 2, thumbIp: 3, thumbTip: 4 };
  FINGERS.forEach((f, i) => JOINTS.forEach((j, k) => { LM_INDEX[f + j] = 5 + i * 4 + k; }));
  const NAMES = Object.keys(LM_INDEX);
  const COACH = ['wrist', 'thumbTip', 'indexKnuckle', 'littleKnuckle', 'indexTip', 'middleTip', 'littleTip'];
  // Fitted on 250 detected hands (11k Hands): middle knuckle at t = 0.343 (sd 0.021) along index -> little knuckle and 0.112 (sd 0.023) of the knuckle width away from the wrist; ring knuckle t = 0.676 (sd 0.025), 0.101 (sd 0.021); ring finger = 0.932 x middle (sd 0.02).
  const KNUCKLE_FRACTION = { middleKnuckle: 0.343, ringKnuckle: 0.676 }, KNUCKLE_ARC = { middleKnuckle: 0.112, ringKnuckle: 0.101 }, RING_OVER_MIDDLE = 0.932;

  const TOLERANCE_PRESETS = { strict: 0.72, usual: 1, relaxed: 2 };
  // Usual tolerances (after bias / gain): finger_length % of that reference finger, thumb_place / palm_width / hand_size % of reference palm length, angles degrees.
  const TOLERANCE_SPEC = { finger_length: 6, thumb_length: 6, thumb_place: 5, knuckle_line: 4, palm_width: 5, finger_spread: 6, finger_bend: 10, hand_angle: 4, hand_size: 8 };
  const TOLERANCE = Object.assign({}, TOLERANCE_SPEC);
  const TOLERANCE_TUNED = {};
  // value = (raw - bias) / gain. detector: the Hand Landmarker under-follows drawn finger lengths (bench: median measured / planted 0.66 on photos, gain floored at 0.5).
  // Manual points: gain 1, bias 0.
  const MIN_GAIN = 0.5;
  const GAIN = { manual: {}, detector: { finger_length: 0.66, thumb_length: 0.66 } };
  const BIAS = { manual: {}, detector: {} };
  const SOURCE_SCALE = { manual: 1, detector: 1 };
  const FORESHORTEN_BELOW = 0.8;
  // Tap / detector noise model: rms radial error of one point, in palm lengths (a tap placed with the zoom lens is 0.5 to 1% of the hand length, about 2.2 palms = 0.0175 palm; plain taps 1 to 2% = 0.035, pass opts.tapNoise; the detector value 0.05 is an estimate, not measured).
  // Items are only flagged beyond KAPPA x their expected noise (set by the planted-error sweep, see the review document).
  const TAP_NOISE = { manual: 0.0175, detector: 0.05 };
  const KAPPA = 2.5;

  const ok = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const copy = p => ({ x: p.x, y: p.y });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  /** clockwise-on-screen angle (degrees) of vector v from straight UP: (0,-1) -> 0, (1,0) -> +90 */
  const cwUp = v => deg(Math.atan2(v.x, -v.y));

  function fromPoints(named, opts) {
    const o = opts || {}, pts = {}; for (const k of NAMES) pts[k] = named && ok(named[k]) ? copy(named[k]) : null;
    return { source: o.source || 'manual', points: pts, interpolated: {}, side: o.side || null, foreshortened: Object.assign({}, o.foreshortened || {}) };
  }
  /** fromLandmarks(hand, opts) -> fs from one detected hand: hand.points (21 {x,y,z}), hand.world. opts.side: 'left'|'right' (the person's own; take it
      from the pose or the thumb side, not from the model's label). Foreshortening per finger = (2D finger / 2D palm) / (3D finger / 3D palm). */
  function fromLandmarks(hand, opts) {
    const o = opts || {}, pts = {}; for (const k of NAMES) { const p = hand.points[LM_INDEX[k]]; pts[k] = p && Number.isFinite(p.x) ? { x: p.x, y: p.y } : null; }
    const fs = { source: 'detector', points: pts, interpolated: {}, side: o.side || null, foreshortened: {}, label: hand.label || null };
    const W = hand.world;
    if (W && W.length >= 21) {
      const d3 = (a, b) => Math.hypot(W[a].x - W[b].x, W[a].y - W[b].y, W[a].z - W[b].z), p3 = d3(0, 9), p2 = pts.wrist && pts.middleKnuckle ? dist(pts.wrist, pts.middleKnuckle) : 0;
      if (p3 > 1e-6 && p2 > 1e-6) for (const f of FINGERS) { const a = LM_INDEX[f + 'Knuckle'], b = LM_INDEX[f + 'Tip'], l3 = d3(a, b); if (l3 > 1e-6 && pts[f + 'Knuckle'] && pts[f + 'Tip']) fs.foreshortened[f] = (dist(pts[f + 'Knuckle'], pts[f + 'Tip']) / p2) / (l3 / p3); }
    }
    return fs;
  }

  /** resolve(fs) -> { P, palm (px), axis (unit vector wrist -> middle knuckle), angle (deg, cw from up), interpolated: {name:true} } */
  function resolve(fs) {
    const P = {}, interp = Object.assign({}, fs.interpolated || {}); for (const k of Object.keys(fs.points)) if (ok(fs.points[k])) P[k] = fs.points[k];
    if (P.indexKnuckle && P.littleKnuckle) for (const n of Object.keys(KNUCKLE_FRACTION)) if (!P[n]) {
      const a = lerp(P.indexKnuckle, P.littleKnuckle, KNUCKLE_FRACTION[n]); // knuckles arc away from the wrist
      if (P.wrist) { const ux = P.littleKnuckle.x - P.indexKnuckle.x, uy = P.littleKnuckle.y - P.indexKnuckle.y, w = Math.hypot(ux, uy) || 1; let nx = -uy / w, ny = ux / w; const cx = (P.indexKnuckle.x + P.littleKnuckle.x) / 2 - P.wrist.x, cy = (P.indexKnuckle.y + P.littleKnuckle.y) / 2 - P.wrist.y; if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; } a.x += nx * KNUCKLE_ARC[n] * w; a.y += ny * KNUCKLE_ARC[n] * w; }      P[n] = a; interp[n] = true;
    }
    if (!P.ringTip && P.ringKnuckle && P.middleTip && P.littleTip && P.middleKnuckle && P.littleKnuckle) { // ring finger: between its neighbours, 0.932 of the middle finger
      const vm = sub(P.middleTip, P.middleKnuckle), vl = sub(P.littleTip, P.littleKnuckle), len = RING_OVER_MIDDLE * Math.hypot(vm.x, vm.y), v = { x: (vm.x + vl.x) / 2, y: (vm.y + vl.y) / 2 }, L = Math.hypot(v.x, v.y) || 1;
      P.ringTip = { x: P.ringKnuckle.x + v.x / L * len, y: P.ringKnuckle.y + v.y / L * len }; interp.ringTip = true;
    }
    let palm = null, axis = null, angle = null;
    if (P.wrist && P.middleKnuckle) { palm = dist(P.wrist, P.middleKnuckle); if (palm > 1e-6) { axis = { x: (P.middleKnuckle.x - P.wrist.x) / palm, y: (P.middleKnuckle.y - P.wrist.y) / palm }; angle = cwUp(axis); } }
    return { P, palm, axis, angle, interpolated: interp };
  }

  // ------------------------------------------------------------------------------------------ alignment
  const SIZE_MODES = ['auto', 'palm', 'hand', 'custom'];
  const PIN_MODES = ['auto', 'wrist', 'middleKnuckle'];
  const FIT_NAMES = ['wrist', 'thumbCmc', 'indexKnuckle', 'middleKnuckle', 'ringKnuckle', 'littleKnuckle'];
  /** align(drawingFs, referenceFs, options) -> alignment. options: { size: 'auto'|'palm'|'hand'|'custom', custom:{drawing:[p,p],reference:[p,p]},
      pin: 'auto'|'wrist'|'middleKnuckle'|{x,y,drawing?}, matchTilt: false } -> { ok, scale, rotation, tx, ty, size, pin, locked, fit, angleDiff } */
  function align(DF, RF, options) {
    const o = options || {}, D = resolve(DF), R = resolve(RF), Dp = D.P, Rp = R.P, matchTilt = !!o.matchTilt;
    // only measured (not interpolated) palm points steer the fit
    const names = FIT_NAMES.filter(n => Dp[n] && Rp[n] && !D.interpolated[n] && !R.interpolated[n]);
    if (names.length < 3) return { ok: false, reason: 'needs at least three palm points (wrist and the knuckles) in both hands' };
    const cen = P => ({ x: names.reduce((s, n) => s + P[n].x, 0) / names.length, y: names.reduce((s, n) => s + P[n].y, 0) / names.length });
    const cD = cen(Dp), cR = cen(Rp), sp = (P, c) => Math.sqrt(names.reduce((s, n) => s + (P[n].x - c.x) ** 2 + (P[n].y - c.y) ** 2, 0) / names.length) || 1, sD = sp(Dp, cD), sR = sp(Rp, cR);
    const nd = p => ({ x: (p.x - cD.x) / sD, y: (p.y - cD.y) / sD }), nr = p => ({ x: (p.x - cR.x) / sR, y: (p.y - cR.y) / sR }), ND = {}, NR = {};
    for (const n of names) { ND[n] = nd(Dp[n]); NR[n] = nr(Rp[n]); }
    let sizeUsed = SIZE_MODES.includes(o.size) ? o.size : 'auto', note = null, ratio = null;
    if (sizeUsed === 'palm') { if (D.palm > 0 && R.palm > 0) ratio = D.palm / R.palm; else { sizeUsed = 'auto'; note = 'the palm measure is missing: sized by robust auto'; } }
    else if (sizeUsed === 'hand') { if (Dp.wrist && Dp.middleTip && Rp.wrist && Rp.middleTip) ratio = dist(Dp.wrist, Dp.middleTip) / dist(Rp.wrist, Rp.middleTip); else { sizeUsed = 'auto'; note = 'the hand length measure is missing: sized by robust auto'; } }
    else if (sizeUsed === 'custom') { const c = o.custom; if (c && c.drawing && c.reference && c.drawing.length === 2 && c.reference.length === 2) ratio = dist(c.drawing[0], c.drawing[1]) / dist(c.reference[0], c.reference[1]); else { sizeUsed = 'auto'; note = 'custom size needs two points in each image: sized by robust auto'; } }
    if (ratio !== null && !(ratio > 0 && Number.isFinite(ratio))) { ratio = null; sizeUsed = 'auto'; note = 'degenerate size measure: sized by robust auto'; }
    const kFixed = ratio === null ? null : ratio * sR / sD;
    const auto = kFixed === null ? fitJoint(ND, NR, names) : { k: kFixed, t: fitShift(ND, NR, names, kFixed), iterations: 0 };
    const pinReq = o.pin === undefined ? 'auto' : o.pin;
    let pinUsed = 'auto', pinD = null, pinR = null, k = auto.k, t = auto.t;
    if (typeof pinReq === 'string' && pinReq !== 'auto' && PIN_MODES.includes(pinReq) && Dp[pinReq] && Rp[pinReq]) {
      pinUsed = pinReq; pinD = Dp[pinReq]; pinR = Rp[pinReq]; const pdn = nd(pinD), prn = nr(pinR);
      if (kFixed === null) k = fitScaleAbout(ND, NR, names, pdn, prn);
      t = { x: pdn.x - k * prn.x, y: pdn.y - k * prn.y };
    } else if (pinReq && typeof pinReq === 'object' && ok(pinReq)) {
      pinUsed = 'custom'; pinR = copy(pinReq); const prn = nr(pinR), pdn = ok(pinReq.drawing) ? nd(pinReq.drawing) : { x: auto.k * prn.x + auto.t.x, y: auto.k * prn.y + auto.t.y };
      pinD = { x: cD.x + pdn.x * sD, y: cD.y + pdn.y * sD };
      if (kFixed === null) k = fitScaleAbout(ND, NR, names, pdn, prn);
      t = { x: pdn.x - k * prn.x, y: pdn.y - k * prn.y };
    } else { pinD = { x: cD.x + t.x * sD, y: cD.y + t.y * sD }; pinR = copy(cR); }
    const scale = sR / (sD * k), angleDiff = D.angle !== null && R.angle !== null ? wrap180(D.angle - R.angle) : 0;
    const phi = matchTilt ? rad(-angleDiff) : 0, c = Math.cos(phi), s = Math.sin(phi);
    const tx = pinR.x - scale * (c * pinD.x - s * pinD.y), ty = pinR.y - scale * (s * pinD.x + c * pinD.y);
    const resid = names.map(n => Math.hypot(ND[n].x - (k * NR[n].x + t.x), ND[n].y - (k * NR[n].y + t.y)) * sR).sort((a, b) => a - b);
    return { ok: true, scale, rotation: phi, rotationDeg: deg(phi), tx, ty, matchTilt, angleDiff, size: { requested: o.size || 'auto', used: sizeUsed, note }, pin: { requested: typeof pinReq === 'object' ? 'custom' : pinReq, used: pinUsed, reference: pinR, drawing: pinD },
      locked: sizeUsed === 'palm' ? ['palm_width'] : [], fit: { kind: 'robust-l1-irls', names, residual: { median: median(resid), medianPalm: R.palm ? median(resid) / R.palm : null } } };
  }
  function apply(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation); return { x: al.scale * (c * p.x - s * p.y) + al.tx, y: al.scale * (s * p.x + c * p.y) + al.ty }; }
  function invert(al, p) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation), x = (p.x - al.tx) / al.scale, y = (p.y - al.ty) / al.scale; return { x: c * x + s * y, y: -s * x + c * y }; }
  function invertVec(al, v) { const c = Math.cos(al.rotation), s = Math.sin(al.rotation), x = v.x / al.scale, y = v.y / al.scale; return { x: c * x + s * y, y: -s * x + c * y }; }

  // ------------------------------------------------------------------------------------------ measure
  const tolFactor = t => typeof t === 'number' ? t : (TOLERANCE_PRESETS[t || 'usual'] || 1);
  const displayCount = M.displayCount;
  const FNAME = { index: 'index', middle: 'middle', ring: 'ring', little: 'little' };
  const polylineLen = (P, f) => { const a = [P[f + 'Knuckle'], P[f + 'Pip'], P[f + 'Dip'], P[f + 'Tip']]; return a.every(Boolean) ? dist(a[0], a[1]) + dist(a[1], a[2]) + dist(a[2], a[3]) : null; };

  /** measure(drawingFs, referenceFs, alignment, options) -> report
      options: { tolerance, tolerances: {family: v}, bias, gain ('auto'|'none'|{family:v}), sourceScale: false }
      item: { key, family, section: 'hands', kind, unit: '%'|'%palm'|'deg', value (signed, drawing minus reference, corrected), raw, valuePalm (finger items: the same change as % of the reference palm),
              tolerance, flagged, locked, approximate, severity, part ('index'...'thumb'|'palm'|'knuckles'|'hand'), points, span, arrows, sentence: {key, n|d, part}, rankScore }
      Sign: + = drawing larger / longer / wider; thumb placement + = lower (towards the wrist) and out (away from the palm); angles clockwise on screen +. */
  function measure(DF, RF, al, options) {
    const o = options || {};
    if (!al || !al.ok) return { ok: false, reason: al && al.reason || 'no alignment', items: [], flagged: [], close: [], locked: [], groups: [], warnings: [], notChecked: [] };
    const D = resolve(DF), R = resolve(RF), Rp = R.P; if (!(R.palm > 0)) return { ok: false, reason: 'no palm length in the reference', items: [], flagged: [], close: [], locked: [], groups: [], warnings: [], notChecked: [] };
    const factor = tolFactor(o.tolerance), preset = typeof o.tolerance === 'string' ? o.tolerance : (o.tolerance === undefined ? 'usual' : 'custom');
    const srcScale = o.sourceScale === false ? 1 : Math.max(SOURCE_SCALE[DF.source] || 1, SOURCE_SCALE[RF.source] || 1);
    const biasT = o.bias === 'none' ? {} : (o.bias && typeof o.bias === 'object' ? o.bias : (BIAS[DF.source] || {})), gainT = o.gain === 'none' ? {} : (o.gain && typeof o.gain === 'object' ? o.gain : (GAIN[DF.source] || {})), tolT = Object.assign({}, TOLERANCE, o.tolerances || {});
    const Dm = {}; for (const k of Object.keys(D.P)) Dm[k] = apply(al, D.P[k]);
    const palmR = R.palm, locked = new Set(al.locked || []), items = [], notChecked = new Set(), warnings = [];
    // hand-rotation-free frame (about the wrist), x across, y along the palm axis (reference px)
    const angD = D.angle === null ? 0 : D.angle + deg(al.rotation), angR = R.angle === null ? 0 : R.angle;
    const fixD = p => rot(p, Dm.wrist || p, rad(-angD)), fixR = p => rot(p, Rp.wrist || p, rad(-angR));
    const interp = n => !!(D.interpolated[n] || R.interpolated[n]);
    // expected tap / detector noise on each item (same unit as the item); the tolerance never goes below KAPPA x this.
    // r = rms radial error of one point in reference px (TAP_NOISE x palm length); both images contribute: tot = sqrt(2) r.
    const kappa = o.kappa === undefined ? KAPPA : o.kappa, rms = o.tapNoise === 'none' ? 0 : (typeof o.tapNoise === 'number' ? o.tapNoise : Math.max(TAP_NOISE[DF.source] || 0, TAP_NOISE[RF.source] || 0)) * palmR, tot = Math.SQRT2 * rms;
    const lenR = (a, b) => Rp[a] && Rp[b] ? dist(Rp[a], Rp[b]) : null, knW = lenR('indexKnuckle', 'littleKnuckle');
    function noiseSd(key, family) {
      if (!(rms > 0)) return 0; const inv = v => v > 1e-6 ? tot / v : 0, f = /^(?:finger|bend)_(\w+)$/.exec(key), fl = f && f[1] !== 'thumb' ? lenR(f[1] + 'Knuckle', f[1] + 'Tip') : null;
      switch (family) {
        case 'finger_length': return 100 * inv(fl); case 'thumb_length': return 100 * inv(lenR(Rp.thumbMcp ? 'thumbMcp' : 'wrist', 'thumbTip'));
        case 'thumb_place': return 100 * tot / palmR * 1.5; case 'palm_width': return 100 * inv(knW); case 'knuckle_line': return deg(inv(knW));
        case 'finger_spread': return deg(Math.SQRT2 * inv(0.7 * palmR)); case 'finger_bend': return deg(Math.SQRT2 * inv(0.3 * palmR)); case 'hand_angle': return deg(inv(palmR)); case 'hand_size': return 100 * inv(palmR);
        default: return 0;
      }
    }
    function add(key, family, kind, unit, raw, e) {
      const biasV = typeof biasT[family] === 'number' ? biasT[family] : 0, gain = Math.max(MIN_GAIN, typeof gainT[family] === 'number' ? gainT[family] : 1);
      const value = (raw - biasV) / gain, sd = noiseSd(key, family), tol = Math.max((tolT[family] !== undefined ? tolT[family] : 1) * factor * srcScale, kappa * sd * factor), isLocked = locked.has(family) || locked.has(key);
      const over = !isLocked && Math.abs(value) > tol, approx = !!e.approximate, severity = !over ? 'none' : (Math.abs(value) >= 2 * tol ? 'major' : 'minor');
      const it = { key, family, section: 'hands', kind, unit, value, raw, tolerance: tol, flagged: over, locked: isLocked, approximate: approx, severity, side: DF.side || RF.side || null, part: e.part || null, points: e.points || [], span: e.span || null,
        arrows: e.arrows || [], pointData: {}, sentence: e.sentence ? e.sentence(value, tol) : null, groupedUnder: null, reliability: approx ? 'approx' : 'exact', rankScore: over ? Math.abs(value) / tol * 0.9 * (approx ? 0.5 : 1) : 0, valuePalm: e.palmFactor ? value * e.palmFactor : null };
      for (const n of it.points) if (D.P[n] && Rp[n]) it.pointData[n] = { drawing: copy(D.P[n]), reference: copy(Rp[n]), drawingInReference: copy(Dm[n]) };
      items.push(it); return it;
    }
    const arrow = (n, vecRef) => { const a = D.P[n], v = invertVec(al, vecRef); return { point: n, drawing: { from: copy(a), to: { x: a.x + v.x, y: a.y + v.y } }, reference: { from: copy(Dm[n]), to: apply(al, { x: a.x + v.x, y: a.y + v.y }) } }; };
    const curled = (P, f) => P.wrist && P[f + 'Knuckle'] && P[f + 'Tip'] && dist(P.wrist, P[f + 'Tip']) < dist(P.wrist, P[f + 'Knuckle']);
    // ---- finger lengths
    for (const f of FINGERS) {
      const kn = f + 'Knuckle', tp = f + 'Tip';
      if (!(Dm[kn] && Dm[tp] && Rp[kn] && Rp[tp])) { if (D.P[tp] || Rp[tp]) notChecked.add(f + '_length'); continue; }
      if (interp(tp) || interp(kn) && (f === 'ring')) { notChecked.add(f + '_length'); continue; }
      if (curled(Dm, f) || curled(Rp, f)) { notChecked.add(f + '_length'); continue; }
      const pD = polylineLen(Dm, f), pR = polylineLen(Rp, f), useLine = pD !== null && pR !== null, lD = useLine ? pD : dist(Dm[kn], Dm[tp]), lR = useLine ? pR : dist(Rp[kn], Rp[tp]);
      if (lR < 1e-6) continue;
      const fD = DF.foreshortened && DF.foreshortened[f] !== undefined ? (DF.foreshortened[f] === true ? 0.5 : DF.foreshortened[f]) : 1, fR = RF.foreshortened && RF.foreshortened[f] !== undefined ? (RF.foreshortened[f] === true ? 0.5 : RF.foreshortened[f]) : 1;
      const approx = Math.min(fD, fR) < FORESHORTEN_BELOW || !!D.interpolated[kn] || !!R.interpolated[kn];
      const raw = (lD - lR) / lR * 100, vR = sub(Rp[tp], Rp[kn]), vD = sub(Dm[tp], Dm[kn]);
      add('finger_' + f, 'finger_length', 'length', '%', raw, { part: f, approximate: approx, palmFactor: lR / palmR, points: [kn, tp], span: [kn, tp], arrows: [arrow(tp, { x: vR.x - vD.x, y: vR.y - vD.y })],
        sentence: (v, tol) => ({ key: f + (v > 0 ? '_finger_too_long' : '_finger_too_short'), n: displayCount(v, tol), part: f }) });
    }
    // thumb: MCP -> tip when both exist, else wrist -> tip ("reach")
    if (Dm.thumbTip && Rp.thumbTip) {
      const useMcp = Dm.thumbMcp && Rp.thumbMcp, a = useMcp ? 'thumbMcp' : 'wrist';
      if (Dm[a] && Rp[a]) {
        const lD = dist(Dm[a], Dm.thumbTip), lR = dist(Rp[a], Rp.thumbTip), vR = sub(Rp.thumbTip, Rp[a]), vD = sub(Dm.thumbTip, Dm[a]);
        if (lR > 1e-6) add('thumb_length', 'thumb_length', 'length', '%', (lD - lR) / lR * 100, { part: 'thumb', approximate: !useMcp, palmFactor: lR / palmR, points: [a, 'thumbTip'], span: [a, 'thumbTip'], arrows: [arrow('thumbTip', { x: vR.x - vD.x, y: vR.y - vD.y })],
          sentence: (v, tol) => ({ key: v > 0 ? 'thumb_too_long' : 'thumb_too_short', n: displayCount(v, tol), part: 'thumb', reach: !useMcp }) });
      }
    } else notChecked.add('thumb_length');
    // ---- thumb placement: thumb base (MCP, else CMC) in the palm frame, % of the reference palm length
    const tb = ['thumbMcp', 'thumbCmc'].find(n => Dm[n] && Rp[n]);
    if (tb && Dm.wrist && Rp.wrist) {
      const a = fixD(Dm[tb]), aw = fixD(Dm.wrist), b = fixR(Rp[tb]), bw = fixR(Rp.wrist), dx = ((a.x - aw.x) - (b.x - bw.x)) / palmR * 100, dy = ((a.y - aw.y) - (b.y - bw.y)) / palmR * 100;
      // "up" the palm = negative y in the frame: a drawing thumb base with larger y (lower) than the reference sits too low; "out" depends on the side of the thumb
      const outSign = (Rp.indexKnuckle && Rp.littleKnuckle ? Math.sign(fixR(Rp.indexKnuckle).x - fixR(Rp.littleKnuckle).x) : 1) || 1; // + x direction points toward the thumb side when the index knuckle is at larger x
      const horizontal = Math.abs(dx) > Math.abs(dy), raw = horizontal ? dx * outSign : dy;
      add('thumb_place', 'thumb_place', 'placement', '%palm', raw, { part: 'thumb', approximate: tb === 'thumbCmc' && false, points: [tb], sentence: (v, tol) => ({ key: horizontal ? (v > 0 ? 'thumb_sits_too_far_out' : 'thumb_sits_too_far_in') : (v > 0 ? 'thumb_sits_too_low' : 'thumb_sits_too_high'), n: displayCount(v, tol), part: 'thumb' }) });
    } else notChecked.add('thumb_place');
    // ---- knuckle line and palm width
    if (Dm.indexKnuckle && Dm.littleKnuckle && Rp.indexKnuckle && Rp.littleKnuckle) {
      const ang = (fix, P) => foldLine(deg(Math.atan2(fix(P.littleKnuckle).y - fix(P.indexKnuckle).y, fix(P.littleKnuckle).x - fix(P.indexKnuckle).x))), aD = ang(fixD, Dm), aR = ang(fixR, Rp), diff = wrap180(aD - aR);
      add('knuckle_line', 'knuckle_line', 'angle', 'deg', diff, { part: 'knuckles', points: ['indexKnuckle', 'littleKnuckle'], span: ['indexKnuckle', 'littleKnuckle'], sentence: (v, tol) => ({ key: Math.abs(aD) < Math.abs(aR) ? 'knuckle_line_flatter' : 'knuckle_line_steeper', d: displayCount(v, tol), part: 'knuckles', cw: v > 0 }) });
      const wD = dist(Dm.indexKnuckle, Dm.littleKnuckle), wR = dist(Rp.indexKnuckle, Rp.littleKnuckle);
      add('palm_width', 'palm_width', 'length', '%', (wD - wR) / wR * 100, { part: 'palm', points: ['indexKnuckle', 'littleKnuckle'], span: ['indexKnuckle', 'littleKnuckle'], sentence: (v, tol) => ({ key: v > 0 ? 'palm_too_wide' : 'palm_too_narrow', n: displayCount(v, tol), part: 'palm' }) });
    } else { notChecked.add('knuckle_line'); notChecked.add('palm_width'); }
    // ---- finger spread (neighbouring finger axes, not through interpolated points) and bend (needs the middle joints)
    const FD = Object.fromEntries(Object.keys(Dm).map(k => [k, fixD(Dm[k])])), FR = Object.fromEntries(Object.keys(Rp).map(k => [k, fixR(Rp[k])]));
    const axisOf = (P, f) => P[f + 'Knuckle'] && P[f + 'Tip'] ? cwUp(sub(P[f + 'Tip'], P[f + 'Knuckle'])) : null;
    for (const [a, b] of [['index', 'middle'], ['middle', 'ring'], ['ring', 'little']]) {
      if ([a + 'Tip', b + 'Tip', a + 'Knuckle', b + 'Knuckle'].some(n => D.interpolated[n] || R.interpolated[n] || !Dm[n] || !Rp[n])) continue;
      const sD = wrap180(axisOf(FD, b) - axisOf(FD, a)), sR = wrap180(axisOf(FR, b) - axisOf(FR, a));
      add('spread_' + a + '_' + b, 'finger_spread', 'angle', 'deg', sD - sR, { part: a + '_' + b, points: [a + 'Tip', b + 'Tip', a + 'Knuckle', b + 'Knuckle'], sentence: (v, tol) => ({ key: v > 0 ? 'fingers_too_far_apart' : 'fingers_too_close', d: displayCount(v, tol), pair: [a, b] }) });
    }
    for (const f of FINGERS) {
      const p = [f + 'Knuckle', f + 'Pip', f + 'Dip'];
      if (!p.every(n => Dm[n] && Rp[n])) continue;
      const bend = (P) => { const a = sub(P[p[1]], P[p[0]]), b = sub(P[p[2]], P[p[1]]); return wrap180(deg(Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x))); };
      const bD = bend(Dm), bR = bend(Rp), more = Math.abs(bD) > Math.abs(bR);
      add('bend_' + f, 'finger_bend', 'angle', 'deg', Math.abs(bD) - Math.abs(bR), { part: f, points: p, sentence: (v, tol) => ({ key: more ? 'finger_bent_more' : 'finger_bent_less', d: displayCount(v, tol), part: f }) });
    }
    // ---- hand angle and, when sized from outside (figure modes), hand size
    if (D.angle !== null && R.angle !== null) add('hand_angle', 'hand_angle', 'angle', 'deg', wrap180(angD - angR), { part: 'hand', points: ['wrist', 'middleKnuckle'], span: ['wrist', 'middleKnuckle'], sentence: (v, tol) => ({ key: v > 0 ? 'hand_turned_clockwise' : 'hand_turned_anticlockwise', d: displayCount(v, tol), part: 'hand' }) });
    if (al.external && D.palm > 0) { const pD = dist(Dm.wrist, Dm.middleKnuckle); add('hand_size', 'hand_size', 'length', '%', (pD - palmR) / palmR * 100, { part: 'hand', points: ['wrist', 'middleKnuckle'], span: ['wrist', 'middleKnuckle'], sentence: (v, tol) => ({ key: v > 0 ? 'hand_too_big' : 'hand_too_small', n: displayCount(v, tol), part: 'hand', side: DF.side || null }) }); }
    // ---- grouping: a spread or bend explained by a flagged finger of the pair is folded under it
    const groups = [], byKey = Object.fromEntries(items.map(i => [i.key, i]));
    const effect = (cause, eff, relation) => { if (eff.groupedUnder) return; eff.groupedUnder = cause.key; let g = groups.find(x => x.cause === cause.key); if (!g) groups.push(g = { cause: cause.key, effects: [] }); g.effects.push({ key: eff.key, relation, value: eff.value }); };
    if (byKey.hand_angle && byKey.hand_angle.flagged) for (const i of items) if (i.flagged && ['finger_spread', 'knuckle_line'].includes(i.family) && i.key !== 'hand_angle') effect(byKey.hand_angle, i, 'explained_by');
    if (byKey.thumb_length && byKey.thumb_length.flagged && byKey.thumb_place && byKey.thumb_place.flagged) effect(byKey.thumb_place, byKey.thumb_length, 'follows');
    const fsList = FINGERS.filter(f => byKey['finger_' + f] && byKey['finger_' + f].approximate);
    if (fsList.length) warnings.push({ key: 'fingers_foreshortened', fingers: fsList });
    if (Object.keys(D.interpolated).length || Object.keys(R.interpolated).length) warnings.push({ key: 'points_interpolated', names: Object.keys(Object.assign({}, D.interpolated, R.interpolated)) });
    if (al.size.note) warnings.push({ key: 'size_fallback', note: al.size.note });
    const rank = (a, b) => b.rankScore - a.rankScore;
    const flagged = items.filter(i => i.flagged).sort(rank), close = items.filter(i => !i.flagged && !i.locked).map(i => i.key);
    // finger ratios for the "Finger lengths" mini chart: each finger as a fraction of palm length, both hands
    const ratios = {}; for (const f of FINGERS.concat(['thumb'])) { const kn = f === 'thumb' ? (Rp.thumbMcp && Dm.thumbMcp ? 'thumbMcp' : 'wrist') : f + 'Knuckle', tp = f + 'Tip'; if (Dm[kn] && Dm[tp] && Rp[kn] && Rp[tp] && !interp(tp)) ratios[f] = { drawing: dist(Dm[kn], Dm[tp]) / palmR, reference: dist(Rp[kn], Rp[tp]) / palmR }; }
    return { ok: true, items, byKey, flagged, close, locked: Array.from(locked), groups, warnings, notChecked: Array.from(notChecked), info: { palmReference: R.palm, palmDrawingAligned: D.palm * al.scale, ratios }, tolerance: { preset, factor, sourceScale: srcScale, base: tolT }, source: { drawing: DF.source, reference: RF.source },
      summary: { count: flagged.length, major: flagged.filter(i => i.severity === 'major').length } };
  }
  function analyse(DF, RF, options) { const o = options || {}, alignment = align(DF, RF, o); return { alignment, report: measure(DF, RF, alignment, o) }; }

  DC.HandProportions = { COACH, NAMES, FINGERS, LM_INDEX, fromPoints, fromLandmarks, resolve, align, measure, analyse, apply, invert, SIZE_MODES, PIN_MODES, TOLERANCE, TOLERANCE_SPEC, TOLERANCE_TUNED, TOLERANCE_PRESETS, GAIN, BIAS, SOURCE_SCALE, TAP_NOISE, KAPPA, MIN_GAIN };
})();
