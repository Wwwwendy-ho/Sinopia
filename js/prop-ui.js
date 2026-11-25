// Proportions check: the user interface on top of js/proportions.js (engine) and js/landmarks.js (face finder).
// A check layer over whichever layout is active: marks drawn on a canvas over each pane, and a report (a taped paper column on the
// right of the workspace; a bottom sheet on phones). Wired to app.js through init(api), see the end of app.js.
//
// Coordinates: every point is in the ORIENTED image's pixels (the image as displayed, after any 90-degree turns and mirroring),
// origin top-left. Detection runs on that oriented image, so the engine's similarity maps drawing -> reference directly and the
// layer transform needs no orientation term.  Left and right are the person's own (engine convention).
(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});
  const SLOTS = ['drawing', 'reference'];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const INK = '#2a2521', SINOPIA = '#a5502f', VERMILION = '#c2492a', HALO = '#fbf7ee', SQUASH = '#2f6f86', PAPER = '#f4efe5';
  const SERIF = '"Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  const ORDER = ['browOuterR', 'browMidR', 'browInnerR', 'browInnerL', 'browMidL', 'browOuterL', 'eyeCornerOuterR', 'eyeCornerInnerR', 'eyeR', 'eyeCornerInnerL', 'eyeCornerOuterL', 'eyeL',
    'noseBridge', 'noseTip', 'noseBase', 'noseAlaR', 'noseAlaL', 'mouthR', 'mouthL', 'lipUpper', 'mouthCentre', 'lipLower', 'chin', 'jawLowR', 'jawLowL', 'jawHighR', 'jawHighL', 'cheekR', 'cheekL', 'hairline'];
  const MANUAL = ['eyeR', 'eyeL', 'noseBase', 'mouthCentre', 'chin'];
  const GROUP_NOUN = { eye_spacing: 'eye_spacing', eye_height_R: 'eye_level', eye_height_L: 'eye_level', eye_tilt: 'eye_level', brow_height_R: 'brows', brow_height_L: 'brows', nose_length: 'nose_length',
    nose_width: 'nose_width', mouth_height: 'mouth_height', mouth_width: 'mouth_width', chin_length: 'chin', jaw_width: 'jaw', jaw_width_high: 'jaw', head_tilt: 'head_tilt' };
  const NOUN_ORDER = ['brows', 'eye_level', 'eye_spacing', 'nose_length', 'nose_width', 'mouth_height', 'mouth_width', 'chin', 'jaw', 'head_tilt'];
  const MAX_ROWS = 6;
  const PHONE = matchMedia('(max-width: 720px)');
  const FINE = matchMedia('(pointer: fine)');

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lc = (s) => (/^[\u4e00-\u9fff]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  let A = null; // the app's api (see init)
  let P = null, LM = null, tk = null, i18n = null;
  const S = {
    open: false, sel: null, hover: null, edit: false, placing: null, explain: false, expanded: false, sheet: 'half',
    analysis: null, frozen: false, loading: false, pending: 0, lmStatus: 'idle', detectError: false,
    saved: null, blend: false, hits: { drawing: [], reference: [] }, seen: new Set(), facesBoth: false, bgTimer: 0, announced: '', drag: null,
    tab: 'all', modeRes: null, hoverHeads: false, outlineBusy: false,
  };
  const cache = new WeakMap(); // source canvas -> Map(orientKey -> entry)
  const els = {}; // panel elements
  const marks = {}; // per pane: the marks canvas
  const BODY_COACH = ['headTop', 'chin', 'neck', 'shoulderR', 'shoulderL', 'elbowR', 'elbowL', 'wristR', 'wristL', 'hipR', 'hipL', 'kneeR', 'kneeL', 'ankleR', 'ankleL'];
  const HAND_COACH = () => (DC.HandProportions ? DC.HandProportions.COACH : ['wrist', 'thumbTip', 'indexKnuckle', 'littleKnuckle', 'indexTip', 'middleTip', 'littleTip']);

  // ------------------------------------------------------------------------------------------------------------ helpers
  const propOf = (layer) => (layer.prop && typeof layer.prop === 'object' ? layer.prop : (layer.prop = {}));
  const edits = (layer) => (propOf(layer).edits || (propOf(layer).edits = {}));
  const st = () => A.state.prop;
  const showPoints = () => st().points === true; // false / default: only the points of flagged and selected differences
  const overlay = () => A.state.layout === 'overlay';
  const orientKey = (l) => `${l.rotation}|${l.flipH ? 1 : 0}|${l.flipV ? 1 : 0}`;

  function entryFor(layer) {
    if (!layer.source) return null;
    let m = cache.get(layer.source);
    if (!m) cache.set(layer.source, (m = new Map()));
    const key = orientKey(layer);
    if (!m.has(key)) m.set(key, { key, promise: null, faces: null, detector: null, error: null, fellBack: false, size: { w: layer.bounds.w, h: layer.bounds.h }, pose: undefined, poseCount: 0, hand: undefined, hands: null, segment: undefined, gray: null, lines: null });
    return m.get(key);
  }
  function orientedCanvas(layer) {
    if (!layer.rotation && !layer.flipH && !layer.flipV) return layer.source;
    const { w, h } = layer.bounds, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.translate(w / 2, h / 2);
    x.scale(layer.flipH ? -1 : 1, layer.flipV ? -1 : 1);
    x.rotate((layer.rotation * Math.PI) / 180);
    x.drawImage(layer.source, -layer.source.width / 2, -layer.source.height / 2);
    return c;
  }
  function detectLayer(layer, force) {
    const e = entryFor(layer);
    if (!e) return Promise.resolve(null);
    if (e.promise && !force) return e.promise;
    S.pending++;
    e.faces = null;
    e.promise = (async () => {
      try {
        const cv = orientedCanvas(layer);
        let prep = null, use = cv, norm = false;
        try { // faint but clean drawings are stretched before detection; noisy ones are not (see Ink.shouldNormalise)
          if (DC.Ink) { prep = DC.Ink.prepare(cv); if (DC.Ink.shouldNormalise(prep)) { use = DC.Ink.normalise(cv); norm = use !== cv; } }
        } catch (_) { prep = null; use = cv; }
        const res = await LM.detect(use);
        e.faces = res.faces || [];
        e.normalised = norm;
        e.regions = e.faces.map((f) => { try { return prep && f.detector === 'mediapipe' ? DC.Ink.regions(prep, f.points) : null; } catch (_) { return null; } });
        if (prep) { e.stats = { noiseRel: prep.noiseRel, faint: prep.faint, range: prep.range }; prep.g = null; }
        S.pickKey = null;
        e.detector = res.detector;
        e.error = res.error || null;
        e.fellBack = !!res.fellBack || res.detector === 'faceapi';
      } catch (err) {
        e.faces = []; e.error = String(err && err.message || err); e.detector = null;
      }
      return e;
    })().finally(() => { S.pending--; });
    return e.promise;
  }
  const pairKey = () => `${A.shelf.active('drawing')}|${A.shelf.active('reference')}|${orientKey(A.layers.drawing)}|${orientKey(A.layers.reference)}`;

  /** Background detection (not on page load): after the user changed an image, so the entry dot can say faces are found. */
  function scheduleBackground() {
    clearTimeout(S.bgTimer);
    if (S.open) return;
    S.bgTimer = setTimeout(async () => {
      const { drawing: d, reference: r } = A.layers;
      if (S.open || !d.hasImage || !r.hasImage) return;
      const key = pairKey();
      // The dot only needs "is there a face": ask the face-api detector the app already uses for auto-align (cached per photo).
      // MediaPipe (about 13.5 MB) is never loaded here; it loads when the user opens Proportions.
      const found = async (l) => { try { const e = await DC.Subjects.analyze({ source: l.source, rotation: l.rotation, flipH: l.flipH, flipV: l.flipV }); return !!(e && e.faces && e.faces.length); } catch (_) { return false; } };
      const [fd, fr] = await Promise.all([found(d), found(r)]);
      if (pairKey() !== key) return;
      const both = fd && fr;
      S.facesBoth = both;
      sync();
      if (both && !S.open && !A.state.tipProp && !S.seen.has(key)) {
        A.state.tipProp = true;
        A.scheduleSave();
        A.toast(tk('toast.faces'), { label: tk('toast.check'), run: () => open() });
      }
    }, 1400);
  }
  const hasFace = (slot) => { const e = entryFor(A.layers[slot]); return !!(e && e.faces && e.faces.length); };

  // ------------------------------------------------------------------------------------------------------------ features and analysis
  // hand-placed face points: both eyes are the minimum; nose, mouth and chin may be skipped (the report then says what is missing)
  const isManual = (slot) => { const p = A.layers[slot].prop; return !!(p && p.manual && p.manual.eyeR && p.manual.eyeL); };

  // ---- free point pairs (non-face subjects): [{ r: {x,y} in the reference's oriented px, d: {x,y} in the drawing's }], stored with the drawing's view
  const PAIRS_MAX = 12;
  const PAIR_RE = /^p\d+$/;
  const pairsOf = () => { const p = propOf(A.layers.drawing).pairs; return Array.isArray(p) ? p.filter((q) => q && q.d && q.r) : []; };
  const isPairsMode = () => pairsOf().length > 0;
  const ptLabel = (name) => (PAIR_RE.test(name) ? tk('pt.pair', { k: +name.slice(1) }) : tk('pt.' + name));
  function setPoint(who, name, pt) {
    const v = { x: pt.x, y: pt.y };
    if (PAIR_RE.test(name)) { const pr = (propOf(A.layers.drawing).pairs || [])[+name.slice(1) - 1]; if (pr) pr[who === 'drawing' ? 'd' : 'r'] = v; return; }
    const L = A.layers[who], m = activeMode();
    if (m === 'half' || m === 'full') {
      const p = propOf(L);
      if (p.bodyManual && p.bodyManual[name]) p.bodyManual[name] = v;
      else (p.bodyEdits || (p.bodyEdits = {}))[name] = v;
      return;
    }
    if (m === 'hand') {
      const p = propOf(L);
      if (p.handManual && p.handManual[name]) p.handManual[name] = v;
      else (p.handEdits || (p.handEdits = {}))[name] = v;
      return;
    }
    (isManual(who) ? propOf(L).manual : edits(L))[name] = v;
  }
  const activeMode = () => {
    if (isPairsMode()) return 'other';
    const dp = propOf(A.layers.drawing), ov = dp.modeKey === pairKey() ? dp.modeOverride : null;
    if (ov && ov !== 'auto') return ov;
    return (S.modeRes && S.modeRes.mode) || 'face';
  };
  const modeOverride = () => {
    const dp = propOf(A.layers.drawing);
    return dp.modeKey === pairKey() && dp.modeOverride ? dp.modeOverride : 'auto';
  };

  /** The faces to measure: with several in a picture, the pair (drawing face, reference face) that fit each other best, not the largest. */
  function pickPair() {
    const key = pairKey();
    if (S.pickKey === key && S.pick) return S.pick;
    const dE = entryFor(A.layers.drawing), rE = entryFor(A.layers.reference), strip = (e) => ((e && e.faces) || []).map((f) => ({ points: f.points, detector: f.detector }));
    S.pick = P.pickFaces(strip(dE), strip(rE)); S.pickKey = key;
    return S.pick;
  }
  function featuresOf(slot) {
    const layer = A.layers[slot], e = entryFor(layer), p = layer.prop;
    let fs = null;
    if (isManual(slot)) {
      const m = p.manual;
      fs = P.fromPoints({ eyeR: m.eyeR, eyeL: m.eyeL, noseBase: m.noseBase, noseTip: m.noseBase, mouthCentre: m.mouthCentre, mouthR: m.mouthCentre, mouthL: m.mouthCentre, chin: m.chin }, 'manual');
    } else if (e && e.faces && e.faces[0]) {
      const idx = e.faces.length > 1 ? (slot === 'drawing' ? pickPair().d : pickPair().r) : 0, face = e.faces[idx] || e.faces[0];
      fs = P.features(face.points, face.detector);
      const miss = slot === 'drawing' && e.regions && e.regions[idx] ? e.regions[idx].missing : [];
      if (miss && miss.length) fs = P.withoutRegions(fs, miss); // regions with no drawing: the face finder invented those points
    }
    if (slot === 'drawing') S.unfinished = (fs && fs.dropped) || [];
    if (fs && p && p.edits) for (const [name, v] of Object.entries(p.edits)) if (fs.points[name] !== undefined && v && Number.isFinite(v.x)) fs.points[name] = { x: v.x, y: v.y };
    return fs;
  }
  function customSizeOf(D, R) {
    const dp = propOf(A.layers.drawing);
    if (dp.customSize && dp.customSize.drawing && dp.customSize.reference) return clone(dp.customSize);
    const d = P.resolve(D), r = P.resolve(R);
    return { drawing: [{ ...d.eyeMid }, { ...d.chin }], reference: [{ ...r.eyeMid }, { ...r.chin }] };
  }
  function alignOptions(D, R) {
    const s = st(), dp = propOf(A.layers.drawing);
    const o = { size: s.size, matchTilt: !!s.matchTilt, pin: s.pin === 'custom' ? 'auto' : s.pin };
    if (s.pin === 'custom' && dp.customPin) {
      const c = dp.customPin;
      o.pin = { x: c.x, y: c.y };
      if (Number.isFinite(c.dx)) o.pin.drawing = { x: c.dx, y: c.dy };
    }
    if (s.size === 'custom') o.custom = customSizeOf(D, R);
    return o;
  }

  function tiltDegrees(item, a) {
    const sep = Math.max(0.2, dist(a.Rp.eyeR, a.Rp.eyeL) / a.al.unit.ecReference);
    return Math.max(1, Math.round((Math.atan2(Math.abs(item.value) / 100, sep) * 180) / Math.PI));
  }
  function sentenceText(s, item, a) {
    if (!s) return '';
    let key = 'sent.' + s.key;
    if ((s.key === 'finger_bent_more' || s.key === 'finger_bent_less') && s.part) key = 'sent.' + s.part + '_' + s.key;
    if (s.side === 'left' || s.side === 'right') { const k2 = key + '.' + s.side; if (i18n.has(k2)) key = k2; }
    const params = {};
    if (s.n !== undefined) params.n = s.n;
    if (s.d !== undefined) params.d = s.d;
    if (s.h !== undefined) params.h = s.h;
    if (/^eye_line_tilted/.test(s.key) && item && a) params.d = tiltDegrees(item, a);
    if (s.key === 'outline_too_far_out' || s.key === 'outline_too_far_in' || s.key === 'outline_not_followed') {
      params.where = outlineWhere(s);
    }
    if ((s.key === 'fingers_too_far_apart' || s.key === 'fingers_too_close') && Array.isArray(s.pair)) {
      params.pair = i18n.list(s.pair.map((f) => lc(tk('finger.' + f))));
    }
    if (s.key === 'joint_moves_with' && s.part) {
      params.part = lc(tk('pt.' + s.part + (s.side === 'left' ? 'L' : 'R')));
    }
    return tk(key, params);
  }
  function outlineWhere(s) {
    if (s.part) {
      const pt = tk('part.' + s.part);
      if (s.side === 'left' || s.side === 'right') return tk('side.' + s.side + '.part', { part: pt });
      return pt;
    }
    return s.position ? tk('pos.' + s.position) : '';
  }

  function buildView(report, a) {
    const hide = new Set();
    if (isManual('drawing') || isManual('reference')) hide.add('mouth_width');
    if (a.al.matchTilt) hide.add('head_tilt'); // the drawing was turned to the reference's tilt: nothing left to report
    const flagged = report.flagged.filter((i) => !hide.has(i.key));
    const effects = new Map(report.groups.map((g) => [g.cause, g.effects]));
    const rows = [], jaw = [];
    const mk = (parts) => {
      const primary = parts.slice().sort((x, y) => Math.abs(y.value) / y.tolerance - Math.abs(x.value) / x.tolerance)[0];
      const soft = primary.severity === 'possible' || primary.reliability === 'low';
      const sub = [];
      let arrows = [];
      const points = new Set();
      for (const it of parts) {
        for (const ar of it.arrows) arrows.push({ ar, light: false });
        it.points.forEach((n) => points.add(n));
        for (const ef of effects.get(it.key) || []) {
          const eit = report.byKey[ef.key];
          if (ef.sentence) sub.push({ sentence: ef.sentence, item: eit });
          if (eit) { for (const ar of eit.arrows) arrows.push({ ar, light: true }); eit.points.forEach((n) => points.add(n)); }
        }
      }
      return { id: primary.key, key: primary.key, parts, primary, sentence: primary.sentence, severity: soft ? 'possible' : primary.severity, soft, sub, arrows, points: [...points], approx: parts.some((p) => p.approximate), n: 0,
        text: sentenceText(primary.sentence, primary, a) };
    };
    for (const it of flagged) {
      if (it.groupedUnder) continue;
      if (it.feature === 'jaw') { jaw.push(it); continue; }
      rows.push(mk([it]));
    }
    if (jaw.length) rows.push(mk(jaw));
    const ranked = rows.filter((r) => !r.soft).concat(rows.filter((r) => r.soft));
    ranked.forEach((r, i) => { r.n = i + 1; });
    // "Close enough": a feature group is close only if every one of its measured items is within tolerance
    const byGroup = {};
    for (const it of report.items) {
      if (hide.has(it.key)) continue;
      const g = GROUP_NOUN[it.key];
      if (!g) continue;
      (byGroup[g] = byGroup[g] || []).push(it);
    }
    const close = NOUN_ORDER.filter((g) => byGroup[g] && byGroup[g].every((it) => !it.flagged && !it.locked));
    return { rows: ranked, close };
  }

  /** Pairs mode: the same robust fit as the face check, over the user's matching points; each pair is one "feature" named p1, p2, ... */
  function recomputePairs(opt) {
    const pairs = pairsOf(), n = pairs.length;
    const pe = pairs.map((q) => ({ drawing: q.d, reference: q.r }));
    let al;
    if (opt.frozen && S.analysis && S.analysis.ok && S.analysis.mode === 'pairs') al = S.analysis.al;
    else al = n >= 3 ? P.alignPairs(pe) : { ok: false, reason: 'needs three pairs' };
    if (!al.ok) { S.analysis = { ok: false, mode: 'pairs', reason: al.reason, count: n }; return S.analysis; }
    const report = P.measurePairs(pe, al, { tolerance: st().tolerance });
    const D = { points: {} }, R = { points: {} };
    pairs.forEach((q, i) => { D.points['p' + (i + 1)] = q.d; R.points['p' + (i + 1)] = q.r; });
    const rows = report.flagged.map((it) => ({
      id: 'p' + it.index, key: 'p' + it.index, parts: [it], primary: it, sentence: it.sentence, severity: it.severity, soft: false, sub: [], arrows: [], points: ['p' + it.index], approx: false, n: it.index,
      text: tk('sent.' + it.sentence.key, { k: it.sentence.k, n: it.sentence.n }),
    }));
    S.analysis = { ok: true, mode: 'pairs', count: n, D, R, Dp: D.points, Rp: R.points, al, report, grid: null, view: { rows, close: report.close, pairs: true } };
    return S.analysis;
  }

  // ---- Phase 3 helpers: body, hand, outline features & combined view
  function bodyFeaturesOf(slot) {
    const BP = DC.BodyProportions; if (!BP) return null;
    const L = A.layers[slot], p = L.prop, e = entryFor(L);
    let fs = null;
    if (p && p.bodyManual && Object.keys(p.bodyManual).length >= 3) fs = BP.fromPoints(p.bodyManual, { source: 'manual', foreshortened: p.bodyForeshort });
    else if (e && e.pose) fs = BP.fromPose(e.pose);
    if (fs && p && p.bodyEdits) for (const [k, v] of Object.entries(p.bodyEdits)) if (fs.points[k] !== undefined && v && Number.isFinite(v.x)) fs.points[k] = { x: v.x, y: v.y };
    return fs;
  }
  function handFeaturesOf(slot) {
    const HP = DC.HandProportions; if (!HP) return null;
    const L = A.layers[slot], p = L.prop, e = entryFor(L);
    const side = st().handSide || 'right';
    let fs = null;
    if (p && p.handManual && Object.keys(p.handManual).length >= 3) fs = HP.fromPoints(p.handManual, { source: 'manual', side });
    else if (e && e.hand) fs = HP.fromLandmarks(e.hand, { side });
    if (fs && p && p.handEdits) for (const [k, v] of Object.entries(p.handEdits)) if (fs.points[k] !== undefined && v && Number.isFinite(v.x)) fs.points[k] = { x: v.x, y: v.y };
    return fs;
  }
  function bodyAlignOpts(D, R) {
    const s = st();
    return { size: s.sizeBody || 'auto', pin: s.pinBody || 'auto', matchTilt: !!s.matchTilt };
  }
  function handAlignOpts(D, R) {
    const s = st();
    return { size: s.sizeHand || 'auto', pin: s.pinHand || 'auto', matchTilt: !!s.matchTilt };
  }
  function outlineOf(al, bodyPoints) {
    const O = DC.Outline; if (!O || !al || !al.ok) return null;
    const dE = entryFor(A.layers.drawing), rE = entryFor(A.layers.reference);
    if (!dE || !rE || !dE.lines) return null;
    const seedRef = propOf(A.layers.reference).outlineSeed || null;
    if (!rE.segment && !rE.gray) return null;
    const refArg = rE.segment ? { mask: O.maskFromSegment(rE.segment) } : { gray: rE.gray };
    try {
      return O.analyse({
        reference: refArg, drawing: { lines: dE.lines }, alignment: al, bodyPoints,
        seed: seedRef ? { reference: seedRef } : undefined,
        tolerance: st().tolerance, style: st().style,
      });
    } catch (_) { return null; }
  }
  function buildOutlineRows(outRep, a) {
    if (!outRep || !outRep.ok) return [];
    return (outRep.items || []).map((it, idx) => ({
      id: 'out_' + idx, key: it.key, section: 'outline', parts: [it], primary: it,
      sentence: it.sentence, severity: it.severity, soft: false, sub: [], arrows: [],
      points: [], approx: false, n: 0, region: it.region, rankScore: it.rankScore || 0.8,
      text: sentenceText(it.sentence, it, a),
    }));
  }
  function buildSectionRows(report, section, a) {
    if (!report || !report.ok) return [];
    const effects = new Map((report.groups || []).map((g) => [g.cause, g.effects]));
    const rows = [];
    for (const it of report.flagged || []) {
      if (it.groupedUnder) continue;
      if (section === 'body' && a.al && a.al.matchTilt && it.key === 'lean') continue;
      if (section === 'hands' && a.al && a.al.matchTilt && it.key === 'hand_angle') continue;
      const soft = it.severity === 'possible';
      const sub = []; const arrows = []; const pts = new Set(it.points || []);
      for (const ar of it.arrows || []) arrows.push({ ar, light: false });
      for (const ef of effects.get(it.key) || []) {
        const eit = report.byKey && report.byKey[ef.key];
        if (ef.sentence) sub.push({ sentence: ef.sentence, item: eit });
        if (eit) { for (const ar of eit.arrows || []) arrows.push({ ar, light: true }); (eit.points || []).forEach((n) => pts.add(n)); }
      }
      rows.push({
        id: section + ':' + it.key, key: it.key, section, parts: [it], primary: it,
        sentence: it.sentence, severity: soft ? 'possible' : it.severity, soft, sub, arrows,
        points: [...pts], approx: !!it.approximate, n: 0, rankScore: it.rankScore || (Math.abs(it.value) / (it.tolerance || 1)),
        text: sentenceText(it.sentence, it, a),
      });
    }
    return rows;
  }
  function combineAllRows(bySec, a) {
    const bodyRows = bySec.body || [], outRows = (bySec.outline || []).slice();
    // Knock-on grouping: outline region matching a flagged body part/side folds under that body row
    const keptOut = [];
    for (const or of outRows) {
      const part = or.primary && or.primary.part, side = or.primary && or.primary.side;
      const parent = bodyRows.find((br) => {
        const bp = br.primary && br.primary.part, bs = br.primary && br.primary.side;
        if (!bp || !part) return false;
        if (bp === part && (!side || !bs || bs === side)) return true;
        if (bp === 'legs' && ['thigh', 'shin', 'knee', 'foot'].includes(part)) return true;
        if (bp === 'leg' && (!side || bs === side) && ['thigh', 'shin', 'knee', 'foot'].includes(part)) return true;
        return false;
      });
      if (parent) { parent.sub.push({ sentence: { key: 'outline_follows' }, item: or.primary }); }
      else keptOut.push(or);
    }
    const secOrder = { body: 0, face: 1, hands: 2, outline: 3, pairs: 4 };
    const pool = [...bodyRows, ...(bySec.face || []), ...(bySec.hands || []), ...keptOut, ...(bySec.pairs || [])];
    pool.sort((x, y) => (x.soft !== y.soft ? (x.soft ? 1 : -1) : (y.rankScore - x.rankScore) || (secOrder[x.section] - secOrder[y.section])));
    // Cap initial screen calm: at most 2 outline rows in top 6
    const top = [], rest = []; let outN = 0;
    for (const r of pool) {
      if (top.length < MAX_ROWS) {
        if (r.section === 'outline') { if (outN < 2) { outN++; top.push(r); } else rest.push(r); }
        else top.push(r);
      } else rest.push(r);
    }
    const all = top.concat(rest);
    all.forEach((r, i) => { r.n = i + 1; });
    return all;
  }

  function recompute(opt = {}) {
    if (isPairsMode()) return recomputePairs(opt);
    const mode = activeMode();
    if (mode === 'face') {
      const D = featuresOf('drawing'), R = featuresOf('reference');
      if (!D || !R) { S.analysis = null; return null; }
      let al = opt.frozen && S.analysis && S.analysis.ok && S.analysis.mode === 'face' ? S.analysis.al : P.align(D, R, alignOptions(D, R));
      if (!al.ok) { S.analysis = { ok: false, mode: 'face', reason: al.reason }; return S.analysis; }
      const report = P.measure(D, R, al, { tolerance: st().tolerance, style: st().style });
      const a = { ok: true, mode: 'face', D, R, Dp: P.resolve(D), Rp: P.resolve(R), al, report, grid: null };
      if (st().grid) { try { a.grid = P.distortionGrid(D, R, al); } catch (_) { a.grid = null; } }
      const faceView = buildView(report, a);
      faceView.rows.forEach((r) => { r.section = 'face'; r.rankScore = Math.abs(r.primary.value) / (r.primary.tolerance || 1); });
      const outRep = outlineOf(al, null);
      const outRows = buildOutlineRows(outRep, a);
      const bySec = { face: faceView.rows, outline: outRows };
      const allRows = combineAllRows(bySec, a);
      a.outline = outRep;
      a.sections = { all: allRows, face: faceView.rows, outline: outRows };
      a.view = { rows: (S.tab === 'outline' ? outRows : S.tab === 'face' ? faceView.rows : allRows), close: faceView.close, bySec };
      a.view.rows.forEach((r, i) => { r.n = i + 1; });
      S.analysis = a;
      return a;
    }
    if (mode === 'half' || mode === 'full') {
      const BP = DC.BodyProportions;
      const D = bodyFeaturesOf('drawing'), R = bodyFeaturesOf('reference');
      if (!D || !R) { S.analysis = null; return null; }
      let al = opt.frozen && S.analysis && S.analysis.ok && S.analysis.mode === mode ? S.analysis.al : BP.align(D, R, bodyAlignOpts(D, R));
      if (!al.ok) { S.analysis = { ok: false, mode, reason: al.reason }; return S.analysis; }
      const report = BP.measure(D, R, al, { tolerance: st().tolerance });
      const mir = BP.mirrorCheck(D, R, al);
      const Dr = BP.resolve(D), Rr = BP.resolve(R);
      const a = { ok: true, mode, D, R, Dp: Dr.P, Rp: Rr.P, al, report, mirrorBody: mir, grid: null };
      const bodyRows = buildSectionRows(report, 'body', a);
      const outRep = outlineOf(al, Rr.P);
      const outRows = buildOutlineRows(outRep, a);
      const bySec = { body: bodyRows, outline: outRows };
      const allRows = combineAllRows(bySec, a);
      a.outline = outRep;
      a.sections = { all: allRows, body: bodyRows, outline: outRows };
      const activeRows = S.tab === 'body' ? bodyRows : S.tab === 'outline' ? outRows : allRows;
      activeRows.forEach((r, i) => { r.n = i + 1; });
      a.view = { rows: activeRows, close: report.close || [], bySec };
      S.analysis = a;
      return a;
    }
    if (mode === 'hand') {
      const HP = DC.HandProportions;
      const D = handFeaturesOf('drawing'), R = handFeaturesOf('reference');
      if (!D || !R) { S.analysis = null; return null; }
      let al = opt.frozen && S.analysis && S.analysis.ok && S.analysis.mode === 'hand' ? S.analysis.al : HP.align(D, R, handAlignOpts(D, R));
      if (!al.ok) { S.analysis = { ok: false, mode: 'hand', reason: al.reason }; return S.analysis; }
      const report = HP.measure(D, R, al, { tolerance: st().tolerance });
      const Dr = HP.resolve(D), Rr = HP.resolve(R);
      const a = { ok: true, mode: 'hand', D, R, Dp: Dr.P, Rp: Rr.P, al, report, grid: null };
      const handRows = buildSectionRows(report, 'hands', a);
      const outRep = outlineOf(al, null);
      const outRows = buildOutlineRows(outRep, a);
      const bySec = { hands: handRows, outline: outRows };
      const allRows = combineAllRows(bySec, a);
      a.outline = outRep;
      a.sections = { all: allRows, hands: handRows, outline: outRows };
      const activeRows = S.tab === 'hands' ? handRows : S.tab === 'outline' ? outRows : allRows;
      activeRows.forEach((r, i) => { r.n = i + 1; });
      a.view = { rows: activeRows, close: report.close || [], bySec };
      S.analysis = a;
      return a;
    }
    // 'other': outline-only (using current layer alignment between drawing and reference)
    const Ld = A.layers.drawing, Lr = A.layers.reference, ds = sizeOfSlot('drawing'), rs = sizeOfSlot('reference');
    const sc = Ld.scale / (Lr.scale || 1), ang = Ld.angle - Lr.angle;
    const c = Math.cos(ang), sN = Math.sin(ang);
    const alOther = { ok: true, scale: sc, rotation: ang, tx: rs.w / 2 + (Ld.x - Lr.x) / (Lr.scale || 1) - sc * (c * ds.w / 2 - sN * ds.h / 2), ty: rs.h / 2 + (Ld.y - Lr.y) / (Lr.scale || 1) - sc * (sN * ds.w / 2 + c * ds.h / 2), unit: { ecReference: Math.min(rs.w, rs.h) * 0.4 } };
    const outRep = outlineOf(alOther, null);
    if (!outRep || !outRep.ok) { S.analysis = { ok: false, mode: 'other', outline: outRep, reason: outRep && outRep.reason, needsSeed: !!(outRep && outRep.needsSeed) }; return S.analysis; }
    const a = { ok: true, mode: 'other', D: { points: {} }, R: { points: {} }, Dp: {}, Rp: {}, al: alOther, report: { items: outRep.items, flagged: outRep.flagged, close: [], warnings: [], notes: outRep.notes }, outline: outRep, grid: null };
    const outRows = buildOutlineRows(outRep, a);
    outRows.forEach((r, i) => { r.n = i + 1; });
    a.sections = { all: outRows, outline: outRows };
    a.view = { rows: outRows, close: [], bySec: { outline: outRows } };
    S.analysis = a;
    return a;
  }
  const rowById = (id) => (S.analysis && S.analysis.ok && S.analysis.view.rows.find((r) => r.id === id)) || null;
  const selRow = () => rowById(S.hover || S.sel);

  // ------------------------------------------------------------------------------------------------------------ placement
  const sizeOfSlot = (slot) => entryFor(A.layers[slot]).size;
  function refPane() { return overlay() ? A.panes.drawing : A.panes.reference; }

  /** Where the reference should sit so the face fills the visible part of the canvas. */
  function faceFit() {
    const a = S.analysis, Lr = A.layers.reference, pane = refPane();
    if (!a || !a.ok || !pane.width || !pane.height) return null;
    const sz = sizeOfSlot('reference');
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, hasPts = false;
    for (const p of Object.values(a.Rp || {})) if (p && Number.isFinite(p.x)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); hasPts = true; }
    if (!hasPts) return null;
    const ec = (a.al && a.al.unit && a.al.unit.ecReference) || Math.max(20, Math.hypot(x1 - x0, y1 - y0) * 0.25);
    const pr = a.mode === 'pairs' || a.mode === 'half' || a.mode === 'full' || a.mode === 'hand';
    const padX = (pr ? 0.16 : 0.18) * ec, padT = pr ? 0.14 * ec : a.Rp.hairline ? 0.1 * ec : 0.55 * ec, padB = (pr ? 0.16 : 0.18) * ec;
    x0 -= padX; x1 += padX; y0 -= padT; y1 += padB;
    const inset = bottomInset();
    const W = pane.width, H = Math.max(80, pane.height - inset);
    const scale = clamp(Math.min(W / (x1 - x0), H / (y1 - y0)), 0.02, 64);
    const c = { x: (x0 + x1) / 2 - sz.w / 2, y: (y0 + y1) / 2 - sz.h / 2 }, ca = Math.cos(Lr.angle), sa = Math.sin(Lr.angle);
    return { x: -scale * (c.x * ca - c.y * sa), y: -scale * (c.x * sa + c.y * ca) - inset / 2, scale, angle: Lr.angle };
  }
  /** The drawing's placement for a reference placement, from the engine's alignment. */
  function drawingTarget(RP) {
    const a = S.analysis, al = a.al, ds = sizeOfSlot('drawing'), rs = sizeOfSlot('reference');
    const q = P.apply(al, { x: ds.w / 2, y: ds.h / 2 });
    const c0 = { x: q.x - rs.w / 2, y: q.y - rs.h / 2 }, ca = Math.cos(RP.angle), sa = Math.sin(RP.angle);
    return { x: RP.x + RP.scale * (c0.x * ca - c0.y * sa), y: RP.y + RP.scale * (c0.x * sa + c0.y * ca), scale: RP.scale * al.scale, angle: RP.angle + al.rotation };
  }
  /** Put the drawing where the alignment says (and optionally zoom both onto the face). Returns true when something moved. */
  function place({ zoom = false, animate = true } = {}) {
    const a = S.analysis;
    if (!a || !a.ok) return false;
    const Ld = A.layers.drawing, Lr = A.layers.reference;
    A.render(); // placements and frames are current
    let RP = A.placement(Lr);
    if (zoom) RP = faceFit() || RP;
    const DT = drawingTarget(RP), before = A.placement(Ld);
    const moved = Math.abs(DT.x - before.x) > 0.4 || Math.abs(DT.y - before.y) > 0.4 || Math.abs(DT.scale / before.scale - 1) > 0.0008 || Math.abs(DT.angle - before.angle) > 0.0006
      || (zoom && (Math.abs(RP.x - Lr.x) > 0.4 || Math.abs(RP.y - Lr.y) > 0.4 || Math.abs(RP.scale / Lr.scale - 1) > 0.0008));
    Ld.moved = true; Lr.moved = true; Ld.aligned = true; Ld.alignSource = 'auto'; Ld.tuned = false;
    const pairs = [[Ld, DT]];
    if (A.prevLayer.hasImage) pairs.push([A.prevLayer, A.carried(A.prevLayer, before, DT)]);
    if (zoom) pairs.push([Lr, RP]);
    if (animate && moved) A.animatePlacements(pairs);
    else { A.animatePlacements([]); for (const [l, t] of pairs) Object.assign(l, t); A.requestRender(); }
    return moved;
  }
  /** Keep the view (not the alignment) on the face, e.g. after the sheet changed height. */
  function refit(animate = true) {
    const RP = faceFit();
    if (!RP) return;
    const Lr = A.layers.reference, Ld = A.layers.drawing, from = A.placement(Lr), pairs = [[Lr, RP]];
    const k = RP.scale / from.scale, dA = RP.angle - from.angle, c = Math.cos(dA), s = Math.sin(dA);
    for (const l of A.prevLayer.hasImage ? [Ld, A.prevLayer] : [Ld]) {
      const dx = l.x - from.x, dy = l.y - from.y;
      pairs.push([l, { x: RP.x + k * (dx * c - dy * s), y: RP.y + k * (dx * s + dy * c), scale: l.scale * k, angle: l.angle + dA }]);
    }
    A.animatePlacements(animate ? pairs : []);
    if (!animate) for (const [l, t] of pairs) Object.assign(l, t);
    A.requestRender();
  }
  /** Phones: how much of the canvas the bottom sheet covers. */
  function bottomInset() {
    if (!S.open || !PHONE.matches || !els.root || els.root.hidden) return 0;
    const pr = A.panes.drawing.el.getBoundingClientRect(), sr = els.root.getBoundingClientRect();
    return Math.max(0, Math.round(pr.bottom - sr.top));
  }
  const sheetHeight = () => (S.open && PHONE.matches && els.root && !els.root.hidden ? els.root.offsetHeight : 0);

  // ------------------------------------------------------------------------------------------------------------ history
  function commit(S0, key, params, propOnly) {
    S0.label = { k: key, p: params || null };
    S0.propOnly = !!propOnly;
    A.recordUndo(S0);
  }
  const labelText = (lab) => (lab && lab.k ? tk(lab.k, lab.p || undefined) : '');

  // ------------------------------------------------------------------------------------------------------------ open / close
  function bothLoaded() { return SLOTS.every((s) => A.layers[s].hasImage); }

  function applyLayoutRules() {
    if (!S.open) return;
    if (PHONE.matches && A.state.layout !== 'overlay') {
      if (S.saved && S.saved.layout === undefined) S.saved.layout = A.state.layout;
      A.setLayout('overlay');
      return;
    }
    if (A.state.layout === 'overlay' && !S.blend) {
      S.blend = true;
      S.saved = Object.assign(S.saved || {}, { compareMode: A.state.compareMode, opacity: A.state.opacity, overlayTop: A.state.overlayTop });
      A.state.compareMode = 'blend'; A.state.overlayTop = 'reference'; A.state.opacity = 0.4;
      A.syncUI(); A.requestRender();
    } else if (A.state.layout !== 'overlay' && S.blend) restoreCompare();
  }
  function restoreCompare() {
    if (!S.blend) return;
    S.blend = false;
    const o = S.saved || {};
    if (o.compareMode) A.state.compareMode = o.compareMode;
    if (Number.isFinite(o.opacity)) A.state.opacity = o.opacity;
    if (o.overlayTop) A.state.overlayTop = o.overlayTop;
    A.syncUI(); A.requestRender();
  }

  async function open() {
    if (S.open) return;
    if (!bothLoaded()) { A.toast(tk('toast.needs')); return; }
    if (A.state.dotFlow) { A.cancelFlow(true); }
    A.cancelMatch(); A.closeStrip(); A.setMoreOpen(false);
    SLOTS.forEach((s) => A.setTrayOpen(s, false));
    S.open = true; S.sel = null; S.hover = null; S.edit = false; S.expanded = false; S.placing = null; S.saved = {}; S.blend = false; S.loading = true;
    S.seen.add(pairKey());
    document.body.classList.add('prop-open');
    els.root.hidden = false;
    if (PHONE.matches) setSheet('half', false);
    applyLayoutRules();
    A.syncUI();
    renderPanel();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!S.open) return;
    await analyseAndPlace({ label: 'undo.open.auto' });
  }

  async function detectPose(slot, force) {
    const L = A.layers[slot], e = entryFor(L);
    if (!e || !LM.pose) return null;
    if (e.pose !== undefined && !force) return e.pose;
    S.pending++;
    try {
      const res = await LM.pose(orientedCanvas(L));
      e.pose = res.poses && res.poses[0] ? res.poses[0] : null;
      e.poseCount = res.poses ? res.poses.length : 0;
    } catch (_) { e.pose = null; e.poseCount = 0; }
    finally { S.pending--; }
    return e.pose;
  }
  async function detectHand(slot, force) {
    const L = A.layers[slot], e = entryFor(L);
    if (!e || !LM.hands) return null;
    if (e.hand !== undefined && !force) return e.hand;
    S.pending++;
    try {
      const res = await LM.hands(orientedCanvas(L));
      e.hands = res.hands || [];
      e.hand = e.hands[0] || null;
    } catch (_) { e.hands = []; e.hand = null; }
    finally { S.pending--; }
    return e.hand;
  }
  async function ensureOutlineInputs(mode) {
    const O = DC.Outline; if (!O) return;
    const dL = A.layers.drawing, rL = A.layers.reference, dE = entryFor(dL), rE = entryFor(rL);
    if (!dE || !rE) return;
    if (!dE.lines) {
      try { dE.gray = O.grayFromImage(orientedCanvas(dL), 512); dE.lines = O.lineMap(dE.gray); } catch (_) { /* ignore */ }
    }
    const wantSeg = (mode === 'face' || mode === 'half' || mode === 'full') && LM.segment;
    if (wantSeg && rE.segment === undefined) {
      try { const seg = await LM.segment(orientedCanvas(rL), { maxSide: 512 }); rE.segment = seg && seg.mask ? seg : null; } catch (_) { rE.segment = null; }
    }
    if (!rE.segment && !rE.gray) {
      try { rE.gray = O.grayFromImage(orientedCanvas(rL), 512); } catch (_) { /* ignore */ }
    }
  }
  function modeSideOf(slot) {
    const L = A.layers[slot], e = entryFor(L), p = L.prop;
    const f0 = e && e.faces && e.faces[0];
    const pose = p && p.bodyManual && Object.keys(p.bodyManual).length >= 3 ? { named: p.bodyManual } : e ? e.pose : undefined;
    const hand = p && p.handManual && Object.keys(p.handManual).length >= 3 ? { box: { x: 0, y: 0, w: e.size.w, h: e.size.h } } : e ? e.hand : undefined;
    return { size: e ? e.size : { w: 1, h: 1 }, face: f0 ? { box: f0.box } : (e && e.faces ? null : undefined), pose, hand };
  }
  function runModeChoice() {
    if (!DC.ProportionsMode) return { mode: 'face', auto: true, decided: true, need: null, offer: null, sections: [{ key: 'face', available: true }], notes: [] };
    const ov = modeOverride();
    return DC.ProportionsMode.choose({ drawing: modeSideOf('drawing'), reference: modeSideOf('reference') }, { override: ov === 'auto' ? null : ov });
  }
  async function tryAutoDrawing(kind) {
    S.loading = true; renderPanel();
    const key = pairKey();
    if (kind === 'pose') await detectPose('drawing', true);
    else if (kind === 'hand') await detectHand('drawing', true);
    if (!S.open || key !== pairKey()) return;
    S.loading = false;
    const found = kind === 'pose' ? !!entryFor(A.layers.drawing).pose : !!entryFor(A.layers.drawing).hand;
    if (!found) A.toast(tk(kind === 'pose' ? 'body.no_draw' : 'hand.no_draw'));
    S.modeRes = runModeChoice();
    const a = recompute();
    if (a && a.ok) { const S0 = A.snapshotViews(); const moved = place({ zoom: true, animate: true }); if (moved) commit(S0, 'undo.open.auto'); }
    renderPanel(); A.requestRender(); A.syncUI();
  }

  /** Detect (cached) in both images, choose mode (cheapest first), analyse, and place the drawing; the placement is one Undo step. */
  async function analyseAndPlace({ label } = {}) {
    S.loading = true;
    renderPanel();
    const key = pairKey();
    const ov = modeOverride();
    if (!isPairsMode() && (ov === 'auto' || ov === 'face')) {
      await Promise.all([detectLayer(A.layers.drawing), detectLayer(A.layers.reference)]);
    }
    if (!S.open || key !== pairKey()) return;
    let res = runModeChoice();
    while (res.need && S.open && key === pairKey()) {
      if (res.need.task === 'pose') await detectPose(res.need.side);
      else if (res.need.task === 'hand') await detectHand(res.need.side);
      else break;
      res = runModeChoice();
    }
    if (!S.open || key !== pairKey()) return;
    S.modeRes = res;
    await ensureOutlineInputs(activeMode());
    if (!S.open || key !== pairKey()) return;
    S.loading = false;
    S.facesBoth = hasFace('drawing') && hasFace('reference');
    const a = recompute();
    renderPanel();
    if (a && a.ok && activeMode() === 'face') checkMirror();
    if (a && a.ok) {
      const S0 = A.snapshotViews();
      const moved = place({ zoom: true, animate: true });
      const lab = label === 'undo.repin' ? label : a.mode === 'pairs' ? 'undo.pair.fit' : st().pin === 'auto' ? 'undo.open.auto' : 'undo.pin.' + st().pin;
      if (moved) commit(S0, lab);
      announceOpen();
    }
    sync();
    A.syncUI();
  }

  function close({ keepMode = false, quiet = false } = {}) {
    if (!S.open) return;
    S.open = false; S.edit = false; S.placing = null; S.sel = null; S.hover = null; S.drag = null; S.frozen = false; S.loading = false;
    document.body.classList.remove('prop-open');
    els.root.hidden = true;
    els.coach.hidden = true; els.strip.hidden = true;
    if (window.DrawingCompare.tips) DC.tips.hide();
    els.loupe.hidden = true;
    // point edits are discarded from the Undo list (not from the photo); alignment steps stay
    A.dropSteps((s) => s.propOnly);
    if (!keepMode) {
      restoreCompare();
      if (S.saved && S.saved.layout && A.state.layout !== S.saved.layout) A.setLayout(S.saved.layout);
    } else S.blend = false;
    S.saved = null;
    for (const s of SLOTS) clearCanvas(s);
    clearProxies();
    A.syncUI(); A.requestRender();
    A.syncAlignBar();
    if (!quiet && els.btn && document.activeElement === document.body) els.btn.focus({ preventScroll: true });
  }
  function toggle() { if (S.open) close(); else open(); }
  function escape() {
    if (S.placing) { cancelPlacing(); return true; }
    if (S.edit) { setEdit(false); return true; }
    if (S.open) { close(); return true; }
    return false;
  }

  // ------------------------------------------------------------------------------------------------------------ actions (each one an Undo step)
  function changeAlignment(mutate, label, params) {
    const S0 = A.snapshotViews();
    mutate();
    const a = recompute();
    if (a && a.ok) place({ zoom: false, animate: true });
    commit(S0, label, params, false);
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function setMode(v) {
    const S0 = A.snapshotViews(), dp = propOf(A.layers.drawing);
    dp.modeOverride = v; dp.modeKey = pairKey();
    S.tab = 'all'; S.sel = null; S.hover = null;
    commit(S0, 'undo.mode.' + v, null, false);
    analyseAndPlace({ label: 'undo.mode.' + v });
  }
  function setHandSide(v) {
    st().handSide = v; A.scheduleSave();
    recompute(); renderPanel(); A.requestRender();
  }
  function setPin(v) {
    const m = activeMode();
    changeAlignment(() => {
      if (m === 'half' || m === 'full') st().pinBody = v;
      else if (m === 'hand') st().pinHand = v;
      else st().pin = v;
      if (v !== 'custom') delete propOf(A.layers.drawing).customPin;
    }, 'undo.pin.' + v);
  }
  function setSize(v) {
    const m = activeMode();
    changeAlignment(() => {
      if (m === 'half' || m === 'full') st().sizeBody = v;
      else if (m === 'hand') st().sizeHand = v;
      else st().size = v;
      if (v !== 'custom') delete propOf(A.layers.drawing).customSize;
      else if (!propOf(A.layers.drawing).customSize && m === 'face') { const D = featuresOf('drawing'), R = featuresOf('reference'); if (D && R) propOf(A.layers.drawing).customSize = customSizeOf(D, R); }
    }, 'undo.size.' + v);
  }
  function setTilt(on) { changeAlignment(() => { st().matchTilt = !!on; }, on ? 'undo.tilt.on' : 'undo.tilt.off'); }
  function setStyle(v) { st().style = v; A.scheduleSave(); recompute(); renderPanel(); A.requestRender(); }
  function setTolerance(v) { st().tolerance = v; A.scheduleSave(); recompute(); renderPanel(); A.requestRender(); }
  function toggleShow(k) {
    if (k === 'points') st().points = !showPoints(); else st()[k] = !st()[k];
    if (k === 'grid') recompute();
    A.scheduleSave(); renderPanel(); A.requestRender();
  }
  async function resetPoints() {
    const S0 = A.snapshotViews();
    for (const s of SLOTS) { const p = propOf(A.layers[s]); delete p.edits; delete p.manual; delete p.bodyManual; delete p.bodyEdits; delete p.handManual; delete p.handEdits; }
    delete propOf(A.layers.drawing).customPin; delete propOf(A.layers.drawing).customSize;
    delete propOf(A.layers.drawing).pairs; delete propOf(A.layers.drawing).pairsKey;
    delete propOf(A.layers.reference).outlineSeed;
    S.choose = false;
    if (st().pin === 'custom') st().pin = 'auto';
    if (st().size === 'custom') st().size = 'auto';
    S.analysis = null; renderPanel();
    await Promise.all([detectLayer(A.layers.drawing, true), detectLayer(A.layers.reference, true)]);
    if (!S.open) return;
    const a = recompute();
    if (a && a.ok) place({ zoom: false, animate: true });
    commit(S0, 'undo.reset', null, false);
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function setEdit(on) {
    S.edit = !!on;
    els.strip.hidden = !(S.open && S.edit);
    renderPanel(); A.requestRender();
  }
  const canRepin = () => !!(S.open && S.analysis && S.analysis.ok);
  function repin(snapshot) { // Fit all / Auto align while the check is open: pin again instead of best-fitting
    if (!canRepin()) return false;
    const S0 = snapshot || A.snapshotViews();
    recompute();
    const moved = place({ zoom: true, animate: true });
    if (moved || snapshot) commit(S0, 'undo.repin');
    renderPanel();
    return true;
  }
  /** The images or their orientation changed: forget the old analysis; look again (open) or later in the background. */
  function imagesChanged() {
    S.analysis = null; S.facesBoth = false; S.sel = null; S.hover = null; S.choose = false;
    const dp = A.layers.drawing.prop;
    if (dp && dp.pairs && bothLoaded() && dp.pairsKey && dp.pairsKey !== pairKey()) { delete dp.pairs; delete dp.pairsKey; } // matching points belong to the pair of photos they were marked on
    if (S.placing) cancelPlacing();
    if (S.open) {
      if (!bothLoaded()) { close(); return; }
      clearTimeout(S.imgTimer);
      S.imgTimer = setTimeout(() => { if (S.open) analyseAndPlace({ label: 'undo.repin' }); }, 120);
    } else scheduleBackground();
    sync();
  }
  function afterRestore() { // Undo / Redo restored layer views and settings: look again, without moving anything
    if (!S.open) { sync(); return; }
    const a = recompute(); renderPanel(); if (a && a.ok) checkMirror(); if (S.placing) renderCoach(); A.requestRender();
  }

  // ------------------------------------------------------------------------------------------------------------ the entry button
  function sync() {
    const btn = els.btn;
    if (!A || !btn || !els.root) return;
    const both = bothLoaded();
    btn.disabled = !both;
    btn.setAttribute('aria-pressed', String(S.open));
    btn.classList.toggle('has-faces', both && S.facesBoth && !S.open && !S.seen.has(pairKey()));
    btn.dataset.tip = tk('tip');
    btn.dataset.tipOff = tk('tip.off');
    if (S.open) {
      if (!both) { close(); return; }
      applyLayoutRules();
      els.root.dataset.sheet = S.sheet;
    }
  }

  // ------------------------------------------------------------------------------------------------------------ panel
  const POINT_LIST_CAP = 8;
  function buildPanel() {
    const root = h('aside', { id: 'prop-report', class: 'prop-report', 'aria-label': tk('title'), hidden: true, role: 'region' });
    els.root = root;
    els.live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    els.grab = h('button', { type: 'button', class: 'prop-grab', 'aria-label': tk('sheet') }, h('i'));
    els.help = h('button', { type: 'button', class: 'btn small icon prop-help', 'aria-expanded': 'false', 'data-tip': tk('help'), onclick: () => { S.explain = !S.explain; renderPanel(); } }, icon('i-help'), h('span', { class: 'sr-only', text: tk('help') }));
    els.closeBtn = h('button', { type: 'button', class: 'btn small icon prop-x', 'data-tip': tk('close'), 'data-key': 'K', onclick: () => close() }, icon('i-close'), h('span', { class: 'sr-only', text: tk('close') }));
    els.title = h('h2', { class: 'prop-title', text: tk('title') });
    els.intro = h('p', { class: 'prop-intro', text: tk('intro') });
    els.explain = buildExplainer();
    // pickers
    const sel = (id, labelKey, opts, onchange, tipKey) => {
      const select = h('select', { id, 'aria-label': tk(labelKey), onchange: (e) => onchange(e.target.value) });
      const val = h('span', { class: 'prop-chip-val' });
      const lab = h('span', { class: 'prop-chip-lab', text: tk(labelKey === 'pin.label' ? 'chip.pin' : labelKey === 'size.label' ? 'chip.size' : labelKey, { value: '' }).replace(/\s+$/, '') });
      const chip = h('label', { class: 'prop-chip prop-picker', 'data-tip': tk(tipKey) }, lab, val, h('i', { class: 'prop-caret', 'aria-hidden': 'true' }), select);
      return { select, val, chip, opts, lab };
    };
    els.mode = sel('prop-mode', 'mode.label', ['auto', 'face', 'half', 'full', 'hand', 'other'], setMode, 'mode.tip');
    for (const o of els.mode.opts) els.mode.select.append(h('option', { value: o, text: tk('mode.' + o) }));
    els.mode.lab.textContent = tk('mode.label') + ':';
    els.pin = sel('prop-pin', 'pin.label', ['auto', 'eyes', 'nose', 'chin', 'mouth', 'custom'], setPin, 'pin.tip');
    els.size = sel('prop-size', 'size.label', ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'], setSize, 'size.tip');
    for (const c of [els.pin, els.size]) {
      const key = c === els.pin ? 'pin.' : 'size.';
      for (const o of c.opts) c.select.append(h('option', { value: o, text: tk(key + o) }));
      c.lab.textContent = tk(c === els.pin ? 'chip.pin' : 'chip.size', { value: '' }).trim();
    }
    els.handSide = sel('prop-hand-side', 'hand.side.label', ['right', 'left'], setHandSide, 'hand.side.label');
    for (const o of els.handSide.opts) els.handSide.select.append(h('option', { value: o, text: tk('hand.side.' + o) }));
    els.handSide.lab.textContent = tk('hand.side.label') + ':';
    els.modeRow = h('div', { class: 'prop-pick prop-pick-mode' }, h('span', { class: 'prop-pick-lab', text: tk('mode.label') }), els.mode.chip);
    els.pinRow = h('div', { class: 'prop-pick' }, h('span', { class: 'prop-pick-lab', text: tk('pin.label') }), els.pin.chip);
    els.sizeRow = h('div', { class: 'prop-pick' }, h('span', { class: 'prop-pick-lab', text: tk('size.label') }), els.size.chip);
    els.handSideRow = h('div', { class: 'prop-pick prop-hand-side', hidden: true }, h('span', { class: 'prop-pick-lab', text: tk('hand.side.label') }), els.handSide.chip);
    els.pickers = h('div', { class: 'prop-pickers' }, els.modeRow, els.pinRow, els.sizeRow, els.handSideRow);
    els.lock = h('p', { class: 'prop-note prop-lock', hidden: true });
    els.status = h('div', { class: 'prop-status' });
    // result
    els.count = h('div', { class: 'prop-count' });
    els.tabs = h('div', { class: 'prop-tabs', role: 'tablist', hidden: true });
    els.list = h('ul', { class: 'prop-list', 'aria-label': tk('list.label') });
    els.more = h('button', { type: 'button', class: 'btn small quiet prop-more', onclick: () => { S.expanded = !S.expanded; renderPanel(); } });
    els.headsRow = h('p', { class: 'prop-heads-row', hidden: true });
    els.headsRow.addEventListener('pointerenter', () => { S.hoverHeads = true; A.requestRender(); });
    els.headsRow.addEventListener('pointerleave', () => { S.hoverHeads = false; A.requestRender(); });
    els.fingerChart = h('div', { class: 'prop-finger-chart', hidden: true });
    els.outlineLegend = h('div', { class: 'prop-outline-legend', hidden: true },
      h('div', { class: 'prop-outline-swatches' },
        h('span', { class: 'prop-outline-sw out' }, h('i'), tk('outline.legend.out')),
        h('span', { class: 'prop-outline-sw in' }, h('i'), tk('outline.legend.in'))),
      h('p', { class: 'prop-note', text: tk('outline.legend.note') }));
    els.closeEnough = h('p', { class: 'prop-close-enough' });
    els.none = h('p', { class: 'prop-none' });
    els.result = h('div', { class: 'prop-result' }, els.count, els.tabs, els.list, els.more, els.headsRow, els.fingerChart, els.outlineLegend, els.none, els.closeEnough);
    // show
    const chip = (k, tkKey = k) => h('button', { type: 'button', class: 'btn small prop-toggle', 'aria-pressed': 'false', 'data-tip': tk(tkKey + '.tip'), 'data-key': k === 'grid' ? 'Shift+G' : null, onclick: () => toggleShow(k) }, h('span', { text: tk(tkKey) }));
    els.tArrows = chip('arrows'); els.tPoints = chip('points'); els.tSkeleton = chip('skeleton'); els.tKnuckles = chip('knuckles'); els.tOutline = chip('outlineBand', 'outline_band'); els.tGrid = chip('grid');
    els.legend = h('p', { class: 'prop-legend', hidden: true }, h('span', { class: 'sw warm' }), tk('stretched'), h('span', { class: 'sw cool' }), tk('squashed'));
    els.show = h('div', { class: 'prop-show' }, h('span', { class: 'prop-lab', text: tk('show') }), h('div', { class: 'prop-chips' }, els.tArrows, els.tPoints, els.tSkeleton, els.tKnuckles, els.tOutline, els.tGrid), els.legend);
    // tolerance
    els.tol = h('fieldset', { class: 'segmented small prop-tol' }, h('legend', { class: 'sr-only', text: tk('tol.label') }));
    for (const k of ['strict', 'usual', 'relaxed']) {
      const input = h('input', { type: 'radio', name: 'prop-tol', id: 'prop-tol-' + k, value: k, onchange: () => setTolerance(k) });
      els.tol.append(input, h('label', { for: 'prop-tol-' + k, 'data-tip': tk('tol.tip'), text: tk('tol.' + k) }));
    }
    els.tolWrap = h('div', { class: 'prop-tolwrap' }, h('span', { class: 'prop-lab', text: tk('tol.label') }), els.tol);
    // drawing style (auto from how closely the faces fit; manual override)
    els.style = h('fieldset', { class: 'segmented small prop-tol prop-style' }, h('legend', { class: 'sr-only', text: tk('style.label') }));
    for (const k of ['auto', 'realistic', 'stylised']) {
      const input = h('input', { type: 'radio', name: 'prop-style', id: 'prop-style-' + k, value: k, onchange: () => setStyle(k) });
      els.style.append(input, h('label', { for: 'prop-style-' + k, 'data-tip': tk('style.tip'), text: tk('style.' + k) }));
    }
    els.styleWrap = h('div', { class: 'prop-tolwrap' }, h('span', { class: 'prop-lab', text: tk('style.label') }), els.style);
    els.styleNote = h('p', { class: 'prop-note prop-stylenote', hidden: true });
    els.unf = h('p', { class: 'prop-note prop-unfinished', hidden: true });
    els.mirror = h('div', { class: 'prop-card prop-mirror', role: 'group', hidden: true }, h('strong', { text: tk('mirror.ask') }),
      h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => flipDrawing(), text: tk('mirror.flip') }),
        h('button', { type: 'button', class: 'btn small', onclick: () => dismissMirror(), text: tk('mirror.dismiss') })));
    // actions
    els.bEdit = h('button', { type: 'button', class: 'btn small prop-edit', 'aria-pressed': 'false', 'data-tip': tk('edit.tip'), onclick: () => setEdit(!S.edit), text: tk('edit') });
    els.bReset = h('button', { type: 'button', class: 'btn small', 'data-tip': tk('reset.tip'), onclick: () => resetPoints(), text: tk('reset') });
    els.cTilt = h('input', { type: 'checkbox', id: 'prop-tilt', onchange: (e) => setTilt(e.target.checked) });
    els.tilt = h('label', { class: 'prop-check', for: 'prop-tilt', 'data-tip': tk('tilt.tip') }, els.cTilt, h('span', { text: tk('tilt') }));
    els.actions = h('div', { class: 'prop-actions' }, h('div', { class: 'prop-btns' }, els.bEdit, els.bReset), els.tilt);
    els.pose = h('p', { class: 'prop-pose' });
    els.largest = h('p', { class: 'prop-note', text: tk('largest'), hidden: true });
    els.proxies = h('div', { class: 'prop-proxies', role: 'group', 'aria-label': tk('points.group') });
    els.foot = h('p', { class: 'prop-foot', text: tk('footnote') });
    els.tools = h('div', { class: 'prop-tools' }, els.show, els.tolWrap, els.styleWrap, els.actions);
    els.scroll = h('div', { class: 'prop-scroll' }, els.intro, els.explain, els.pickers, els.lock, els.status, els.mirror, els.unf, els.result, els.proxies, els.tools, els.pose, els.styleNote, els.largest, els.foot);
    root.append(h('i', { class: 'prop-tape', 'aria-hidden': 'true' }), els.grab, h('header', { class: 'prop-head' }, els.title, h('span', { class: 'prop-head-btns' }, els.help, els.closeBtn)), els.scroll, els.live);
    // phone sheet: three heights
    els.grab.addEventListener('click', () => { if (!S.dragSheet) setSheet(S.sheet === 'half' ? 'full' : S.sheet === 'full' ? 'peek' : 'half'); });
    let g = null;
    els.grab.addEventListener('pointerdown', (e) => { g = { y: e.clientY, id: e.pointerId, moved: false }; S.dragSheet = false; try { els.grab.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ } });
    els.grab.addEventListener('pointermove', (e) => { if (g && g.id === e.pointerId && Math.abs(e.clientY - g.y) > 8) g.moved = true; });
    const up = (e) => {
      if (!g || g.id !== e.pointerId) return;
      const dy = e.clientY - g.y;
      if (g.moved) { S.dragSheet = true; setTimeout(() => { S.dragSheet = false; }, 50); const order = ['peek', 'half', 'full'], i = order.indexOf(S.sheet); setSheet(order[clamp(i + (dy < 0 ? 1 : -1), 0, 2)]); if (dy > 90 && S.sheet === 'peek' && i === 0) close(); }
      g = null;
    };
    els.grab.addEventListener('pointerup', up); els.grab.addEventListener('pointercancel', () => { g = null; });
    // keyboard: Up / Down move through the list
    els.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const rows = [...els.list.querySelectorAll('.prop-row')], i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault(); e.stopPropagation();
      const next = rows[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)];
      if (next) next.focus();
    });
    A.workspace.appendChild(root);
    // the manual coach and the edit strip
    els.coach = h('div', { class: 'dot-coach prop-coach', role: 'region', 'aria-label': tk('coach.title'), hidden: true },
      h('div', { class: 'coach-head' }, h('strong', { class: 'coach-step' }), h('span', { class: 'coach-btns' },
        h('button', { type: 'button', class: 'btn small', 'data-coach': 'back', onclick: () => placingBack() }, icon('i-chev-left'), h('span', { class: 'lbl', text: tk('coach.back') })),
        h('button', { type: 'button', class: 'btn small', 'data-coach': 'skip', hidden: true, onclick: () => placingSkip() }, h('span', { text: tk('coach.skip') })),
        h('button', { type: 'button', class: 'btn small primary', 'data-coach': 'done', hidden: true, onclick: () => finishPlacing() }, h('span', { text: tk('coach.done_early') })),
        h('button', { type: 'button', class: 'btn small', 'data-coach': 'cancel', onclick: () => cancelPlacing() }, h('span', { text: tk('coach.cancel') })))),
      h('div', { class: 'coach-main' }, h('div', { class: 'coach-say' }, h('p', { class: 'coach-text' }))));
    els.bMatch = h('button', { type: 'button', class: 'btn small', onclick: () => { setEdit(false); startPairs(); }, text: tk('edit.matching') });
    els.strip = h('div', { class: 'dot-coach prop-strip', role: 'status', hidden: true }, h('div', { class: 'coach-main' }, h('p', { class: 'coach-text', text: tk('edit.strip') }), els.bMatch, h('button', { type: 'button', class: 'btn small primary', onclick: () => setEdit(false), text: tk('edit.done') })));
    A.workspace.append(els.coach, els.strip);
    els.loupe = h('canvas', { class: 'dot-loupe', width: 224, height: 224, hidden: true, 'aria-hidden': 'true' });
    document.body.appendChild(els.loupe);
    els.bubble = h('span', { class: 'prop-bubble-anchor', 'aria-hidden': 'true' });
    document.body.appendChild(els.bubble);
  }
  /** The "?" explainer: a small hand-drawn picture (pin, size-by line, an arrow from a drawing spot to the reference spot, matching spots) with whole-sentence captions. */
  function buildExplainer() {
    const box = h('div', { class: 'prop-explain', hidden: true });
    const INKC = 'var(--prop-drawing)', REF = 'var(--prop-ref)', MAJ = 'var(--prop-major)', PAPERC = 'var(--prop-halo)';
    const tag = (x, y, n) => `<g><circle cx="${x}" cy="${y}" r="8" fill="${PAPERC}" stroke="${INKC}" stroke-width="1.4"/><text x="${x}" y="${y + 3.4}" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="10" fill="${INKC}">${n}</text></g>`;
    const arrowHead = (x, y, dir, col) => `<path d="M${x - 4.2} ${y + 6.5 * dir} L${x} ${y} L${x + 4.2} ${y + 6.5 * dir}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const svg = `<svg viewBox="36 14 196 152" role="img" aria-label="${tk('explain.alt').replace(/"/g, '&quot;')}" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M94 22 C132 20 146 66 141 102 C138 134 118 152 94 152 C72 152 52 134 49 102 C44 66 56 24 94 22 Z" stroke="${REF}" stroke-width="1.7" stroke-dasharray="5 3.5"/>
        <path d="M94 26 C130 23 144 68 139 106 C136 138 116 157 94 157 C72 157 54 138 51 106 C46 68 60 27 94 26 Z" stroke="${INKC}" stroke-width="1.9"/>
        <path d="M95 25 C129 24 143 67 138 104" stroke="${INKC}" stroke-width=".8" opacity=".45"/>
        <circle cx="74" cy="62" r="3.6" stroke="${REF}" stroke-width="1.6"/><circle cx="114" cy="62" r="3.6" stroke="${REF}" stroke-width="1.6"/>
        <circle cx="94" cy="84" r="3.6" stroke="${REF}" stroke-width="1.6"/><circle cx="94" cy="112" r="3.6" stroke="${REF}" stroke-width="1.6"/>
      </g>
      <g fill="${INKC}"><circle cx="74" cy="62" r="2.5"/><circle cx="114" cy="62" r="2.5"/><circle cx="94" cy="103" r="2.5"/><circle cx="94" cy="131" r="2.5"/></g>
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M94 98 L94 90" stroke="${MAJ}" stroke-width="2.3"/>${arrowHead(94, 88.5, 1, MAJ)}
        <path d="M94 126 L94 118" stroke="${REF}" stroke-width="1.8"/>${arrowHead(94, 116.5, 1, REF)}
      </g>
      <g><circle cx="94" cy="62" r="11" fill="none" stroke="${MAJ}" stroke-width="1.5" stroke-dasharray="3.2 3"/>
        <path d="M94 47 L94 52 M94 72 L94 77 M79 62 L84 62 M104 62 L109 62" stroke="${MAJ}" stroke-width="1.5" stroke-linecap="round"/><circle cx="94" cy="62" r="3.3" fill="${MAJ}"/></g>
      <g fill="none" stroke="${REF}" stroke-linecap="round" stroke-linejoin="round">
        <path d="M118 62 L196 62 M98 157 L196 157" stroke-width="1" stroke-dasharray="2 3"/>
        <path d="M196 70 L196 149" stroke-width="1.5"/>${arrowHead(196, 66, 1, REF).replace(/stroke-width="2"/, 'stroke-width="1.5"')}${arrowHead(196, 153, -1, REF).replace(/stroke-width="2"/, 'stroke-width="1.5"')}
        <rect x="191.5" y="57.5" width="9" height="9" fill="${PAPERC}" stroke-width="1.5"/><rect x="191.5" y="152.5" width="9" height="9" fill="${PAPERC}" stroke-width="1.5"/>
      </g>
      ${tag(94, 38, 1)}${tag(216, 110, 2)}${tag(118, 100, 3)}${tag(56, 48, 4)}
    </svg>`;    const caps = h('ol', { class: 'prop-explain-list' });
    ['explain.pin', 'explain.size', 'explain.arrow', 'explain.match'].forEach((k, i) => caps.append(h('li', {}, h('i', { class: 'n', 'aria-hidden': 'true', text: String(i + 1) }), h('span', { text: tk(k) }))));
    box.append(h('div', { class: 'prop-explain-art', html: null }), caps, h('p', { class: 'prop-explain-more', text: tk('explain') }));
    box.firstChild.innerHTML = svg;
    return box;
  }
  function icon(id) { const s = document.createElementNS(SVGNS, 'svg'), u = document.createElementNS(SVGNS, 'use'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }
  function setSheet(v, rerender = true) {
    S.sheet = v;
    els.root.dataset.sheet = v;
    els.grab.setAttribute('aria-expanded', String(v !== 'peek'));
    if (rerender) { A.positionAlignBar(); setTimeout(() => { if (S.open) { refit(true); A.positionAlignBar(); } }, 60); }
  }

  function syncModePickers(mode, pairsMode) {
    const s = st(), ov = modeOverride();
    els.mode.select.value = ov;
    els.mode.val.textContent = ov === 'auto' ? tk('mode.auto_fmt', { mode: tk('mode.' + mode) }) : tk('mode.' + mode);
    const setOpts = (selObj, opts, keyFn, cur) => {
      selObj.select.textContent = '';
      for (const o of opts) selObj.select.append(h('option', { value: o, text: tk(keyFn(o)) }));
      const v = opts.includes(cur) ? cur : 'auto';
      selObj.select.value = v;
      selObj.val.textContent = tk(keyFn(v));
      const cOpt = selObj.select.querySelector('option[value="custom"]');
      if (cOpt) cOpt.hidden = v !== 'custom';
    };
    if (mode === 'half' || mode === 'full') {
      const pins = mode === 'full' ? ['auto', 'neck', 'hips', 'foot', 'custom'] : ['auto', 'neck', 'hips', 'custom'];
      const sizes = mode === 'full' ? ['auto', 'head', 'torso', 'shoulders', 'height', 'custom'] : ['auto', 'head', 'torso', 'shoulders', 'custom'];
      setOpts(els.pin, pins, (o) => 'pin.' + o, s.pinBody || 'auto');
      setOpts(els.size, sizes, (o) => (o === 'head' ? 'size.body.head' : 'size.' + o), s.sizeBody || 'auto');
    } else if (mode === 'hand') {
      setOpts(els.pin, ['auto', 'wrist', 'middleKnuckle', 'custom'], (o) => 'pin.' + o, s.pinHand || 'auto');
      setOpts(els.size, ['auto', 'palm', 'hand', 'custom'], (o) => 'size.' + o, s.sizeHand || 'auto');
      els.handSide.select.value = s.handSide || 'right';
      els.handSide.val.textContent = tk('hand.side.' + (s.handSide || 'right'));
    } else {
      const pinVal = s.pin === 'custom' && !propOf(A.layers.drawing).customPin ? 'auto' : s.pin;
      setOpts(els.pin, ['auto', 'eyes', 'nose', 'chin', 'mouth', 'custom'], (o) => 'pin.' + o, pinVal);
      setOpts(els.size, ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'], (o) => 'size.' + o, s.size);
    }
    els.modeRow.hidden = pairsMode;
    els.pinRow.hidden = els.sizeRow.hidden = pairsMode || mode === 'other';
    els.handSideRow.hidden = pairsMode || mode !== 'hand';
  }

  /** Everything dynamic in the panel: pickers, status cards, count, list, toggles. Cheap; called after any change. */
  function renderPanel() {
    if (!els.root) return;
    const s = st(), a = S.analysis, ok = !!(a && a.ok), mode = activeMode(), pairsMode = isPairsMode();
    // pickers
    syncModePickers(mode, pairsMode);
    els.pickers.hidden = pairsMode && !ok && !S.analysis;
    els.pickers.classList.toggle('is-off', !ok && mode !== 'other');
    for (const sel of [els.pin.select, els.size.select]) sel.disabled = !ok;
    els.mode.select.disabled = S.loading;
    els.tPoints.hidden = pairsMode || mode === 'other';
    els.tGrid.hidden = pairsMode || mode !== 'face';
    els.tSkeleton.hidden = pairsMode || (mode !== 'half' && mode !== 'full');
    els.tKnuckles.hidden = pairsMode || mode !== 'hand';
    els.tOutline.hidden = pairsMode;
    els.tilt.hidden = pairsMode || mode === 'other';
    els.tilt.querySelector('span').textContent = tk(mode === 'half' || mode === 'full' ? 'tilt.body' : mode === 'hand' ? 'tilt.hand' : 'tilt');
    els.foot.textContent = tk(pairsMode || mode === 'other' ? 'pairs.foot' : 'footnote');
    els.bMatch.textContent = tk(pairsMode ? 'pairs.add' : 'edit.matching');
    els.bMatch.hidden = pairsMode && pairsOf().length >= PAIRS_MAX;
    // lock note
    const notes = [];
    if (ok && !pairsMode && a.al && a.al.locked) {
      for (const k of a.al.locked) {
        const bySize = (a.al.size && ((a.al.size.used === 'eyeChin' && k === 'chin_length') || (a.al.size.used === 'eyeSpacing' && k === 'eye_spacing') || ['torso', 'shoulders', 'height', 'palm'].includes(a.al.size.used)));
        const key = (bySize ? 'lock.size.' : 'lock.pin.') + (k === 'shoulder_width' ? 'shoulders' : k === 'palm_width' ? 'palm' : k);
        if (i18n.has(key)) notes.push(tk(key));
      }
    }
    els.lock.hidden = !notes.length; els.lock.textContent = notes.join(' ');
    // status area
    renderStatus();
    // result
    els.result.hidden = !ok;
    els.tools.hidden = !ok && !S.analysis && !S.placing ? true : false;
    els.explain.hidden = !S.explain; els.help.setAttribute('aria-expanded', String(S.explain));
    if (ok) renderResult(a);
    els.tArrows.setAttribute('aria-pressed', String(!!s.arrows));
    els.tPoints.setAttribute('aria-pressed', String(showPoints()));
    els.tSkeleton.setAttribute('aria-pressed', String(s.skeleton !== false));
    els.tKnuckles.setAttribute('aria-pressed', String(s.knuckles !== false));
    els.tOutline.setAttribute('aria-pressed', String(s.outlineBand !== false));
    els.tGrid.setAttribute('aria-pressed', String(!!s.grid));
    els.legend.hidden = !s.grid || pairsMode || mode !== 'face';
    for (const input of els.tol.querySelectorAll('input')) input.checked = input.value === s.tolerance;
    for (const input of els.style.querySelectorAll('input')) input.checked = input.value === s.style;
    els.styleWrap.hidden = pairsMode || mode !== 'face';
    els.cTilt.checked = !!s.matchTilt;
    els.bEdit.setAttribute('aria-pressed', String(S.edit));
    els.bEdit.textContent = S.edit ? tk('edit.done') : tk('edit');
    els.strip.hidden = !(S.open && S.edit);
    // pose and detector notes
    els.pose.hidden = !ok || pairsMode || mode !== 'face';
    if (ok && !pairsMode && mode === 'face') {
      const ps = a.report.pose || {}, bad = !!(ps.differs || ps.large);
      els.pose.className = 'prop-pose' + (bad ? ' warn' : '') + (ps.large ? ' big' : '');
      els.pose.textContent = tk(ps.large ? 'pose.far' : ps.differs ? 'pose.differs' : 'pose.same') + (bad && ps.compensated ? ' ' + tk('pose.comp') : '');
      const stl = a.report.style;
      els.styleNote.hidden = !(stl && stl.adaptive && stl.mode === 'auto' && stl.label === 'stylised');
      els.styleNote.textContent = els.styleNote.hidden ? '' : tk('style.note.stylised');
      const miss = (S.unfinished || []).slice(), order = ['nose', 'mouth', 'chin'].filter((k) => miss.includes(k));
      els.unf.hidden = !order.length;
      if (order.length) {
        let list = i18n.list(order.map((k) => tk('region.' + k)));
        if (/^(es|fr)/.test(i18n.language)) list = list.charAt(0).toUpperCase() + list.slice(1);
        els.unf.textContent = tk(order.length > 1 ? 'unfinished.many' : 'unfinished.one', { list });
      }
      els.mirror.hidden = !(S.mirror && S.mirror.key === pairKey());
    } else if (ok && (mode === 'half' || mode === 'full')) {
      els.styleNote.hidden = true; els.unf.hidden = true;
      els.mirror.hidden = !(a.mirrorBody && a.mirrorBody.mirrored);
    } else { els.styleNote.hidden = true; els.unf.hidden = true; els.mirror.hidden = true; }
    const faces = (slot) => { const e = entryFor(A.layers[slot]); return e && e.faces ? e.faces.length : 0; };
    els.largest.hidden = !(ok && !pairsMode && mode === 'face' && (faces('drawing') > 1 || faces('reference') > 1));
    els.root.dataset.state = ok ? 'ok' : S.pending ? 'busy' : S.placing ? 'placing' : 'empty';
    els.root.dataset.sheet = S.sheet;
    renderProxies();
  }

  // ---- mirrored drawing: the left/right asymmetry of the face correlates negatively with the photo's (see P.mirrorScore)
  async function checkMirror() {
    const key = pairKey();
    if (isPairsMode() || isManual('drawing') || isManual('reference') || (S.mirrorDismissed && S.mirrorDismissed.has(key))) { S.mirror = null; return; }
    const dE = entryFor(A.layers.drawing), rE = entryFor(A.layers.reference);
    if (!dE || !rE || !dE.faces || !rE.faces || !dE.faces.length || !rE.faces.length) return;
    const pk = pickPair(), df = dE.faces[pk.d] || dE.faces[0], rf = rE.faces[pk.r] || rE.faces[0];
    if (df.detector !== 'mediapipe' || rf.detector !== 'mediapipe') return;
    const score = P.mirrorScore(df.points, rf.points);
    if (score === null || !(score < P.MIRROR.threshold)) { S.mirror = null; return; }
    try { // confirm: the mirrored drawing must fit the photo's asymmetry clearly better
      const res = await LM.detect(DC.Ink.flip(orientedCanvas(A.layers.drawing)));
      if (pairKey() !== key || !S.open) return;
      const ff = res.faces && res.faces[0], c2 = ff ? P.mirrorScore(ff.points, rf.points) : null;
      S.mirror = c2 !== null && c2 > P.MIRROR.flippedMin ? { key, score, flipped: c2 } : null;
    } catch (_) { S.mirror = null; }
    renderPanel();
  }
  async function flipDrawing() {
    const L = A.layers.drawing, S0 = A.snapshotViews();
    S.mirror = null; L.flipH = !L.flipH; A.scheduleSave();
    S.analysis = null; S.loading = true; S.sel = null; S.hover = null; renderPanel();
    await Promise.all([detectLayer(A.layers.drawing), detectLayer(A.layers.reference)]);
    if (!S.open) return;
    S.loading = false;
    const a = recompute();
    if (a && a.ok) place({ zoom: true, animate: true });
    commit(S0, 'undo.mirror');
    renderPanel(); A.syncUI(); A.requestRender();
  }
  function dismissMirror() { (S.mirrorDismissed = S.mirrorDismissed || new Set()).add(pairKey()); S.mirror = null; renderPanel(); }

  function renderStatus() {
    const box = els.status;
    box.textContent = '';
    const a = S.analysis;
    const ok = !!(a && a.ok);
    const lm = LM.status;
    if (isPairsMode()) { // matching points: no face finder involved
      const n = pairsOf().length;
      box.append(h('div', { class: 'prop-pairs' },
        h('strong', { text: tk('pairs.count', { n, max: PAIRS_MAX }) }),
        h('div', { class: 'prop-pair-chips' }, ...pairsOf().map((_, i) => h('button', { type: 'button', class: 'prop-pair-chip', 'data-tip': tk('pairs.remove', { k: i + 1 }), 'aria-label': tk('pairs.remove', { k: i + 1 }), onclick: () => removePair(i) }, h('i', { class: 'num', text: String(i + 1) }), h('span', { 'aria-hidden': 'true', text: '×' }))))));
      box.append(h('p', { class: 'prop-note', text: ok ? tk('pairs.used', { n }) : tk('pairs.need', { n }) }));
      return;
    }
    if (S.placing && S.placing.kind === 'pairs') { box.append(h('p', { class: 'prop-note', text: tk('pairs.hint') })); return; }
    if (S.loading || S.pending > 0 || (lm === 'loading' && !a)) {
      const m = activeMode();
      const fKey = (m === 'half' || m === 'full') ? 'finding.figure' : m === 'hand' ? 'finding.hands' : 'finding';
      const dKey = LM.taskStatus && LM.taskStatus('pose') === 'loading' ? 'downloading.pose' : LM.taskStatus && LM.taskStatus('hand') === 'loading' ? 'downloading.hand' : lm === 'loading' ? 'downloading' : null;
      box.append(h('div', { class: 'prop-busy' }, h('i', { class: 'prop-spin', 'aria-hidden': 'true' }), h('div', {}, h('strong', { text: tk(fKey) }), dKey ? h('p', { class: 'prop-note', text: tk(dKey) }) : null)));
      return;
    }
    const mode = activeMode();
    if ((mode === 'half' || mode === 'full') && !ok && !S.placing) {
      const hasD = !!bodyFeaturesOf('drawing'), hasR = !!bodyFeaturesOf('reference');
      if (!hasR) {
        box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('body.no_ref') }), h('p', { text: tk('body.manual.hint') }),
          h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('body', 'reference'), text: tk('body.place') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => setMode('other'), text: tk('outlines') }))));
      } else if (!hasD) {
        box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('body.manual.title') }), h('p', { text: tk('body.manual.hint') }),
          h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('body', 'drawing'), text: tk('body.place') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => tryAutoDrawing('pose'), text: tk('body.try_auto') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => setMode('other'), text: tk('outlines') }))));
      }
      return;
    }
    if (mode === 'hand' && !ok && !S.placing) {
      const hasD = !!handFeaturesOf('drawing'), hasR = !!handFeaturesOf('reference');
      if (!hasR) {
        box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('hand.no_ref') }), h('p', { text: tk('hand.manual.hint') }),
          h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('hand', 'reference'), text: tk('hand.place') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => setMode('other'), text: tk('outlines') }))));
      } else if (!hasD) {
        box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('hand.manual.title') }), h('p', { text: tk('hand.manual.hint') }),
          h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('hand', 'drawing'), text: tk('hand.place') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => tryAutoDrawing('hand'), text: tk('hand.try_auto') }),
            h('button', { type: 'button', class: 'btn small', onclick: () => setMode('other'), text: tk('outlines') }))));
      }
      return;
    }
    if (mode === 'other' && a && !a.ok && a.needsSeed && !S.placing) {
      box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('outline.seed.ask') }),
        h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('seed', 'reference'), text: tk('outline.seed.btn') }),
          h('button', { type: 'button', class: 'btn small', onclick: () => startPlacing('pairs'), text: tk('place.pairs') }))));
      return;
    }
    // the detector used (basic detector notice)
    const dE = entryFor(A.layers.drawing), rE = entryFor(A.layers.reference);
    const basic = mode === 'face' && [dE, rE].some((e) => e && e.fellBack);
    if (mode === 'face' && (a === null || (a && !a.ok))) {
      const noD = !hasFace('drawing') && !isManual('drawing'), noR = !hasFace('reference') && !isManual('reference');
      const failed = LM.status === 'failed' || (dE && dE.error && !dE.faces.length && LM.status === 'failed');
      let title, hint;
      if (failed) { title = tk('failed'); hint = null; }
      else if (noD && noR) { title = tk('noface.both'); hint = tk('noface.hint.both'); }
      else if (noD) { title = tk('noface.draw'); hint = tk('noface.hint'); }
      else if (noR) { title = tk('noface.ref'); hint = tk('noface.hint'); }
      else { title = tk('failed'); hint = null; }
      if (S.analysis === null && (noD || noR || failed)) {
        if (S.choose) { // "Place points myself": a face (five points) or any other subject (matching points)
          box.append(h('div', { class: 'prop-card' }, h('strong', { text: tk('place.ask') }),
            h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('face'), text: tk('place.face') }),
              h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing('pairs'), text: tk('place.pairs') }))));
        } else {
          box.append(h('div', { class: 'prop-card' }, h('strong', { text: title }), hint ? h('p', { text: hint }) : null,
            h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => { S.choose = true; renderPanel(); }, text: tk('place') }),
              failed ? null : h('button', { type: 'button', class: 'btn small', onclick: () => compareOutlines(), text: tk('outlines') }))));
        }
      }
    }
    if (basic) box.append(h('p', { class: 'prop-note prop-basic', text: tk('fallback') }));
    if (ok) {
      if (mode === 'face') {
        const man = SLOTS.filter((s) => isManual(s));
        if (man.length) {
          box.append(h('p', { class: 'prop-note', text: tk('manual.used', { which: tk(man[0] === 'drawing' ? 'which.draw' : 'which.ref') }) }));
          const m = A.layers[man[0]].prop.manual, miss = [['noseBase', 'missing.nose'], ['mouthCentre', 'missing.mouth'], ['chin', 'missing.chin']].filter(([n]) => !m[n]).map(([, k]) => tk(k));
          if (miss.length) box.append(h('p', { class: 'prop-note prop-missing', text: tk('manual.missing', { list: i18n.list(miss) }) }));
        }
      }
      // Phase 3 notes/warnings (at most 2, by priority)
      const noteTexts = [];
      for (const n of (S.modeRes && S.modeRes.notes) || []) {
        if (n.key === 'drawing_shows_less') noteTexts.push(tk('note.drawing_shows_less'));
        else if (n.key === 'largest_figure') noteTexts.push(tk('note.largest_figure'));
      }
      for (const w of (a.report && a.report.warnings) || []) {
        if (w.key === 'poses_too_different') noteTexts.push(tk('note.poses_too_different'));
        else if (w.key === 'balance_outside_feet') noteTexts.push(tk('note.balance_outside'));
        else if (w.key === 'much_foreshortened') noteTexts.push(tk('note.much_foreshortened'));
        else if (w.key === 'foreshortened' && w.segments && w.segments[0]) noteTexts.push(tk('note.foreshortened', { part: outlineWhere({ part: w.segments[0].part, side: w.segments[0].side }) }));
        else if (w.key === 'head_unit_estimated') noteTexts.push(tk('note.head_estimated'));
        else if (w.key === 'head_from_detector') noteTexts.push(tk('note.head_detector'));
        else if (w.key === 'points_interpolated') noteTexts.push(tk('note.points_interpolated'));
      }
      if (a.outline && a.outline.notes && a.outline.notes[0]) {
        const on = a.outline.notes[0];
        noteTexts.push(tk('outline.not_followed', { where: outlineWhere(on) }));
      }
      for (const txt of noteTexts.slice(0, 2)) box.append(h('p', { class: 'prop-note', text: txt }));
    }
  }

  function setTab(k) {
    S.tab = k; S.sel = null; S.hover = null; S.expanded = false;
    recompute({ frozen: true }); renderPanel(); A.requestRender();
  }
  function renderTabs(a) {
    els.tabs.textContent = '';
    const secs = a.sections;
    if (!secs || a.mode === 'pairs') { els.tabs.hidden = true; return; }
    const modeSecs = (S.modeRes && S.modeRes.sections) || [];
    const list = [{ key: 'all', available: true, count: (secs.all || []).length }];
    for (const ms of modeSecs) {
      if (ms.key === 'points') continue;
      list.push({ key: ms.key, available: ms.available && !!secs[ms.key], reason: ms.reason, count: secs[ms.key] ? secs[ms.key].length : null });
    }
    if (!list.some((t) => t.key === S.tab && t.available)) S.tab = 'all';
    els.tabs.hidden = list.length <= 1;
    for (const t of list) {
      const lbl = tk('tab.' + t.key) + (t.available && t.count !== null ? ' ' + t.count : !t.available ? ' –' : '');
      const b = h('button', {
        type: 'button', role: 'tab', class: 'prop-tab',
        'aria-selected': String(S.tab === t.key),
        disabled: !t.available,
        'data-tip': !t.available && t.reason ? tk('tab.reason.' + t.reason) : null,
        onclick: () => setTab(t.key),
        text: lbl,
      });
      els.tabs.append(b);
    }
  }
  function renderExtras(a) {
    // Body: Heads tall
    const ht = (a.mode === 'half' || a.mode === 'full') && a.report && a.report.info && a.report.info.headsTall;
    if (ht && ht.drawing && ht.reference && (S.tab === 'all' || S.tab === 'body')) {
      els.headsRow.hidden = false;
      els.headsRow.textContent = tk('body.heads_tall', { d: ht.drawing.toFixed(1), r: ht.reference.toFixed(1) });
    } else els.headsRow.hidden = true;

    // Hands: Finger lengths mini chart
    const ratios = a.mode === 'hand' && a.report && a.report.info && a.report.info.ratios;
    els.fingerChart.textContent = '';
    if (ratios && Object.keys(ratios).length && (S.tab === 'all' || S.tab === 'hands')) {
      els.fingerChart.hidden = false;
      els.fingerChart.append(h('div', { class: 'prop-finger-head' }, h('span', { class: 'prop-lab', text: tk('hands.chart.title') }), h('span', { class: 'prop-finger-unit', text: tk('hands.chart.unit') })));
      const maxR = Math.max(1.1, ...Object.values(ratios).flatMap((v) => [v.drawing || 0, v.reference || 0]));
      for (const f of ['thumb', 'index', 'middle', 'ring', 'little']) {
        const rv = ratios[f]; if (!rv) continue;
        const rowId = 'hands:' + (f === 'thumb' ? 'thumb_length' : 'finger_' + f);
        const on = (S.hover || S.sel) === rowId;
        const r = h('div', { class: 'prop-finger-row' + (on ? ' on' : ''), onclick: () => { if (rowById(rowId)) selectRow(rowId); } },
          h('span', { text: tk('finger.' + f) }),
          h('div', { class: 'prop-finger-bars' },
            h('div', { class: 'prop-finger-ref', style: `width:${Math.round((rv.reference / maxR) * 100)}%` }),
            h('div', { class: 'prop-finger-draw', style: `width:${Math.round((rv.drawing / maxR) * 100)}%` })),
          h('span', { class: 'prop-finger-val', text: rv.drawing.toFixed(2) }));
        els.fingerChart.append(r);
      }
    } else els.fingerChart.hidden = true;

    // Outline legend
    const showOut = a.outline && a.outline.ok && (S.tab === 'outline' || a.mode === 'other' || st().outlineBand !== false);
    els.outlineLegend.hidden = !showOut;
  }

  function renderResult(a) {
    renderTabs(a);
    const rows = a.view.rows, cap = S.tab === 'all' ? MAX_ROWS : 10, shown = S.expanded ? rows : rows.slice(0, cap);
    const tolName = tk('tol.' + st().tolerance);
    els.count.textContent = '';
    els.count.append(h('b', { text: rows.length === 0 ? tk('count.none') : tk(rows.length === 1 ? 'count.one' : 'count.n', { n: rows.length }) }), h('span', { class: 'prop-count-tol', text: tk('count.tol', { name: tolName }) }));
    els.list.textContent = '';
    els.list.hidden = !rows.length;
    for (const r of shown) {
      const tag = h('i', { class: 'prop-tag ' + (r.severity === 'major' ? 'major' : 'minor'), 'aria-hidden': 'true', text: String(r.n) });
      const text = h('span', { class: 'prop-row-text' }, h('span', { class: 'prop-sentence' + (r.severity === 'major' ? ' major' : ''), text: r.text }),
        r.soft ? h('em', { class: 'prop-chipnote', text: tk('possible') }) : null, r.approx ? h('em', { class: 'prop-chipnote', text: tk('approx') }) : null,
        ...r.sub.map((sb) => h('span', { class: 'prop-sub', text: sentenceText(sb.sentence, sb.item, a) })));
      const btn = h('button', { type: 'button', class: 'prop-row', 'data-id': r.id, 'aria-pressed': String(S.sel === r.id), 'aria-label': tk('row.tip', { n: r.n, sentence: r.text + (r.sub.length ? (/^zh/.test(i18n.language) ? '；' : '. ') + r.sub.map((sb) => sentenceText(sb.sentence, sb.item, a)).join(/^zh/.test(i18n.language) ? '；' : '. ') : '') }) }, tag, text);
      btn.addEventListener('click', () => selectRow(r.id));
      btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hoverRow(r.id); });
      btn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hoverRow(null); });
      btn.addEventListener('focus', () => { if (btn.matches(':focus-visible') && S.sel !== r.id) { S.sel = r.id; S.hover = null; markSelected(); renderProxies(); A.requestRender(); } }); // keyboard: the focused row stays selected, so Tab reaches its points
      els.list.append(h('li', { class: 'prop-li' + ((S.hover || S.sel) === r.id ? ' on' : '') }, btn));
    }
    els.more.hidden = rows.length <= cap;
    els.more.textContent = S.expanded ? tk('fewer') : tk('more', { n: rows.length - cap });
    renderExtras(a);
    els.none.hidden = rows.length > 0;
    if (!rows.length) els.none.textContent = st().tolerance === 'strict' ? '' : tk('none.try');
    els.none.classList.toggle('empty', !els.none.textContent);
    const pr = a.mode === 'pairs';
    const rawClose = (a.view.close || []).filter((g) => pr || i18n.has('noun.' + g));
    const close = [...new Set(rawClose)].slice(0, 4).map((g) => (pr ? String(g) : tk('noun.' + g)));
    els.closeEnough.hidden = !close.length;
    els.closeEnough.textContent = close.length ? tk(pr ? 'pairs.close' : 'close.enough', { list: i18n.list(close) }) : '';
    markSelected();
  }
  function markSelected() {
    const cur = S.hover || S.sel;
    for (const li of els.list.querySelectorAll('.prop-li')) li.classList.toggle('on', li.firstChild.dataset.id === cur);
    for (const b of els.list.querySelectorAll('.prop-row')) b.setAttribute('aria-pressed', String(b.dataset.id === S.sel));
  }
  function hoverRow(id) { if (S.hover === id) return; S.hover = id; markSelected(); renderProxies(); A.requestRender(); }
  function selectRow(id) {
    if (S.sel === id) { centreOn(id); return; }
    S.sel = id; S.hover = null; markSelected(); renderProxies(); A.requestRender();
  }
  function centreOn(id) {
    const r = rowById(id), a = S.analysis;
    if (!r || !a) return;
    const pts = r.points.map((n) => a.Rp[n]).filter(Boolean);
    if (!pts.length) return;
    const c = pts.reduce((m, p) => ({ x: m.x + p.x / pts.length, y: m.y + p.y / pts.length }), { x: 0, y: 0 });
    const pane = refPane(), Lr = A.layers.reference, sz = sizeOfSlot('reference'), p = lp(Lr, pane, { x: c.x - sz.w / 2, y: c.y - sz.h / 2 });
    const dx = pane.width / 2 - p.x, dy = (pane.height - bottomInset()) / 2 - p.y;
    for (const l of [A.layers.drawing, Lr, ...(A.prevLayer.hasImage ? [A.prevLayer] : [])]) l.panBy(dx, dy);
    A.requestRender();
  }
  function announceOpen() {
    const a = S.analysis;
    if (!a || !a.ok) return;
    const rows = a.view.rows;
    const msg = !rows.length ? tk('announce.none') : rows.length === 1 ? tk('announce.one', { sentence: rows[0].text }) : tk('announce.open', { n: rows.length, sentence: rows[0].text });
    if (msg !== S.announced) { S.announced = msg; els.live.textContent = ''; setTimeout(() => { els.live.textContent = msg; }, 30); }
  }

  // ------------------------------------------------------------------------------------------------------------ no face: place points myself
  // Two coaches share S.placing: kind 'face' (five points; every one after the eyes can be skipped) and kind 'pairs' (matching points on
  // any subject: a spot on the reference, then the same spot on the drawing, up to PAIRS_MAX pairs).
  function placingSlot() {
    const noD = !hasFace('drawing') && !isManual('drawing'), noR = !hasFace('reference') && !isManual('reference');
    return noD && noR ? 'reference' : noD ? 'drawing' : noR ? 'reference' : 'drawing';
  }
  function coachList(kind) { return kind === 'body' ? BODY_COACH : kind === 'hand' ? HAND_COACH() : MANUAL; }
  function startPlacing(kind, slotOverride) {
    S.choose = false;
    if (kind === 'pairs') { startPairs(); return; }
    const slot = slotOverride || placingSlot();
    if (A.layers[slot].hidden) A.setHidden(slot, false);
    S.placing = { kind, slot, i: 0, pts: {}, list: kind === 'seed' ? [] : coachList(kind), S0: A.snapshotViews() };
    S.edit = false; lowerSheet();
    A.state.active = slot;
    A.syncUI();
    renderPanel(); renderCoach(); A.requestRender();
  }
  function startPairs() {
    S.choose = false; S.edit = false;
    if (pairsOf().length >= PAIRS_MAX) { A.toast(tk('pairs.max', { max: PAIRS_MAX })); return; }
    for (const s of SLOTS) if (A.layers[s].hidden) A.setHidden(s, false);
    S.placing = { kind: 'pairs', slot: 'reference', half: null }; lowerSheet();
    A.state.active = 'reference';
    A.syncUI();
    renderPanel(); renderCoach(); A.requestRender();
  }
  // phones: the sheet drops to its smallest height while points are placed, so the images are visible; it comes back afterwards
  function lowerSheet() { if (PHONE.matches && S.sheet !== 'peek') { S.sheetBefore = S.sheet; setSheet('peek'); } }
  function raiseSheet() { if (S.sheetBefore && PHONE.matches && S.sheet === 'peek') setSheet(S.sheetBefore); S.sheetBefore = null; }
  function cancelPlacing() {
    if (!S.placing) return;
    els.loupe.hidden = true;
    if (S.placing.kind === 'pairs') { finishPairs(); return; }
    S.placing = null; els.coach.hidden = true; raiseSheet();
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function placingBack() {
    const p = S.placing;
    if (!p) return;
    if (p.kind === 'pairs') {
      if (p.half) { p.half = null; p.slot = 'reference'; renderCoach(); A.requestRender(); }
      else if (pairsOf().length) removePair(pairsOf().length - 1);
      else finishPairs();
      return;
    }
    if (p.i > 0) { p.i--; delete p.pts[p.list[p.i]]; renderCoach(); A.requestRender(); } else cancelPlacing();
  }
  function placingSkip() {
    const p = S.placing;
    if (!p || p.kind === 'pairs' || p.kind === 'seed') return;
    if (p.kind === 'face' && p.i < 2) return;
    if (p.kind === 'hand' && p.i < 3) return;
    p.i++;
    if (p.i >= p.list.length) finishPlacing(); else { renderCoach(); A.requestRender(); }
  }
  function coachText() {
    const p = S.placing;
    if (!p) return '';
    if (p.kind === 'pairs') return tk(p.half ? 'pairs.step.draw' : 'pairs.step.ref', { k: pairsOf().length + 1, max: PAIRS_MAX });
    if (p.kind === 'seed') return tk(A.IS_TOUCH ? 'outline.seed.step' : 'outline.seed.step.click');
    return tk(A.IS_TOUCH ? 'coach.step' : 'coach.step.click', { i: p.i + 1, n: p.list.length, part: tk('coach.part.' + p.list[p.i]), which: tk(p.slot === 'drawing' ? 'which.draw' : 'which.ref') });
  }
  function renderCoach() {
    const p = S.placing;
    els.coach.hidden = !p;
    if (!p) return;
    const pr = p.kind === 'pairs', sd = p.kind === 'seed';
    const titleKey = pr ? 'pairs.title' : p.kind === 'body' ? 'coach.body.title' : p.kind === 'hand' ? 'coach.hand.title' : sd ? 'outline.seed.btn' : 'coach.title';
    els.coach.querySelector('.coach-step').textContent = tk(titleKey);
    els.coach.querySelector('.coach-text').textContent = coachText();
    els.coach.querySelector('[data-coach="back"]').hidden = sd;
    const canSkip = !pr && !sd && (p.kind === 'body' || (p.kind === 'hand' ? p.i >= 3 : p.i >= 2));
    els.coach.querySelector('[data-coach="skip"]').hidden = !canSkip;
    const placedCount = p.pts ? Object.keys(p.pts).length : 0;
    const canDone = (p.kind === 'body' && placedCount >= 3) || (p.kind === 'hand' && placedCount >= 3);
    els.coach.querySelector('[data-coach="done"]').hidden = !canDone;
    els.coach.querySelector('[data-coach="cancel"] span').textContent = tk(pr ? 'edit.done' : 'coach.cancel');
    positionTop(els.coach);
  }
  function positionTop(el) {
    const ws = A.workspace.getBoundingClientRect(), pane = A.panes[overlay() || A.state.layout !== 'side' || !S.placing ? 'drawing' : S.placing.slot].el.getBoundingClientRect();
    const width = Math.min(460, pane.width - 16);
    el.style.width = width + 'px';
    el.style.left = (pane.left - ws.left + (pane.width - width) / 2) + 'px';
    el.style.top = (pane.top - ws.top + 8) + 'px';
  }
  /** A tap at pane-centred (x, y) in `paneSlot`'s pane while placing. */
  function tap(paneSlot, x, y) {
    const p = S.placing;
    if (!p) return false;
    if (!overlay() && paneSlot !== p.slot) { A.toast(coachText()); return true; }
    const L = A.layers[p.slot], sz = sizeOfSlot(p.slot);
    const o = fromLp(L, { width: 0, height: 0 }, x, y); // pane-centred input: pane size cancels
    const pt = { x: o.x + sz.w / 2, y: o.y + sz.h / 2 };
    if (pt.x < 0 || pt.y < 0 || pt.x > sz.w || pt.y > sz.h) return true;
    if (p.kind === 'pairs') {
      if (p.slot === 'reference') { p.half = pt; p.slot = 'drawing'; A.state.active = 'drawing'; renderCoach(); A.requestRender(); return true; }
      addPair(p.half, pt);
      p.half = null; p.slot = 'reference'; A.state.active = 'reference';
      if (pairsOf().length >= PAIRS_MAX) { A.toast(tk('pairs.max', { max: PAIRS_MAX })); finishPairs(); } else renderCoach();
      A.requestRender();
      return true;
    }
    if (p.kind === 'seed') {
      els.loupe.hidden = true; S.placing = null; els.coach.hidden = true; raiseSheet();
      const S0 = p.S0;
      propOf(A.layers.reference).outlineSeed = pt;
      const a = recompute();
      if (a && a.ok) { commit(S0, 'undo.outline.seed'); A.toast(tk('coach.done')); }
      renderPanel(); A.requestRender(); A.syncUI();
      return true;
    }
    p.pts[p.list[p.i]] = pt;
    p.i++;
    if (p.i >= p.list.length) finishPlacing(); else { renderCoach(); A.requestRender(); }
    return true;
  }
  function finishPlacing() {
    const p = S.placing;
    els.loupe.hidden = true;
    S.placing = null; els.coach.hidden = true; raiseSheet();
    const S0 = p.S0, prop = propOf(A.layers[p.slot]);
    if (p.kind === 'body') {
      prop.bodyManual = clone(p.pts); delete prop.bodyEdits;
      S.modeRes = runModeChoice();
    } else if (p.kind === 'hand') {
      prop.handManual = clone(p.pts); delete prop.handEdits;
      S.modeRes = runModeChoice();
    } else {
      prop.manual = clone(p.pts); delete prop.edits;
    }
    const a = recompute();
    const uKey = p.kind === 'body' ? 'undo.body.manual' : p.kind === 'hand' ? 'undo.hand.manual' : 'undo.manual';
    if (a && a.ok) { place({ zoom: true, animate: true }); commit(S0, uKey); A.toast(tk('coach.done')); } else renderPanel();
    renderPanel(); A.requestRender(); A.syncUI();
  }

  // ---- matching points (pairs): every change is one Undo step; the drawing is fitted when the user is done (or drags a point)
  function addPair(r, d) {
    const S0 = A.snapshotViews(), dp = propOf(A.layers.drawing);
    if (!Array.isArray(dp.pairs)) dp.pairs = [];
    dp.pairs.push({ r: { x: r.x, y: r.y }, d: { x: d.x, y: d.y } });
    dp.pairsKey = pairKey();
    recompute();
    commit(S0, 'undo.pair.add', { k: dp.pairs.length }, true);
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function removePair(i) {
    const dp = propOf(A.layers.drawing);
    if (!dp.pairs || !dp.pairs[i]) return;
    const S0 = A.snapshotViews();
    dp.pairs.splice(i, 1);
    if (!dp.pairs.length) { delete dp.pairs; delete dp.pairsKey; }
    S.sel = null; S.hover = null;
    const a = recompute();
    let moved = false;
    if (!S.placing && a && a.ok) moved = place({ animate: true });
    commit(S0, 'undo.pair.remove', { k: i + 1 }, !moved);
    renderPanel(); if (S.placing) renderCoach(); A.requestRender(); A.syncUI();
  }
  function finishPairs() {
    const p = S.placing;
    S.placing = null; els.coach.hidden = true; raiseSheet();
    if (!p) return;
    const S0 = A.snapshotViews(), a = recompute();
    if (a && a.ok) { const moved = place({ zoom: true, animate: true }); if (moved) commit(S0, 'undo.pair.fit'); }
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function compareOutlines() {
    close({ keepMode: true, quiet: true });
    if (A.state.layout !== 'overlay') A.setLayout('overlay');
    A.setCompareMode('outline');
  }
  const soloSlot = () => (S.placing && overlay() ? S.placing.slot : null);
  // ------------------------------------------------------------------------------------------------------------ geometry: layer <-> pane
  /** Oriented-centred image px -> pane css px (top-left origin). */
  function lp(layer, pane, o) {
    const c = Math.cos(layer.angle), s = Math.sin(layer.angle);
    return { x: pane.width / 2 + layer.x + layer.scale * (o.x * c - o.y * s), y: pane.height / 2 + layer.y + layer.scale * (o.x * s + o.y * c) };
  }
  function fromLp(layer, pane, x, y) {
    const dx = (x - pane.width / 2 - layer.x) / layer.scale, dy = (y - pane.height / 2 - layer.y) / layer.scale, c = Math.cos(layer.angle), s = Math.sin(layer.angle);
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  // ------------------------------------------------------------------------------------------------------------ marks canvas
  function ensureCanvas(slot) {
    if (marks[slot]) return marks[slot];
    const body = A.panes[slot].el;
    const cv = h('canvas', { class: 'prop-marks', 'aria-hidden': 'true' });
    body.appendChild(cv);
    marks[slot] = cv;
    return cv;
  }
  function clearCanvas(slot) {
    const cv = marks[slot];
    if (!cv) return;
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    S.hits[slot] = [];
  }
  function drawAll() {
    if (!A || !els.root) return;
    if (!S.open && !marks.drawing._dirty && !marks.reference._dirty) return;
    for (const slot of SLOTS) { draw(slot); marks[slot]._dirty = S.open; }
  }

  // drawing primitives (halo first, then the mark)
  function halo(ctx, fn, w, col = HALO, alpha = 0.9) { ctx.save(); ctx.globalAlpha *= alpha; ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; fn(); ctx.restore(); }
  function ring(ctx, x, y, r, col, w) { const p = () => { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); }; halo(ctx, () => { p(); ctx.stroke(); }, w + 2.6); ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; p(); ctx.stroke(); ctx.restore(); }
  function dot(ctx, x, y, r, col) { ctx.save(); ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(x, y, r + 1.6, 0, 6.2832); ctx.fill(); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); ctx.restore(); }
  function arrow(ctx, a, b, col, w) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1.2) return;
    const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = Math.min(9, Math.max(4, len * 0.45)), hw = 0.5;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(b.x - hl * Math.cos(ang - hw), b.y - hl * Math.sin(ang - hw)); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - hl * Math.cos(ang + hw), b.y - hl * Math.sin(ang + hw));
    };
    halo(ctx, () => { path(); ctx.stroke(); }, w + 2.4);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; path(); ctx.stroke(); ctx.restore();
  }
  function line(ctx, pts, col, w, dash, hal = true) {
    const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    if (hal) halo(ctx, () => { ctx.setLineDash([]); path(); ctx.stroke(); }, w + 2.2, HALO, 0.75);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; path(); ctx.stroke(); ctx.restore();
  }
  function chip(ctx, text, x, y, opt = {}) { // centred on x; returns the box
    ctx.save();
    ctx.font = `${opt.italic === false ? '' : 'italic '}${opt.bold ? '600 ' : '500 '}${opt.size || 12}px ${SERIF}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + 12, hh = (opt.size || 12) + 8;
    const W = opt.W || 1e9, Hh = opt.H || 1e9;
    const cx = opt.left ? x + w / 2 : clamp(x, w / 2 + 4, W - w / 2 - 4), cy = clamp(y, hh / 2 + 4, Hh - hh / 2 - 4);
    ctx.fillStyle = opt.fill || PAPER; ctx.strokeStyle = opt.stroke || SINOPIA; ctx.lineWidth = 1;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(cx - w / 2, cy - hh / 2, w, hh, 3); else ctx.rect(cx - w / 2, cy - hh / 2, w, hh); ctx.fill(); ctx.stroke();
    ctx.fillStyle = opt.color || SINOPIA; ctx.fillText(text, cx, cy + 0.5);
    ctx.restore();
    return { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  }
  function tagMark(ctx, x, y, n, major, on) {
    const r = on ? 11.5 : 10;
    ctx.save();
    ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(x, y, r + 1.8, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    if (major) { ctx.fillStyle = VERMILION; ctx.fill(); } else { ctx.fillStyle = PAPER; ctx.fill(); ctx.strokeStyle = SINOPIA; ctx.lineWidth = 1.8; ctx.stroke(); }
    ctx.fillStyle = major ? '#fff' : SINOPIA; ctx.font = `700 ${n > 9 ? 10 : 11.5}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y + 0.5);
    ctx.restore();
  }
  function pinMark(ctx, x, y) {
    const R = 13;
    ctx.save();
    halo(ctx, () => { ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - R - 4, y); ctx.lineTo(x - R + 3, y); ctx.moveTo(x + R - 3, y); ctx.lineTo(x + R + 4, y); ctx.moveTo(x, y - R - 4); ctx.lineTo(x, y - R + 3); ctx.moveTo(x, y + R - 3); ctx.lineTo(x, y + R + 4); ctx.stroke(); }, 4.2);
    ctx.strokeStyle = VERMILION; ctx.lineWidth = 1.5; ctx.setLineDash([3.2, 3]); ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x - R - 4, y); ctx.lineTo(x - R + 3, y); ctx.moveTo(x + R - 3, y); ctx.lineTo(x + R + 4, y); ctx.moveTo(x, y - R - 4); ctx.lineTo(x, y - R + 3); ctx.moveTo(x, y + R - 3); ctx.lineTo(x, y + R + 4); ctx.stroke();
    ctx.restore();
    dot(ctx, x, y, 3.4, VERMILION);
  }
  function squareHandle(ctx, x, y, col) { ctx.save(); ctx.fillStyle = HALO; ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fill(); ctx.stroke(); ctx.restore(); }

  function measureEnds(a, which) { // [p, p] of the size measure in each image (oriented px), for display
    const used = a.al.size.used;
    const P_ = which === 'drawing' ? a.Dp : a.Rp;
    if (used === 'eyeSpacing') return [P_.eyeR, P_.eyeL];
    if (used === 'head' && P_.hairline) return [P_.hairline, P_.chin];
    if (used === 'custom') { const c = customSizeOf(a.D, a.R); return c[which]; }
    return [P_.eyeMid, P_.chin];
  }

  function draw(slot) {
    const cv = ensureCanvas(slot), pane = A.panes[slot];
    const W = pane.width, H = pane.height, dpr = pane.dpr, ctx = cv.getContext('2d');
    const bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(H * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    S.hits[slot] = [];
    if (!S.open || !W || !H) return;
    if (S.placing) { drawPlacing(ctx, slot, pane, W, H); return; }
    const a = S.analysis;
    if (isPairsMode()) { drawPairs(ctx, slot, pane, W, H, a && a.mode === 'pairs' ? a : null); return; }
    if (!a || !a.ok) return;
    const Ld = A.layers.drawing, Lr = A.layers.reference, ov = overlay();
    const dShow = slot === 'drawing' && !Ld.hidden && !A.showingPrev();
    const rShow = (ov ? slot === 'drawing' : slot === 'reference') && !Lr.hidden;
    if (!dShow && !rShow) return;
    const eD = entryFor(Ld).size, eR = entryFor(Lr).size;
    const dPos = (p) => lp(Ld, pane, { x: p.x - eD.w / 2, y: p.y - eD.h / 2 });
    const rPos = (p) => lp(Lr, pane, { x: p.x - eR.w / 2, y: p.y - eR.h / 2 });
    const row = selRow(), dim = !!row, s = st();
    const edited = (slotName, name) => {
      const p = A.layers[slotName].prop;
      if (!p) return false;
      if (a.mode === 'half' || a.mode === 'full') return !!((p.bodyEdits && p.bodyEdits[name]) || (p.bodyManual && p.bodyManual[name]));
      if (a.mode === 'hand') return !!((p.handEdits && p.handEdits[name]) || (p.handManual && p.handManual[name]));
      return !!((p.edits && p.edits[name]) || (p.manual && p.manual[name]));
    };
    const hits = S.hits[slot];
    const hitR = A.IS_TOUCH ? 22 : 9;
    const M3 = DC.PropMarksP3;

    // ---- Phase 3: Outline band (always on by default unless toggled off)
    if (M3 && a.outline && a.outline.ok && rShow && (s.outlineBand !== false || S.tab === 'outline' || a.mode === 'other')) {
      M3.drawOutline(ctx, a.outline, {
        rPos, W, H, selRow: row, rows: a.view.rows, hits,
        calm: a.mode !== 'other' && S.tab !== 'outline', tk,
      });
    }

    // ---- Phase 3: Body or Hand marks
    if (M3 && (a.mode === 'half' || a.mode === 'full')) {
      if (S.tab !== 'outline') {
        M3.drawBody(ctx, a, {
          slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR, selRow: row, rows: a.view.rows, s,
          edit: S.edit, touch: A.IS_TOUCH, hoverHeads: S.hoverHeads, tk, edited,
        });
      }
      updateProxyPositions(slot);
      return;
    }
    if (M3 && a.mode === 'hand') {
      if (S.tab !== 'outline') {
        M3.drawHand(ctx, a, {
          slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR, selRow: row, rows: a.view.rows, s,
          edit: S.edit, touch: A.IS_TOUCH, tk, edited,
        });
      }
      updateProxyPositions(slot);
      return;
    }
    if (a.mode === 'other') { updateProxyPositions(slot); return; }
    if (S.tab === 'outline') { updateProxyPositions(slot); return; }

    // ---- distortion grid (diagnostic only)
    if (s.grid && a.grid) drawGrid(ctx, a.grid, slot, pane, { dShow, rShow, Ld, Lr, eD, eR, W, H, ov });

    // ---- head tilt: the two midlines
    if (row && row.key === 'head_tilt') {
      for (const [P_, pos, col, dash, show] of [[a.Rp, rPos, SINOPIA, [5, 4], rShow], [a.Dp, dPos, INK, null, dShow]]) {
        if (!show || !P_.eyeMid || !P_.chin) continue;
        const A_ = pos(P_.eyeMid), B_ = pos(P_.chin), d = { x: B_.x - A_.x, y: B_.y - A_.y }, k = 1.6;
        line(ctx, [{ x: A_.x - d.x * 0.55, y: A_.y - d.y * 0.55 }, { x: B_.x + d.x * (k - 1), y: B_.y + d.y * (k - 1) }], col, 1.5, dash);
      }
    }

    // ---- size measure and pin (when they are not "auto")
    if (s.size !== 'auto') drawMeasure(ctx, a, { slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR });
    // ---- points
    const selPts = new Set(row ? row.points : []);
    const involved = new Set(selPts);
    for (const r of a.view.rows) r.points.forEach((n) => involved.add(n));
    const names = showPoints() || S.edit ? ORDER : [...involved];
    const lowA = dim ? 0.5 : 1;
    for (const [show, P_, pos, who] of [[rShow, a.R.points, rPos, 'reference'], [dShow, a.D.points, dPos, 'drawing']]) {
      if (!show) continue;
      for (const name of names) {
        const p = P_[name];
        if (!p || (isManual(who) && !MANUAL.includes(name))) continue;
        const q = pos(p), inSel = selPts.has(name);
        ctx.globalAlpha = dim && !inSel ? lowA : 1;
        if (who === 'reference') ring(ctx, q.x, q.y, inSel ? 4.4 : 3.6, SINOPIA, 1.6); else dot(ctx, q.x, q.y, inSel ? 3.6 : 2.8, INK);
        if (edited(who, name)) { ctx.globalAlpha = 1; line(ctx, [{ x: q.x + 5, y: q.y + 6 }, { x: q.x + 9, y: q.y + 1.5 }], INK, 1.3, null, true); }
        ctx.globalAlpha = 1;
        hits.push({ kind: 'pt', who, name, x: q.x, y: q.y, r: hitR + (inSel ? 3 : 0) });
      }
    }
    ctx.globalAlpha = 1;

    // ---- arrows (drawing pane only), brackets for the selected item, tags
    if (slot === 'drawing' && dShow) {
      const tags = [];
      const cx = a.Dp.noseBridge ? dPos(a.Dp.noseBridge) : a.Dp.eyeMid ? dPos(a.Dp.eyeMid) : { x: W / 2, y: H / 2 };
      for (const r of a.view.rows) {
        const on = row === r, alpha = dim && !on ? 0.5 : 1;
        const sinopiaMinor = r.severity === 'major' ? VERMILION : SINOPIA, wd = r.severity === 'major' ? 2.4 : 1.7;
        let tails = [];
        if (s.arrows) {
          for (const { ar, light } of r.arrows) {
            const tail = dPos(ar.drawing.from), f = rPos(ar.reference.from), t = rPos(ar.reference.to);
            const head = { x: tail.x + (t.x - f.x), y: tail.y + (t.y - f.y) };
            ctx.globalAlpha = alpha * (light ? 0.6 : 1);
            arrow(ctx, tail, head, light ? SINOPIA : sinopiaMinor, light ? 1.5 : wd);
            if (!light) tails.push(tail);
          }
          ctx.globalAlpha = 1;
        } else for (const ar of r.parts.flatMap((p) => p.arrows)) tails.push(dPos(ar.drawing.from));
        if (!tails.length) continue;
        const c = tails.reduce((m, p) => ({ x: m.x + p.x / tails.length, y: m.y + p.y / tails.length }), { x: 0, y: 0 });
        let dx = c.x - cx.x, dy = c.y - cx.y;
        const n = Math.hypot(dx, dy) || 1;
        if (n < 8) { dx = 1; dy = -1; }
        tags.push({ r, on, alpha, x: c.x + (dx / (Math.hypot(dx, dy))) * 24, y: c.y + (dy / (Math.hypot(dx, dy))) * 24 });
      }
      for (let it = 0; it < 8; it++) for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
        const d = dist(tags[i], tags[j]);
        if (d < 24) { const k = (24 - d) / 2 + 0.01, ux = d ? (tags[i].x - tags[j].x) / d : 1, uy = d ? (tags[i].y - tags[j].y) / d : 0; tags[i].x += ux * k; tags[i].y += uy * k; tags[j].x -= ux * k; tags[j].y -= uy * k; }
      }
      if (row) drawBracket(ctx, row, a, { dPos, rPos, W, H });
      for (const t of tags) {
        t.x = clamp(t.x, 14, W - 14); t.y = clamp(t.y, 14, H - 14);
        ctx.globalAlpha = t.alpha;
        tagMark(ctx, t.x, t.y, t.r.n, t.r.severity === 'major', t.on);
        ctx.globalAlpha = 1;
        hits.push({ kind: 'tag', id: t.r.id, x: t.x, y: t.y, r: 15 });
      }
    }
    // pin, on top
    if (s.pin !== 'auto') {
      const pins = [];
      if (ov) { if (rShow) pins.push(['reference', rPos(a.al.pin.reference)]); else if (dShow) pins.push(['drawing', dPos(a.al.pin.drawing)]); }
      else pins.push(slot === 'drawing' ? ['drawing', dPos(a.al.pin.drawing)] : ['reference', rPos(a.al.pin.reference)]);
      for (const [who, q] of pins) { pinMark(ctx, q.x, q.y); hits.push({ kind: 'pin', who, x: q.x, y: q.y, r: A.IS_TOUCH ? 26 : 16 }); }
    }
    // captions for the grid
    if (s.grid && a.grid) {
      const text = slot === 'drawing' ? tk('grid.cap.draw') : tk('grid.cap.ref');
      chip(ctx, text, 12, 22, { W, H, size: 12, color: INK, stroke: 'rgba(42,37,33,.45)', left: true });
    }
    updateProxyPositions(slot);
  }

  function drawGrid(ctx, g, slot, pane, o) {
    const { dShow, rShow, Ld, Lr, eD, eR } = o;
    const dPos = (p) => lp(Ld, pane, { x: p.x - eD.w / 2, y: p.y - eD.h / 2 });
    const rPos = (p) => lp(Lr, pane, { x: p.x - eR.w / 2, y: p.y - eR.h / 2 });
    if (rShow && !o.ov) {
      ctx.save(); ctx.globalAlpha = 0.6;
      for (const set of [g.reference.h, g.reference.v]) for (const pl of set) line(ctx, pl.map(rPos), SINOPIA, 1, [4, 3], true);
      ctx.restore();
    }
    if (dShow) {
      const sub = (g.drawing.h[0].length - 1) / g.cols, subv = (g.drawing.v[0].length - 1) / g.rows;
      ctx.save();
      for (const c of g.cells) {
        if (c.kind === 'none') continue;
        const i = c.col, j = c.row;
        const q = [g.drawing.h[j][i * sub], g.drawing.h[j][(i + 1) * sub], g.drawing.h[j + 1][(i + 1) * sub], g.drawing.h[j + 1][i * sub]].map(dPos);
        const alpha = clamp(Math.abs(c.smoothed) * 2, 0.06, 0.3);
        ctx.fillStyle = c.kind === 'stretched' ? `rgba(194,110,60,${alpha})` : `rgba(47,111,134,${alpha})`;
        ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      void subv;
      for (const set of [g.drawing.h, g.drawing.v]) for (const pl of set) line(ctx, pl.map(dPos), INK, 1, null, true);
    }
  }

  function drawMeasure(ctx, a, o) {
    const { slot, dShow, rShow, dPos, rPos, W, H, ov, hits, hitR } = o;
    const used = a.al.size.used, lab = used === 'eyeChin' ? 'measure.eyeChin' : used === 'eyeSpacing' ? 'measure.eyeSpacing' : used === 'head' ? 'measure.head' : 'measure.custom';
    const custom = used === 'custom';
    const draw1 = (who, pos, off) => {
      const ends = measureEnds(a, who);
      if (!ends || !ends[0] || !ends[1]) return;
      const A_ = pos(ends[0]), B_ = pos(ends[1]);
      const horiz = Math.abs(B_.x - A_.x) > Math.abs(B_.y - A_.y);
      const P_ = who === 'drawing' ? a.Dp : a.Rp;
      const face = ['cheekR', 'cheekL', 'jawHighR', 'jawHighL', 'browOuterR', 'browOuterL'].map((n) => P_[n]).filter(Boolean).map(pos);
      let a2, b2;
      if (horiz) { const y = (face.length ? Math.min(...face.map((p) => p.y)) : Math.min(A_.y, B_.y)) - 28 - off; a2 = { x: A_.x, y }; b2 = { x: B_.x, y }; }
      else { const x = (face.length ? Math.max(...face.map((p) => p.x)) : Math.max(A_.x, B_.x)) + 30 + off; a2 = { x, y: A_.y }; b2 = { x, y: B_.y }; }
      const col = who === 'drawing' ? INK : SINOPIA;
      line(ctx, [A_, a2], col, 1, [2, 3], true); line(ctx, [B_, b2], col, 1, [2, 3], true);
      arrow(ctx, { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }, a2, col, 1.4); arrow(ctx, { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }, b2, col, 1.4);
      squareHandle(ctx, a2.x, a2.y, col); squareHandle(ctx, b2.x, b2.y, col);
      const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
      chip(ctx, tk(lab), horiz ? mid.x : mid.x + 6, horiz ? mid.y - 14 : mid.y + 18 * (who === 'drawing' ? 1 : -1), { W, H, size: 11 });
      hits.push({ kind: 'measure', who, end: 0, x: a2.x, y: a2.y, r: hitR + 4 }, { kind: 'measure', who, end: 1, x: b2.x, y: b2.y, r: hitR + 4 });
    };
    if (ov) { if (rShow) draw1('reference', rPos, 0); if (dShow && custom) draw1('drawing', dPos, 34); }
    else if (slot === 'drawing' && dShow) draw1('drawing', dPos, 0);
    else if (slot === 'reference' && rShow) draw1('reference', rPos, 0);
  }

  function drawBracket(ctx, row, a, o) {
    const part = row.parts.find((p) => p.span) || null;
    if (!part) return;
    const { dPos, rPos, W, H } = o;
    const [n1, n2] = part.span, d1 = a.Dp[n1], d2 = a.Dp[n2], r1 = a.Rp[n1], r2 = a.Rp[n2];
    if (!d1 || !d2 || !r1 || !r2) return;
    const D1 = dPos(d1), D2 = dPos(d2), R1 = rPos(r1), R2 = rPos(r2);
    const u = { x: D2.x - D1.x, y: D2.y - D1.y }, Ld = Math.hypot(u.x, u.y) || 1;
    u.x /= Ld; u.y /= Ld;
    const Lr = Math.hypot(R2.x - R1.x, R2.y - R1.y);
    const vertical = Math.abs(u.y) > Math.abs(u.x);
    let nrm = vertical ? { x: 1, y: 0 } : { x: 0, y: part.key === 'eye_spacing' ? -1 : 1 };
    if (vertical && u.y < 0) u.x = -u.x, u.y = -u.y;
    const off = 30;
    const sh = (p, k) => ({ x: p.x + nrm.x * k, y: p.y + nrm.y * k });
    // reference: dashed sinopia; drawing: solid graphite, 8 px further out; the excess is a short vermilion segment
    const ru = { x: R2.x - R1.x, y: R2.y - R1.y }, rl = Math.hypot(ru.x, ru.y) || 1;
    ru.x /= rl; ru.y /= rl;
    const rs = sh(R1, off), re = { x: rs.x + ru.x * Lr, y: rs.y + ru.y * Lr };
    const ds = sh(D1, off + 9), de = { x: ds.x + u.x * Ld, y: ds.y + u.y * Ld };
    line(ctx, [sh(R1, 4), rs], SINOPIA, 1, [2, 2]); line(ctx, [sh(R2, 4), sh(R2, off)], SINOPIA, 1, [2, 2]);
    line(ctx, [rs, re], SINOPIA, 1.6, [5, 4]);
    line(ctx, [sh(D1, 4), ds], INK, 1, [2, 2]); line(ctx, [sh(D2, 4), de], INK, 1, [2, 2]);
    line(ctx, [ds, de], INK, 1.8);
    for (const p of [rs, re, ds, de]) line(ctx, [{ x: p.x - nrm.y * 4 - nrm.x * 0, y: p.y + nrm.x * 4 }, { x: p.x + nrm.y * 4, y: p.y - nrm.x * 4 }], p === rs || p === re ? SINOPIA : INK, 1.4, null, true);
    const extra = Math.abs(Ld - Lr);
    if (extra > 1.5) {
      if (Ld > Lr) line(ctx, [{ x: ds.x + u.x * Lr, y: ds.y + u.y * Lr }, de], VERMILION, 4.2);
      else line(ctx, [{ x: rs.x + ru.x * Ld, y: rs.y + ru.y * Ld }, re], VERMILION, 4.2);
    }
    const mid = { x: (ds.x + de.x) / 2, y: (ds.y + de.y) / 2 };
    chip(ctx, row.text, vertical ? mid.x + 12 + 0 : mid.x, vertical ? mid.y : mid.y + (nrm.y > 0 ? 24 : -24), { W, H, size: 12, bold: true, fill: row.severity === 'major' ? VERMILION : PAPER, color: row.severity === 'major' ? '#fff' : SINOPIA, stroke: row.severity === 'major' ? VERMILION : SINOPIA, italic: false });
  }

  function plainTag(ctx, x, y, n) { // a pair that is within tolerance: a small paper tag
    ctx.save();
    ctx.fillStyle = HALO; ctx.beginPath(); ctx.arc(x, y, 8.6, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = 'rgba(42,37,33,.6)'; ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(x, y, 7.2, 0, 6.2832); ctx.stroke();
    ctx.fillStyle = INK; ctx.font = `600 ${n > 9 ? 8.5 : 10}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y + 0.5);
    ctx.restore();
  }
  /** Matching points: rings (reference) and dots (drawing), numbered; arrows from the drawing's spot to where the reference puts it for the flagged ones. */
  function drawPairs(ctx, slot, pane, W, H, a) {
    const Ld = A.layers.drawing, Lr = A.layers.reference, ov = overlay();
    const dShow = slot === 'drawing' && !Ld.hidden && !A.showingPrev();
    const rShow = (ov ? slot === 'drawing' : slot === 'reference') && !Lr.hidden;
    if (!dShow && !rShow) return;
    const eD = entryFor(Ld).size, eR = entryFor(Lr).size;
    const dPos = (p) => lp(Ld, pane, { x: p.x - eD.w / 2, y: p.y - eD.h / 2 });
    const rPos = (p) => lp(Lr, pane, { x: p.x - eR.w / 2, y: p.y - eR.h / 2 });
    const pairs = pairsOf(), row = selRow(), dim = !!row, hits = S.hits[slot], hitR = A.IS_TOUCH ? 22 : 9;
    const items = a ? a.report.items : [];
    pairs.forEach((pr, i) => {
      const it = items[i], on = !!row && row.n === i + 1, flagged = !!(it && it.flagged), major = !!(it && it.severity === 'major');
      const alpha = dim && !on ? 0.5 : 1, name = 'p' + (i + 1);
      if (rShow) {
        const q = rPos(pr.r);
        ctx.globalAlpha = alpha; ring(ctx, q.x, q.y, on ? 4.4 : 3.6, SINOPIA, 1.6); ctx.globalAlpha = 1;
        hits.push({ kind: 'pt', who: 'reference', name, x: q.x, y: q.y, r: hitR + (on ? 3 : 0) });
        if (!ov) { ctx.globalAlpha = alpha; if (flagged) tagMark(ctx, q.x + 14, q.y - 14, i + 1, false, on); else plainTag(ctx, q.x + 13, q.y - 13, i + 1); ctx.globalAlpha = 1; }
      }
      if (dShow) {
        const q = dPos(pr.d);
        if (a && flagged && st().arrows !== false) {
          const head = dPos(it.arrow.to);
          ctx.globalAlpha = alpha; arrow(ctx, q, head, major ? VERMILION : SINOPIA, major ? 2.4 : 1.8); ctx.globalAlpha = 1;
        }
        ctx.globalAlpha = alpha; dot(ctx, q.x, q.y, on ? 3.6 : 2.8, INK);
        if (flagged) tagMark(ctx, q.x + 14, q.y - 14, i + 1, major, on); else plainTag(ctx, q.x + 13, q.y - 13, i + 1);
        ctx.globalAlpha = 1;
        hits.push({ kind: 'pt', who: 'drawing', name, x: q.x, y: q.y, r: hitR + (on ? 3 : 0) });
        if (flagged) hits.push({ kind: 'tag', id: name, x: q.x + 14, y: q.y - 14, r: 14 });
      }
    });
    updateProxyPositions(slot);
  }

  function drawPlacingPairs(ctx, slot, pane) {
    const p = S.placing, ov = overlay();
    if (ov && slot !== 'drawing') return;
    const who = ov ? p.slot : slot, L = A.layers[who], sz = sizeOfSlot(who);
    if (L.hidden) return;
    const pos = (pt) => lp(L, pane, { x: pt.x - sz.w / 2, y: pt.y - sz.h / 2 });
    const mark = (pt, n, pending) => {
      const q = pos(pt);
      ctx.globalAlpha = pending ? 0.9 : 1;
      if (who === 'reference') ring(ctx, q.x, q.y, 4.2, SINOPIA, 1.8); else dot(ctx, q.x, q.y, 3.4, INK);
      tagMark(ctx, q.x + 14, q.y - 14, n, false, false);
      ctx.globalAlpha = 1;
    };
    pairsOf().forEach((pr, i) => mark(who === 'reference' ? pr.r : pr.d, i + 1, false));
    if (p.half && who === 'reference') mark(p.half, pairsOf().length + 1, true);
  }

  function drawPlacing(ctx, slot, pane, W, H) {
    const p = S.placing;
    if (!p) return;
    if (p.kind === 'pairs') { drawPlacingPairs(ctx, slot, pane); return; }
    const L = A.layers[p.slot], sz = sizeOfSlot(p.slot);
    if (!(overlay() ? slot === 'drawing' : slot === p.slot)) return;
    const pos = (pt) => lp(L, pane, { x: pt.x - sz.w / 2, y: pt.y - sz.h / 2 });
    if (DC.PropMarksP3) DC.PropMarksP3.drawCoachPreview(ctx, p, pos);
    (p.list || MANUAL).forEach((name, i) => {
      const pt = p.pts[name];
      if (!pt) return;
      const q = pos(pt);
      (p.slot === 'reference' ? ring : (c, x, y, r, col) => dot(c, x, y, r + 0.6, col))(ctx, q.x, q.y, 4.4, p.slot === 'reference' ? SINOPIA : INK, 1.8);
      tagMark(ctx, q.x + 14, q.y - 14, i + 1, false, false);
    });
  }

  // ------------------------------------------------------------------------------------------------------------ interaction
  const hitAt = (slot, x, y, edit) => {
    let best = null, bd = 1e9;
    const list = S.hits[slot] || [];
    for (const k of list) {
      if (k.kind === 'pt' && !edit && !A.IS_TOUCH) { /* mouse: always draggable */ }
      const d = Math.hypot(k.x - x, k.y - y);
      const r = k.kind === 'pt' ? k.r : k.r;
      const w = k.kind === 'tag' ? d - 3 : k.kind === 'pin' || k.kind === 'measure' ? d - 4 : d + (k.who === 'reference' ? 0.4 : 0); // handles win over points; a point over a coincident ring
      if (d <= r && w < bd) { best = k; bd = w; }
    }
    return best;
  }
  const localPt = (slot, e) => { const r = A.panes[slot].el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function attachPane(slot) {
    const body = A.panes[slot].el;
    body.addEventListener('pointerdown', (e) => onDown(slot, e), true);
    body.addEventListener('pointermove', (e) => onHover(slot, e));
    body.addEventListener('pointerleave', () => { hideBubble(); setCursor(slot, false); if (S.placing) els.loupe.hidden = true; });
  }
  const setCursor = (slot, on) => { A.panes[slot].canvas.style.cursor = on ? 'move' : ''; };

  let hoverTimer = 0, hoverHit = null;
  function onHover(slot, e) {
    if (S.open && S.placing && e.pointerType === 'mouse') {
      if (overlay() || slot === S.placing.slot) drawLoupeAt(slot, e); else els.loupe.hidden = true;
      return;
    }
    if (!S.open || S.drag || S.placing || e.pointerType !== 'mouse') return;
    const q = localPt(slot, e), hit = hitAt(slot, q.x, q.y);
    setCursor(slot, !!hit && hit.kind !== 'tag');
    if (!hit || hit.kind === 'tag') { clearTimeout(hoverTimer); hoverHit = null; hideBubble(); return; }
    if (hoverHit && hoverHit.name === hit.name && hoverHit.kind === hit.kind && hoverHit.who === hit.who && hoverHit.end === hit.end) return;
    hoverHit = hit; clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showBubble(slot, hit, 'mouse'), 420);
  }
  function bubbleText(hit) {
    if (hit.kind === 'pin') return { name: tk('pin.label'), desc: tk('pin.canvas') };
    if (hit.kind === 'measure') return { name: tk('size.label'), desc: tk('measure.handle') };
    const which = tk(hit.who === 'drawing' ? 'pt.drawing' : 'pt.reference'), nm = ptLabel(hit.name), p = A.layers[hit.who].prop;
    const ed = !!(p && ((p.edits && p.edits[hit.name]) || (p.manual && p.manual[hit.name])));
    return { name: tk('pt.name', { name: nm, which }), desc: tk(ed ? 'pt.hint.edited' : 'pt.hint') };
  }
  function showBubble(slot, hit, mode) {
    if (!DC.tips) return;
    const r = A.panes[slot].el.getBoundingClientRect(), t = bubbleText(hit);
    const b = els.bubble;
    b.style.cssText = `position:fixed;left:${r.left + hit.x - 1}px;top:${r.top + hit.y - 1}px;width:2px;height:2px;pointer-events:none;opacity:0`;
    b.setAttribute('aria-label', t.name); b.setAttribute('data-tip', t.desc);
    DC.tips.show(b, mode);
  }
  const hideBubble = () => { clearTimeout(hoverTimer); hoverHit = null; if (DC.tips) DC.tips.hide(); };

  function onDown(slot, e) {
    if (S.open && S.placing && e.pointerType !== 'mouse') {
      if (!overlay() && slot !== S.placing.slot) return;
      e.preventDefault(); e.stopPropagation();
      const pid = e.pointerId;
      drawLoupeAt(slot, e);
      const mv = (ev) => { if (ev.pointerId === pid) { ev.preventDefault(); drawLoupeAt(slot, ev); } };
      const up = (ev) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
        els.loupe.hidden = true;
        if (ev.type === 'pointerup') {
          const r = A.panes[slot].el.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
            tap(slot, ev.clientX - r.left - r.width / 2, ev.clientY - r.top - r.height / 2);
          }
        }
      };
      window.addEventListener('pointermove', mv, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
      return;
    }
    if (!S.open || S.placing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const q = localPt(slot, e);
    const touch = e.pointerType !== 'mouse';
    const hit = hitAt(slot, q.x, q.y);
    if (!hit) return;
    if (hit.kind === 'tag') { e.preventDefault(); e.stopPropagation(); selectRow(hit.id); return; }
    if (!touch || S.edit || hit.kind === 'pin' || hit.kind === 'measure') {
      if (touch && !S.edit && hit.kind !== 'pin' && hit.kind !== 'measure') return;
      e.preventDefault(); e.stopPropagation();
      beginDrag(slot, hit, e, false);
      return;
    }
    // touch, not in Edit mode: press and hold a point to pick it up; a quick drag pans as usual
    const press = { id: e.pointerId, x: e.clientX, y: e.clientY, hit, done: false };
    const cancel = () => { clearTimeout(press.t); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', cancel, true); window.removeEventListener('pointercancel', cancel, true); };
    const move = (ev) => { if (ev.pointerId === press.id && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) cancel(); };
    press.t = setTimeout(() => {
      cancel();
      const cvs = A.panes[slot].canvas;
      try { cvs.releasePointerCapture(press.id); } catch (_) { /* nothing captured */ }
      try { cvs.dispatchEvent(new PointerEvent('pointercancel', { pointerId: press.id, pointerType: e.pointerType, bubbles: false })); } catch (_) { /* old browsers */ }
      showBubble(slot, hit, 'touch');
      beginDrag(slot, hit, e, true);
    }, 480);
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', cancel, true); window.addEventListener('pointercancel', cancel, true);
  }

  function beginDrag(slot, hit, e, picked) {
    const drag = { slot, hit, id: e.pointerId, S0: A.snapshotViews(), moved: false, touch: e.pointerType !== 'mouse', picked, last: localPt(slot, e) };
    S.drag = drag;
    hideBubble();
    if (picked) { showBubble(slot, hit, 'touch'); }
    if (hit.kind === 'pt') S.frozen = true;
    try { A.panes[slot].el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer: moves still reach window */ }
    const mv = (ev) => { if (ev.pointerId === drag.id) dragMove(ev); };
    const up = (ev) => { if (ev.pointerId !== drag.id) return; window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); endDrag(ev.type === 'pointercancel'); };
    window.addEventListener('pointermove', mv, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    if (picked) drawLoupe(drag, e);
  }
  function dragMove(e) {
    const d = S.drag;
    if (!d) return;
    const q = localPt(d.slot, e), pane = A.panes[d.slot];
    d.last = q;
    if (Math.hypot(q.x - d.hit.x, q.y - d.hit.y) > 1.2) d.moved = true;
    const h0 = d.hit;
    const layerOf = (who) => A.layers[who];
    if (h0.kind === 'pt') {
      const L = layerOf(h0.who), sz = sizeOfSlot(h0.who), o = fromLp(L, pane, q.x, q.y);
      setPoint(h0.who, h0.name, { x: o.x + sz.w / 2, y: o.y + sz.h / 2 });
      recompute({ frozen: true });
    } else if (h0.kind === 'pin') {
      const a = S.analysis, dp = propOf(A.layers.drawing);
      let ref;
      if (h0.who === 'reference' || overlay()) { const L = A.layers.reference, sz = sizeOfSlot('reference'), o = fromLp(L, pane, q.x, q.y); ref = { x: o.x + sz.w / 2, y: o.y + sz.h / 2 }; }
      else { const L = A.layers.drawing, sz = sizeOfSlot('drawing'), o = fromLp(L, pane, q.x, q.y); ref = P.apply(a.al, { x: o.x + sz.w / 2, y: o.y + sz.h / 2 }); }
      // snap to a feature point within 12 px
      let snap = null, bd = 12;
      const L = A.layers.reference, sz = sizeOfSlot('reference');
      for (const name of ORDER) { const p = a.R.points[name], pd = a.D.points[name]; if (!p || !pd) continue; const s2 = lp(L, pane, { x: p.x - sz.w / 2, y: p.y - sz.h / 2 }), dd = Math.hypot(s2.x - q.x, s2.y - q.y); if (dd < bd) { bd = dd; snap = { x: p.x, y: p.y, dx: pd.x, dy: pd.y }; } }
      dp.customPin = snap || { x: ref.x, y: ref.y };
      st().pin = 'custom';
      recompute(); place({ animate: false });
    } else if (h0.kind === 'measure') {
      const a = S.analysis, dp = propOf(A.layers.drawing), who = h0.who;
      if (st().size !== 'custom') { dp.customSize = { drawing: measureEnds(a, 'drawing').map((p) => ({ x: p.x, y: p.y })), reference: measureEnds(a, 'reference').map((p) => ({ x: p.x, y: p.y })) }; st().size = 'custom'; }
      const L = A.layers[who], sz = sizeOfSlot(who), o = fromLp(L, pane, q.x, q.y);
      let pt = { x: o.x + sz.w / 2, y: o.y + sz.h / 2 }, bd = 12;
      const F = who === 'drawing' ? a.D.points : a.R.points;
      for (const name of ORDER) { const p = F[name]; if (!p) continue; const s2 = lp(L, pane, { x: p.x - sz.w / 2, y: p.y - sz.h / 2 }), dd = Math.hypot(s2.x - q.x, s2.y - q.y); if (dd < bd) { bd = dd; pt = { x: p.x, y: p.y }; } }
      if (!dp.customSize) dp.customSize = { drawing: measureEnds(a, 'drawing').map((p) => ({ ...p })), reference: measureEnds(a, 'reference').map((p) => ({ ...p })) };
      dp.customSize[who][h0.end] = pt;
      recompute(); place({ animate: false });
    }
    if (d.picked || d.touch || h0.kind === 'pt') drawLoupe(d, e);
    d.hit = Object.assign(d.hit, h0.kind === 'pt' ? { x: q.x, y: q.y } : {});
    renderPanelLight();
    A.requestRender();
  }
  /** While dragging: refresh the numbers and list order without rebuilding more than needed. */
  function renderPanelLight() { const a = S.analysis; if (a && a.ok) renderResult(a); }
  function endDrag(cancelled) {
    const d = S.drag;
    S.drag = null; S.frozen = false;
    els.loupe.hidden = true; hideBubble();
    if (!d) return;
    const h0 = d.hit;
    if (cancelled || !d.moved) { if (d.moved) { /* keep */ } }
    if (!d.moved) { A.restoreViews(d.S0, ''); return; }
    const a = recompute();
    let moved = false;
    if (a && a.ok) moved = place({ animate: true });
    if (h0.kind === 'pt') commit(d.S0, ...movedLabel(h0.name), !moved);
    else if (h0.kind === 'pin') commit(d.S0, 'undo.pin.custom', null, false);
    else commit(d.S0, 'undo.size.custom', null, false);
    renderPanel(); A.requestRender(); A.syncUI(); announceTop();
  }
  const movedLabel = (name) => (PAIR_RE.test(name) ? ['undo.pair.moved', { k: +name.slice(1) }] : ['undo.moved', { point: lc(tk('pt.' + name)) }]);
  function announceTop() {
    const a = S.analysis;
    if (!a || !a.ok) return;
    const top = a.view.rows[0] ? a.view.rows[0].text : '';
    if (top && top !== S.announcedTop) { S.announcedTop = top; els.live.textContent = ''; setTimeout(() => { els.live.textContent = tk('announce.one', { sentence: top }); }, 30); }
  }
  function drawLoupe(d, e) { drawLoupeAt(d.slot, e); }
  function drawLoupeAt(slot, e) {
    const pane = A.panes[slot], q = localPt(slot, e), k = pane.dpr, Sz = 44.8, ctx = els.loupe.getContext('2d');
    ctx.fillStyle = '#7f7d79'; ctx.fillRect(0, 0, 224, 224);
    ctx.imageSmoothingEnabled = true;
    for (const cv of [pane.canvas, marks[slot]]) { try { ctx.drawImage(cv, (q.x - Sz / 2) * k, (q.y - Sz / 2) * k, Sz * k, Sz * k, 0, 0, 224, 224); } catch (_) { /* nothing to show */ } }
    ctx.lineCap = 'round';
    for (const [w, c] of [[5, 'rgba(255,255,255,.85)'], [2.4, VERMILION]]) { ctx.lineWidth = w; ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(112, 40); ctx.lineTo(112, 98); ctx.moveTo(112, 126); ctx.lineTo(112, 184); ctx.moveTo(40, 112); ctx.lineTo(98, 112); ctx.moveTo(126, 112); ctx.lineTo(184, 112); ctx.stroke(); }
    const vv = window.visualViewport, vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
    const x = clamp(e.clientX, 62, vw - 62);
    const y = clamp(e.clientY < 130 ? e.clientY + 80 : e.clientY - 80, 62, vh - 62);
    els.loupe.style.left = `${x - 56}px`; els.loupe.style.top = `${y - 56}px`;
    els.loupe.hidden = false;
  }

  // ---- keyboard access: the selected difference's points are real buttons; arrow keys move one by 1 px (Shift: 10)
  let proxyKey = '';
  function renderProxies() {
    if (!els.proxies) return;
    const a = S.analysis, row = selRow();
    const key = S.open && a && a.ok && row ? row.id + '|' + row.points.join() : '';
    if (key === proxyKey) return;
    proxyKey = key;
    els.proxies.textContent = '';
    if (!key) { els.proxies.hidden = true; return; }
    els.proxies.hidden = false;
    for (const who of SLOTS) for (const name of row.points.slice(0, POINT_LIST_CAP)) {
      if (!(who === 'drawing' ? a.D : a.R).points[name]) continue;
      const b = h('button', { type: 'button', class: 'prop-proxy', 'data-who': who, 'data-name': name, 'aria-label': tk('pt.name', { name: ptLabel(name), which: tk(who === 'drawing' ? 'pt.drawing' : 'pt.reference') }), 'data-tip': tk('pt.hint') });
      b.addEventListener('keydown', (e) => proxyKey_(e, who, name));
      els.proxies.append(b);
    }
  }
  let nudge = null;
  function proxyKey_(e, who, name) {
    const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!mv) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const r = els.list.querySelector('.prop-row[aria-pressed="true"]') || els.list.querySelector('.prop-row'); if (r) r.focus(); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const L = A.layers[who], k = (e.shiftKey ? 10 : 1) / L.scale, c = Math.cos(L.angle), s = Math.sin(L.angle);
    const dx = (mv[0] * c + mv[1] * s) * k, dy = (-mv[0] * s + mv[1] * c) * k, a = S.analysis, cur = (who === 'drawing' ? a.D : a.R).points[name];
    if (!nudge) nudge = { S0: A.snapshotViews(), name, who };
    setPoint(who, name, { x: cur.x + dx, y: cur.y + dy });
    recompute({ frozen: true }); renderPanelLight(); A.requestRender();
    clearTimeout(nudge.t);
    nudge.t = setTimeout(() => {
      const n = nudge; nudge = null;
      const a2 = recompute(); let moved = false;
      if (a2 && a2.ok) moved = place({ animate: true });
      commit(n.S0, ...movedLabel(n.name), !moved);
      renderPanel(); A.requestRender(); A.syncUI(); announceTop();
    }, 700);
  }
  function updateProxyPositions(slot) {
    const a = S.analysis;
    if (!a || !a.ok || !els.proxies) return;
    const pane = A.panes[slot], r = pane.el.getBoundingClientRect(), Ld = A.layers.drawing, Lr = A.layers.reference;
    for (const b of els.proxies.querySelectorAll('.prop-proxy')) {
      const who = b.dataset.who, name = b.dataset.name, L = who === 'drawing' ? Ld : Lr;
      const visible = overlay() ? slot === 'drawing' : slot === who;
      if (!visible) continue;
      const p = (who === 'drawing' ? a.D : a.R).points[name];
      if (!p) continue;
      const sz = sizeOfSlot(who), q = lp(L, pane, { x: p.x - sz.w / 2, y: p.y - sz.h / 2 });
      b.style.left = `${r.left + q.x - 11}px`; b.style.top = `${r.top + q.y - 11}px`;
    }
  }
  function clearProxies() { proxyKey = ''; if (els.proxies) { els.proxies.textContent = ''; els.proxies.hidden = true; } }

  // ------------------------------------------------------------------------------------------------------------ export (PNG with the marks)
  // The marks canvases have exactly the size and device-pixel ratio of the pane canvases, so exporting is: pane canvas, then its marks canvas
  // on top (same pixels as on screen), then a taped report strip under the images. Nothing here changes when Proportions is closed.
  function wrapLines(ctx, text, maxW) {
    const tokens = text.match(/[⺀-鿿＀-￯]|[^\s⺀-鿿＀-￯]+\s*/g) || [];
    const lines = [];
    let cur = '';
    for (const tkn of tokens) {
      if (cur && ctx.measureText((cur + tkn).replace(/\s+$/, '')).width > maxW) { lines.push(cur.replace(/\s+$/, '')); cur = tkn.replace(/^\s+/, ''); } else cur += tkn;
    }
    if (cur) lines.push(cur.replace(/\s+$/, ''));
    return lines;
  }
  function stripData() {
    const a = S.analysis;
    if (!a || !a.ok) return null;
    const s = st(), pairsMode = a.mode === 'pairs', mode = a.mode || 'face', tol = tk('tol.' + s.tolerance);
    const rows = a.view.rows.map((r) => ({
      n: r.n, major: r.severity === 'major', text: r.text,
      notes: [r.soft ? tk('possible') : null, r.approx ? tk('approx') : null].filter(Boolean),
      sub: r.sub.map((sb) => sentenceText(sb.sentence, sb.item, a)),
    }));
    let footer;
    if (pairsMode) footer = tk('export.footer.pairs', { n: a.count, tol });
    else if (mode === 'half' || mode === 'full') footer = tk('mode.' + mode) + ' · ' + tk('export.footer', { size: tk(s.sizeBody === 'head' ? 'size.body.head' : 'size.' + (s.sizeBody || 'auto')), pin: tk('pin.' + (s.pinBody || 'auto')), tol });
    else if (mode === 'hand') footer = tk('mode.hand') + ' · ' + tk('export.footer', { size: tk('size.' + (s.sizeHand || 'auto')), pin: tk('pin.' + (s.pinHand || 'auto')), tol });
    else if (mode === 'other') footer = tk('mode.other') + ' · ' + tk('count.tol', { name: tol });
    else {
      const pinVal = s.pin === 'custom' && !propOf(A.layers.drawing).customPin ? 'auto' : s.pin;
      footer = tk('export.footer', { size: tk('size.' + s.size), pin: tk('pin.' + pinVal), tol });
    }
    return { title: tk('title'), rows, empty: tk('export.none'), footer };
  }
  /** Draws the report strip, `width` device px wide at pixel ratio k. Returns a canvas, or null when there is nothing to report on. */
  function renderStrip(width, k) {
    const d = stripData();
    if (!d) return null;
    const meas = document.createElement('canvas').getContext('2d');
    const pad = Math.round(14 * k), gap = Math.round(14 * k), fs = 13 * k, fsSub = 11.5 * k, lh = 1.32, tagR = 9.5 * k, tagGap = 8 * k;
    const sans = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    const innerW = width - 2 * pad;
    const cols = clamp(Math.floor((innerW + gap) / (300 * k + gap)), 1, 3), colW = (innerW - (cols - 1) * gap) / cols, textW = colW - 2 * tagR - tagGap;
    // lay out each item
    const items = d.rows.length ? d.rows : [{ n: 0, empty: true, text: d.empty, sub: [], notes: [] }];
    for (const it of items) {
      meas.font = `${it.major ? 600 : 500} ${fs}px ${sans}`;
      it.lines = wrapLines(meas, it.text + (it.notes.length ? ' (' + it.notes.join(', ') + ')' : ''), it.empty ? colW : textW);
      meas.font = `italic 500 ${fsSub}px ${sans}`;
      it.subLines = it.sub.flatMap((sb) => wrapLines(meas, sb, textW - 8 * k));
      it.h = it.lines.length * fs * lh + it.subLines.length * fsSub * lh + 8 * k;
    }
    const rowsH = [];
    for (let i = 0; i < items.length; i += cols) rowsH.push(Math.max(...items.slice(i, i + cols).map((x) => x.h)));
    const titleH = 24 * k;
    // footer: one line, shrunk to fit (two lines when even a small size does not fit)
    let ff = 11.5 * k;
    meas.font = `italic 500 ${ff}px ${sans}`;
    while (meas.measureText(d.footer).width > innerW && ff > 9 * k) { ff -= 0.5 * k; meas.font = `italic 500 ${ff}px ${sans}`; }
    const fLines = meas.measureText(d.footer).width > innerW ? wrapLines(meas, d.footer, innerW) : [d.footer];
    const footH = fLines.length * ff * 1.35 + 10 * k;
    const H = Math.ceil(pad + titleH + rowsH.reduce((s, v) => s + v, 0) + footH + pad * 0.6);
    const c = document.createElement('canvas');
    c.width = Math.round(width); c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = PAPER; x.fillRect(0, 0, c.width, H);
    x.strokeStyle = 'rgba(42,37,33,.55)'; x.lineWidth = Math.max(1, k); x.strokeRect(x.lineWidth / 2, x.lineWidth / 2, c.width - x.lineWidth, H - x.lineWidth);
    // washi tape on top
    x.save(); x.translate(c.width / 2, 2 * k); x.rotate(0.026);
    x.fillStyle = 'rgba(232,205,110,.78)'; x.fillRect(-46 * k, -9 * k, 92 * k, 19 * k);
    x.fillStyle = 'rgba(255,255,255,.28)'; for (let i = -44; i < 44; i += 8) x.fillRect(i * k, -9 * k, 3 * k, 19 * k);
    x.restore();
    // title
    x.textBaseline = 'alphabetic';
    x.fillStyle = INK; x.font = `600 ${17 * k}px ${SERIF}`; x.fillText(d.title, pad, pad + 14 * k);
    // items
    let y = pad + titleH;
    for (let i = 0, r = 0; i < items.length; i += cols, r++) {
      for (let j = 0; j < cols && i + j < items.length; j++) {
        const it = items[i + j], x0 = pad + j * (colW + gap);
        let ty = y + fs * 0.92;
        if (!it.empty) {
          const cx = x0 + tagR, cy = y + tagR + 1 * k;
          x.beginPath(); x.arc(cx, cy, tagR, 0, 6.2832);
          if (it.major) { x.fillStyle = VERMILION; x.fill(); } else { x.fillStyle = HALO; x.fill(); x.strokeStyle = SINOPIA; x.lineWidth = 1.8 * k; x.stroke(); }
          x.fillStyle = it.major ? '#fff' : SINOPIA; x.font = `700 ${(it.n > 9 ? 10 : 11.5) * k}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(it.n), cx, cy + 0.5 * k);
          x.textAlign = 'left'; x.textBaseline = 'alphabetic';
        }
        const tx = it.empty ? x0 : x0 + 2 * tagR + tagGap;
        x.fillStyle = INK; x.font = `${it.major ? 600 : 500} ${fs}px ${sans}`;
        for (const ln of it.lines) { x.fillText(ln, tx, ty); ty += fs * lh; }
        x.fillStyle = 'rgba(42,37,33,.78)'; x.font = `italic 500 ${fsSub}px ${sans}`;
        for (const ln of it.subLines) { x.fillText(ln, tx + 8 * k, ty); ty += fsSub * lh; }
      }
      y += rowsH[r];
    }
    // rule and footer
    x.strokeStyle = 'rgba(42,37,33,.25)'; x.lineWidth = k; x.beginPath(); x.moveTo(pad, y + 2 * k); x.lineTo(width - pad, y + 2 * k); x.stroke();
    x.fillStyle = 'rgba(42,37,33,.85)'; x.font = `italic 500 ${ff}px ${sans}`;
    fLines.forEach((ln, i) => x.fillText(ln, pad, y + 6 * k + ff * (1 + i * 1.35)));
    return c;
  }
  /** For the PNG export: { marks: { drawing, reference } canvases, strip(width) -> canvas|null }, or null when Proportions is closed. */
  function exportParts() {
    if (!S.open) return null;
    drawAll();
    const k = A.panes.drawing.dpr || 1;
    return { marks: { drawing: marks.drawing, reference: marks.reference }, strip: (width) => renderStrip(width, k) };
  }

  // ------------------------------------------------------------------------------------------------------------ keyboard (from app.js)
  function key(e) {
    if (!S.open) return false;
    if (e.shiftKey && (e.key === 'G' || e.key === 'g')) { toggleShow('grid'); return true; }
    return false;
  }

  // ------------------------------------------------------------------------------------------------------------ init
  function sanitise(p) {
    const o = p && typeof p === 'object' ? p : {};
    const pick = (v, list, d) => (list.includes(v) ? v : d);
    return {
      tolerance: pick(o.tolerance, ['strict', 'usual', 'relaxed'], 'usual'), arrows: o.arrows !== false, points: typeof o.points === 'boolean' ? o.points : null, grid: o.grid === true,
      skeleton: o.skeleton !== false, knuckles: o.knuckles !== false, outlineBand: o.outlineBand !== false,
      style: pick(o.style, ['auto', 'realistic', 'stylised'], 'auto'),
      pin: pick(o.pin, ['auto', 'eyes', 'nose', 'chin', 'mouth', 'custom'], 'auto'), size: pick(o.size, ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'], 'auto'),
      pinBody: pick(o.pinBody, ['auto', 'neck', 'hips', 'foot', 'custom'], 'auto'), sizeBody: pick(o.sizeBody, ['auto', 'head', 'torso', 'shoulders', 'height', 'custom'], 'auto'),
      pinHand: pick(o.pinHand, ['auto', 'wrist', 'middleKnuckle', 'custom'], 'auto'), sizeHand: pick(o.sizeHand, ['auto', 'palm', 'hand', 'custom'], 'auto'),
      handSide: pick(o.handSide, ['right', 'left'], 'right'),
      matchTilt: o.matchTilt === true,
    };
  }
  const undoState = () => {
    const s = A.state.prop, dp = A.layers && A.layers.drawing ? propOf(A.layers.drawing) : {};
    return { pin: s.pin, size: s.size, pinBody: s.pinBody, sizeBody: s.sizeBody, pinHand: s.pinHand, sizeHand: s.sizeHand, handSide: s.handSide, matchTilt: s.matchTilt, modeOverride: dp.modeOverride || 'auto' };
  };
  const setUndoState = (u) => {
    if (!u) return;
    Object.assign(A.state.prop, sanitise({ ...A.state.prop, ...u }));
    if (u.modeOverride && A.layers && A.layers.drawing) { propOf(A.layers.drawing).modeOverride = u.modeOverride; propOf(A.layers.drawing).modeKey = pairKey(); }
  };

  function init(api) {
    A = api;
    P = DC.Proportions; LM = DC.Landmarks; i18n = DC.i18n; tk = i18n.tk;
    A.state.prop = sanitise(A.state.prop);
    els.btn = document.getElementById('btn-prop');
    if (els.btn) {
      els.btn.addEventListener('click', toggle);
      const lab = els.btn.querySelector('span'); if (lab) lab.textContent = tk('label');
      els.btn.dataset.tip = tk('tip'); els.btn.dataset.tipOff = tk('tip.off');
    }
    buildPanel();
    for (const s of SLOTS) { ensureCanvas(s); attachPane(s); }
    LM.onstatus(() => { if (S.open) { renderStatus(); } });
    PHONE.addEventListener('change', () => { if (S.open) { applyLayoutRules(); if (!PHONE.matches && S.saved && S.saved.layout) { A.setLayout(S.saved.layout); S.saved.layout = undefined; } renderPanel(); A.requestRender(); setTimeout(() => S.open && refit(false), 80); } });
    new ResizeObserver(() => { if (S.open) A.positionAlignBar(); }).observe(els.root);
    sync();
  }

  DC.PropUI = {
    init, open, close, toggle, escape, key, sync, draw: drawAll, exportParts, tap, soloSlot, imagesChanged, afterRestore, repin, canRepin, sanitise, undoState, setUndoState, labelText,
    persistOverrides: () => (S.open && S.blend && S.saved ? { compareMode: S.saved.compareMode, opacity: S.saved.opacity, overlayTop: S.saved.overlayTop } : {}),
    isOpen: () => S.open, isPlacing: () => !!S.placing, bottomInset: sheetHeight, applyLayoutRules,
    get state() { return S; }, recompute, analysis: () => S.analysis,
  };
})();
