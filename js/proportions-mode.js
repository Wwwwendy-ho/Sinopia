// Mode choice for the Proportions check (phase 3): which check fits this pair of pictures. Pure functions, no network, no detectors of its own.
// Cheapest first: face (already shipped) -> pose -> hand -> other. The caller runs the detectors the answer asks for (`need`) and calls choose() again.
// Pose and hand detection on the DRAWING is never started by this module: when only the reference has been analysed the answer carries `offer`
// ("Try finding the pose automatically") and `pending: ['drawing']`; manual points count as a result for the drawing.
//
//   DC.ProportionsMode.choose({ drawing, reference }, opts?) -> {
//       mode: 'face'|'half'|'full'|'hand'|'other', auto: boolean (false when opts.override picked it),
//       need: null | { task: 'pose'|'hand', side: 'reference' }   the next detector to run on the REFERENCE (cheapest first); null when decided
//       offer: null | { task: 'pose'|'hand', side: 'drawing' }     detection the user may ask for on the drawing (never run automatically)
//       pending: ['drawing'?, 'reference'?]  sides whose result is still unknown
//       sections: [{ key: 'body'|'hands'|'face'|'outline'|'points', available: boolean, reason: null | 'not_visible'|'too_small'|'not_found'|'unknown' }]
//       models: ['face'|'pose'|'hand'|'segment']  the lazy models this mode uses
//       reasons: [{ key, ... }], notes: [{ key }]   keys, no English: 'face_large_both', 'pose_shoulders_hips', 'knees_visible', 'drawing_shows_less', 'largest_figure_used', ...
//   }
//   side: { size: {w, h} (image px), face?: null | { box: {x,y,w,h} }, pose?: null | PoseInfo, hand?: null | { box: {x,y,w,h} } }
//     undefined = not run yet (cheapest first logic), null = run, nothing found.
//   PoseInfo: { points: [33 {x,y,visibility}] } from DC.Landmarks.pose().poses[0] | { named: { shoulderL: {x,y}, ... } } hand-placed body points (BodyProportions names)
//             | { visible: { shoulders, hips, knees, ankles, wrists } } precomputed; optional count > 1 -> note 'largest_figure_used'.
//   DC.ProportionsMode.poseSummary(poseInfo) -> { shoulders, hips, knees, ankles, wrists, headTop }  booleans (both sides present / visible >= 0.5)
//   DC.ProportionsMode.MODES, SECTIONS, THRESHOLDS
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const DC = root.DrawingCompare = root.DrawingCompare || {};
  const MODES = ['face', 'half', 'full', 'hand', 'other'];
  const THRESHOLDS = { faceHeightFraction: 0.22, handShorterSideFraction: 0.25, visibility: 0.5, faceInFigurePx: 120, handInFigurePx: 64 };
  const SECTIONS = { face: ['face', 'outline'], half: ['body', 'hands', 'face', 'outline'], full: ['body', 'hands', 'face', 'outline'], hand: ['hands', 'outline'], other: ['outline', 'points'] };
  const MODELS = { face: ['face', 'segment'], half: ['pose', 'hand', 'segment'], full: ['pose', 'hand', 'segment'], hand: ['hand', 'segment'], other: ['segment'] };
  const IDX = { shoulders: [11, 12], hips: [23, 24], knees: [25, 26], ankles: [27, 28], wrists: [15, 16] };

  function poseSummary(p) {
    const out = { shoulders: false, hips: false, knees: false, ankles: false, wrists: false, headTop: false };
    if (!p) return out;
    if (p.visible) return Object.assign(out, p.visible);
    if (p.points && p.points.length >= 33) { const v = i => p.points[i] && (p.points[i].visibility === undefined || p.points[i].visibility >= THRESHOLDS.visibility); for (const k of Object.keys(IDX)) out[k] = IDX[k].every(v); out.headTop = !!(p.points[2] && p.points[5]); return out; }
    if (p.named) { const n = p.named, has = (a, b) => !!(n[a] && n[b]); out.shoulders = has('shoulderL', 'shoulderR'); out.hips = has('hipL', 'hipR'); out.knees = has('kneeL', 'kneeR'); out.ankles = has('ankleL', 'ankleR'); out.wrists = has('wristL', 'wristR'); out.headTop = !!n.headTop; }
    return out;
  }
  const faceBig = s => !!(s && s.face && s.size && s.face.box && s.face.box.h >= THRESHOLDS.faceHeightFraction * s.size.h);
  const handBig = s => !!(s && s.hand && s.size && s.hand.box && Math.max(s.hand.box.w, s.hand.box.h) >= THRESHOLDS.handShorterSideFraction * Math.min(s.size.w, s.size.h));
  const levelOf = ps => ps.shoulders && ps.hips ? (ps.ankles ? 'full' : 'half') : null; // half = knees may show, ankles not both

  function choose(input, opts) {
    const o = opts || {}, D = (input && input.drawing) || {}, R = (input && input.reference) || {};
    const reasons = [], notes = [], pending = [];
    let mode = null, need = null, offer = null, auto = true;
    const poseD = D.pose, poseR = R.pose, handD = D.hand, handR = R.hand;
    if (D.pose === undefined) pending.push('drawing');
    if (R.pose === undefined) pending.push('reference');
    const decide = () => {
      // 1) face close-up: a large face in both images (the face finder is already loaded for Proportions)
      if (faceBig(D) && faceBig(R)) { reasons.push({ key: 'face_large_both' }); return 'face'; }
      if (D.face === undefined || R.face === undefined) { reasons.push({ key: 'face_unknown' }); }
      // 2) pose: the reference first (cheapest, auto), the drawing only when the user asked or placed points
      if (R.pose === undefined) { need = { task: 'pose', side: 'reference' }; return null; }
      const sR = poseSummary(R.pose), lvR = levelOf(sR), sD = poseSummary(D.pose), lvD = D.pose ? levelOf(sD) : null;
      if (lvR) {
        let lv = lvR;
        if (D.pose && !lvD) { reasons.push({ key: 'drawing_no_figure' }); }
        if (lvD) { lv = lvR === 'full' && lvD === 'full' ? 'full' : 'half'; if (lvR !== lvD) notes.push({ key: 'drawing_shows_less', which: lvR === 'full' ? 'drawing' : 'reference' }); }
        if (!D.pose) { offer = { task: 'pose', side: 'drawing' }; }
        reasons.push({ key: 'pose_shoulders_hips' }); if (sR.knees || sR.ankles) reasons.push({ key: 'knees_visible' });
        if (R.pose && R.pose.count > 1 || D.pose && D.pose.count > 1) notes.push({ key: 'largest_figure_used' });
        return lv;
      }
      // 3) hand study: no pose with shoulders and a large hand
      if (R.pose === null || (R.pose && !lvR)) {
        if (R.hand === undefined) { need = { task: 'hand', side: 'reference' }; return null; }
        if (handBig(R) && (D.hand === undefined || D.hand === null || handBig(D))) { reasons.push({ key: 'hand_large' }); if (D.hand === undefined || D.hand === null) offer = { task: 'hand', side: 'drawing' }; return 'hand'; }
        if (handBig(R)) { reasons.push({ key: 'hand_large' }); return 'hand'; }
      }
      reasons.push({ key: 'nothing_recognised' }); return 'other';
    };
    if (o.override && MODES.includes(o.override)) { mode = o.override; auto = false; reasons.push({ key: 'override' }); }
    else mode = decide();
    if (mode === null) mode = 'other'; // undecided until `need` is satisfied: callers check need first
    const decided = need === null;
    // sections of this mode, with the reason a section is missing
    const sD = poseSummary(D.pose), sR = poseSummary(R.pose), both = k => sD[k] && sR[k] || (!D.pose && sR[k]);
    const sections = SECTIONS[mode].map(key => {
      let available = true, reason = null;
      if (key === 'body') { available = mode === 'half' || mode === 'full'; }
      if (key === 'hands' && (mode === 'half' || mode === 'full')) { if (!both('wrists')) { available = false; reason = 'not_visible'; } else if (R.hand === null) { available = false; reason = 'not_found'; } else if (R.hand && R.hand.box && Math.max(R.hand.box.w, R.hand.box.h) < THRESHOLDS.handInFigurePx) { available = false; reason = 'too_small'; } }
      if (key === 'face' && (mode === 'half' || mode === 'full')) { const fr = R.face && R.face.box ? R.face.box.h : null, fd = D.face && D.face.box ? D.face.box.h : null; if (R.face === null || D.face === null) { available = false; reason = 'not_found'; } else if ((fr !== null && fr < THRESHOLDS.faceInFigurePx) || (fd !== null && fd < THRESHOLDS.faceInFigurePx)) { available = false; reason = 'too_small'; } else if (fr === null) { available = true; reason = 'unknown'; } }
      return { key, available, reason };
    });
    return { mode, auto, decided, need: o.override ? null : need, offer, pending, sections, models: MODELS[mode].slice(), reasons, notes };
  }

  DC.ProportionsMode = { choose, poseSummary, MODES, SECTIONS, THRESHOLDS, MODELS };
})();
