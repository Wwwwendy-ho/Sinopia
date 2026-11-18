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
  };
  const cache = new WeakMap(); // source canvas -> Map(orientKey -> entry)
  const els = {}; // panel elements
  const marks = {}; // per pane: the marks canvas

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
    if (!m.has(key)) m.set(key, { key, promise: null, faces: null, detector: null, error: null, fellBack: false, size: { w: layer.bounds.w, h: layer.bounds.h } });
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
        const res = await LM.detect(orientedCanvas(layer));
        e.faces = res.faces || [];
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
  const isManual = (slot) => { const p = A.layers[slot].prop; return !!(p && p.manual && MANUAL.every((n) => p.manual[n])); };

  function featuresOf(slot) {
    const layer = A.layers[slot], e = entryFor(layer), p = layer.prop;
    let fs = null;
    if (isManual(slot)) {
      const m = p.manual;
      fs = P.fromPoints({ eyeR: m.eyeR, eyeL: m.eyeL, noseBase: m.noseBase, noseTip: m.noseBase, mouthCentre: m.mouthCentre, mouthR: m.mouthCentre, mouthL: m.mouthCentre, chin: m.chin }, 'manual');
    } else if (e && e.faces && e.faces[0]) fs = P.features(e.faces[0].points, e.faces[0].detector);
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
    if (s.side === 'left' || s.side === 'right') { const k2 = key + '.' + s.side; if (i18n.has(k2)) key = k2; }
    const params = {};
    if (s.n !== undefined) params.n = s.n;
    if (s.d !== undefined) params.d = s.d;
    if (/^eye_line_tilted/.test(s.key) && item && a) params.d = tiltDegrees(item, a);
    return tk(key, params);
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

  function recompute(opt = {}) {
    const D = featuresOf('drawing'), R = featuresOf('reference');
    if (!D || !R) { S.analysis = null; return null; }
    let al;
    if (opt.frozen && S.analysis && S.analysis.ok) al = S.analysis.al;
    else al = P.align(D, R, alignOptions(D, R));
    if (!al.ok) { S.analysis = { ok: false, reason: al.reason }; return S.analysis; }
    const report = P.measure(D, R, al, { tolerance: st().tolerance });
    const a = { ok: true, D, R, Dp: P.resolve(D), Rp: P.resolve(R), al, report, grid: null };
    if (st().grid) { try { a.grid = P.distortionGrid(D, R, al); } catch (_) { a.grid = null; } }
    a.view = buildView(report, a);
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
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of Object.values(a.Rp)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const ec = a.al.unit.ecReference;
    const padX = 0.18 * ec, padT = a.Rp.hairline ? 0.1 * ec : 0.55 * ec, padB = 0.18 * ec;
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

  /** Detect (cached) in both images, analyse, and place the drawing; the placement is one Undo step. */
  async function analyseAndPlace({ label } = {}) {
    S.loading = true;
    renderPanel();
    const key = pairKey();
    await Promise.all([detectLayer(A.layers.drawing), detectLayer(A.layers.reference)]);
    if (!S.open || key !== pairKey()) return;
    S.loading = false;
    S.facesBoth = hasFace('drawing') && hasFace('reference');
    const a = recompute();
    renderPanel();
    if (a && a.ok) {
      const S0 = A.snapshotViews();
      const moved = place({ zoom: true, animate: true });
      const lab = label === 'undo.repin' ? label : st().pin === 'auto' ? 'undo.open.auto' : 'undo.pin.' + st().pin;
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
  function setPin(v) {
    changeAlignment(() => { st().pin = v; if (v !== 'custom') delete propOf(A.layers.drawing).customPin; }, 'undo.pin.' + v);
  }
  function setSize(v) {
    changeAlignment(() => {
      st().size = v;
      if (v !== 'custom') delete propOf(A.layers.drawing).customSize;
      else if (!propOf(A.layers.drawing).customSize) { const D = featuresOf('drawing'), R = featuresOf('reference'); if (D && R) propOf(A.layers.drawing).customSize = customSizeOf(D, R); }
    }, 'undo.size.' + v);
  }
  function setTilt(on) { changeAlignment(() => { st().matchTilt = !!on; }, on ? 'undo.tilt.on' : 'undo.tilt.off'); }
  function setTolerance(v) { st().tolerance = v; A.scheduleSave(); recompute(); renderPanel(); A.requestRender(); }
  function toggleShow(k) {
    if (k === 'points') st().points = !showPoints(); else st()[k] = !st()[k];
    if (k === 'grid') recompute();
    A.scheduleSave(); renderPanel(); A.requestRender();
  }
  async function resetPoints() {
    const S0 = A.snapshotViews();
    for (const s of SLOTS) { const p = propOf(A.layers[s]); delete p.edits; delete p.manual; }
    delete propOf(A.layers.drawing).customPin; delete propOf(A.layers.drawing).customSize;
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
    S.analysis = null; S.facesBoth = false; S.sel = null; S.hover = null;
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
    recompute(); renderPanel(); A.requestRender();
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
    els.explain = h('p', { class: 'prop-explain', text: tk('explain'), hidden: true });
    // pickers
    const sel = (id, labelKey, opts, onchange, tipKey) => {
      const select = h('select', { id, 'aria-label': tk(labelKey), onchange: (e) => onchange(e.target.value) });
      const val = h('span', { class: 'prop-chip-val' });
      const lab = h('span', { class: 'prop-chip-lab', text: tk(labelKey === 'pin.label' ? 'chip.pin' : 'chip.size', { value: '' }).replace(/\s+$/, '') });
      const chip = h('label', { class: 'prop-chip prop-picker', 'data-tip': tk(tipKey) }, lab, val, h('i', { class: 'prop-caret', 'aria-hidden': 'true' }), select);
      return { select, val, chip, opts, lab };
    };
    els.pin = sel('prop-pin', 'pin.label', ['auto', 'eyes', 'nose', 'chin', 'mouth', 'custom'], setPin, 'pin.tip');
    els.size = sel('prop-size', 'size.label', ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'], setSize, 'size.tip');
    for (const c of [els.pin, els.size]) {
      const key = c === els.pin ? 'pin.' : 'size.';
      for (const o of c.opts) c.select.append(h('option', { value: o, text: tk(key + o) }));
      c.lab.textContent = tk(c === els.pin ? 'chip.pin' : 'chip.size', { value: '' }).trim();
    }
    els.pickers = h('div', { class: 'prop-pickers' },
      h('div', { class: 'prop-pick' }, h('span', { class: 'prop-pick-lab', text: tk('pin.label') }), els.pin.chip),
      h('div', { class: 'prop-pick' }, h('span', { class: 'prop-pick-lab', text: tk('size.label') }), els.size.chip));
    els.lock = h('p', { class: 'prop-note prop-lock', hidden: true });
    els.status = h('div', { class: 'prop-status' });
    // result
    els.count = h('div', { class: 'prop-count' });
    els.list = h('ul', { class: 'prop-list', 'aria-label': tk('list.label') });
    els.more = h('button', { type: 'button', class: 'btn small quiet prop-more', onclick: () => { S.expanded = !S.expanded; renderPanel(); } });
    els.closeEnough = h('p', { class: 'prop-close-enough' });
    els.none = h('p', { class: 'prop-none' });
    els.result = h('div', { class: 'prop-result' }, els.count, els.list, els.more, els.none, els.closeEnough);
    // show
    const chip = (k) => h('button', { type: 'button', class: 'btn small prop-toggle', 'aria-pressed': 'false', 'data-tip': tk(k + '.tip'), 'data-key': k === 'grid' ? 'Shift+G' : null, onclick: () => toggleShow(k) }, h('span', { text: tk(k) }));
    els.tArrows = chip('arrows'); els.tPoints = chip('points'); els.tGrid = chip('grid');
    els.legend = h('p', { class: 'prop-legend', hidden: true }, h('span', { class: 'sw warm' }), tk('stretched'), h('span', { class: 'sw cool' }), tk('squashed'));
    els.show = h('div', { class: 'prop-show' }, h('span', { class: 'prop-lab', text: tk('show') }), h('div', { class: 'prop-chips' }, els.tArrows, els.tPoints, els.tGrid), els.legend);
    // tolerance
    els.tol = h('fieldset', { class: 'segmented small prop-tol' }, h('legend', { class: 'sr-only', text: tk('tol.label') }));
    for (const k of ['strict', 'usual', 'relaxed']) {
      const input = h('input', { type: 'radio', name: 'prop-tol', id: 'prop-tol-' + k, value: k, onchange: () => setTolerance(k) });
      els.tol.append(input, h('label', { for: 'prop-tol-' + k, 'data-tip': tk('tol.tip'), text: tk('tol.' + k) }));
    }
    els.tolWrap = h('div', { class: 'prop-tolwrap' }, h('span', { class: 'prop-lab', text: tk('tol.label') }), els.tol);
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
    els.tools = h('div', { class: 'prop-tools' }, els.show, els.tolWrap, els.actions);
    els.scroll = h('div', { class: 'prop-scroll' }, els.intro, els.explain, els.pickers, els.lock, els.status, els.result, els.proxies, els.tools, els.pose, els.largest, els.foot);
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
        h('button', { type: 'button', class: 'btn small', 'data-coach': 'cancel', onclick: () => cancelPlacing() }, h('span', { text: tk('coach.cancel') })))),
      h('div', { class: 'coach-main' }, h('div', { class: 'coach-say' }, h('p', { class: 'coach-text' }))));
    els.strip = h('div', { class: 'dot-coach prop-strip', role: 'status', hidden: true }, h('div', { class: 'coach-main' }, h('p', { class: 'coach-text', text: tk('edit.strip') }), h('button', { type: 'button', class: 'btn small primary', onclick: () => setEdit(false), text: tk('edit.done') })));
    A.workspace.append(els.coach, els.strip);
    els.loupe = h('canvas', { class: 'dot-loupe', width: 224, height: 224, hidden: true, 'aria-hidden': 'true' });
    document.body.appendChild(els.loupe);
    els.bubble = h('span', { class: 'prop-bubble-anchor', 'aria-hidden': 'true' });
    document.body.appendChild(els.bubble);
  }
  function icon(id) { const s = document.createElementNS(SVGNS, 'svg'), u = document.createElementNS(SVGNS, 'use'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }
  function setSheet(v, rerender = true) {
    S.sheet = v;
    els.root.dataset.sheet = v;
    els.grab.setAttribute('aria-expanded', String(v !== 'peek'));
    if (rerender) { A.positionAlignBar(); setTimeout(() => { if (S.open) { refit(true); A.positionAlignBar(); } }, 60); }
  }

  /** Everything dynamic in the panel: pickers, status cards, count, list, toggles. Cheap; called after any change. */
  function renderPanel() {
    if (!els.root) return;
    const s = st(), a = S.analysis, ok = !!(a && a.ok);
    // pickers
    const pinVal = s.pin === 'custom' && !propOf(A.layers.drawing).customPin ? 'auto' : s.pin;
    els.pin.select.value = pinVal; els.size.select.value = s.size;
    els.pin.val.textContent = tk('pin.' + pinVal); els.size.val.textContent = tk('size.' + s.size);
    els.pin.select.querySelector('option[value="custom"]').hidden = pinVal !== 'custom';
    els.pickers.hidden = !ok && !S.analysis; // hidden until there is something to measure
    els.pickers.classList.toggle('is-off', !ok);
    for (const sel of [els.pin.select, els.size.select]) sel.disabled = !ok;
    // lock note
    const notes = [];
    if (ok) {
      for (const k of a.al.locked) {
        const bySize = (a.al.size.used === 'eyeChin' && k === 'chin_length') || (a.al.size.used === 'eyeSpacing' && k === 'eye_spacing');
        const key = (bySize ? 'lock.size.' : 'lock.pin.') + k;
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
    els.tGrid.setAttribute('aria-pressed', String(!!s.grid));
    els.legend.hidden = !s.grid;
    for (const input of els.tol.querySelectorAll('input')) input.checked = input.value === s.tolerance;
    els.cTilt.checked = !!s.matchTilt;
    els.bEdit.setAttribute('aria-pressed', String(S.edit));
    els.bEdit.textContent = S.edit ? tk('edit.done') : tk('edit');
    els.strip.hidden = !(S.open && S.edit);
    // pose and detector notes
    els.pose.hidden = !ok;
    if (ok) {
      const differs = a.report.pose && a.report.pose.differs;
      els.pose.className = 'prop-pose' + (differs ? ' warn' : '');
      els.pose.textContent = tk(differs ? 'pose.differs' : 'pose.same');
    }
    const faces = (slot) => { const e = entryFor(A.layers[slot]); return e && e.faces ? e.faces.length : 0; };
    els.largest.hidden = !(ok && (faces('drawing') > 1 || faces('reference') > 1));
    els.root.dataset.state = ok ? 'ok' : S.pending ? 'busy' : S.placing ? 'placing' : 'empty';
    els.root.dataset.sheet = S.sheet;
    renderProxies();
  }

  function renderStatus() {
    const box = els.status;
    box.textContent = '';
    const a = S.analysis;
    const ok = !!(a && a.ok);
    const lm = LM.status;
    if (S.loading || S.pending > 0 || (lm === 'loading' && !a)) {
      box.append(h('div', { class: 'prop-busy' }, h('i', { class: 'prop-spin', 'aria-hidden': 'true' }), h('div', {}, h('strong', { text: tk('finding') }), lm === 'loading' ? h('p', { class: 'prop-note', text: tk('downloading') }) : null)));
      return;
    }
    // the detector used (basic detector notice)
    const dE = entryFor(A.layers.drawing), rE = entryFor(A.layers.reference);
    const basic = [dE, rE].some((e) => e && e.fellBack);
    if (a === null || (a && !a.ok)) {
      const noD = !hasFace('drawing') && !isManual('drawing'), noR = !hasFace('reference') && !isManual('reference');
      const failed = LM.status === 'failed' || (dE && dE.error && !dE.faces.length && LM.status === 'failed');
      let title, hint;
      if (failed) { title = tk('failed'); hint = null; }
      else if (noD && noR) { title = tk('noface.both'); hint = tk('noface.hint.both'); }
      else if (noD) { title = tk('noface.draw'); hint = tk('noface.hint'); }
      else if (noR) { title = tk('noface.ref'); hint = tk('noface.hint'); }
      else { title = tk('failed'); hint = null; }
      if (S.analysis === null && (noD || noR || failed)) {
        box.append(h('div', { class: 'prop-card' }, h('strong', { text: title }), hint ? h('p', { text: hint }) : null,
          h('div', { class: 'prop-card-btns' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => startPlacing(), text: tk('place') }),
            failed ? null : h('button', { type: 'button', class: 'btn small', onclick: () => compareOutlines(), text: tk('outlines') }))));
      }
    }
    if (basic) box.append(h('p', { class: 'prop-note prop-basic', text: tk('fallback') }));
    if (ok) {
      const man = SLOTS.filter((s) => isManual(s));
      if (man.length) box.append(h('p', { class: 'prop-note', text: tk('manual.used', { which: tk(man[0] === 'drawing' ? 'which.draw' : 'which.ref') }) }));
    }
  }

  function renderResult(a) {
    const rows = a.view.rows, shown = S.expanded ? rows : rows.slice(0, MAX_ROWS);
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
    els.more.hidden = rows.length <= MAX_ROWS;
    els.more.textContent = S.expanded ? tk('fewer') : tk('more', { n: rows.length - MAX_ROWS });
    els.none.hidden = rows.length > 0;
    if (!rows.length) els.none.textContent = st().tolerance === 'strict' ? '' : tk('none.try');
    els.none.classList.toggle('empty', !els.none.textContent);
    const close = a.view.close.map((g) => tk('noun.' + g));
    els.closeEnough.hidden = !close.length;
    els.closeEnough.textContent = close.length ? tk('close.enough', { list: i18n.list(close) }) : '';
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
  function placingSlot() {
    const noD = !hasFace('drawing') && !isManual('drawing'), noR = !hasFace('reference') && !isManual('reference');
    return noD && noR ? 'reference' : noD ? 'drawing' : noR ? 'reference' : 'drawing';
  }
  function startPlacing() {
    const slot = placingSlot();
    if (A.layers[slot].hidden) A.setHidden(slot, false);
    S.placing = { slot, i: 0, pts: {}, S0: A.snapshotViews() };
    S.edit = false;
    A.state.active = slot;
    A.syncUI();
    renderPanel(); renderCoach(); A.requestRender();
  }
  function cancelPlacing() {
    if (!S.placing) return;
    S.placing = null; els.coach.hidden = true;
    renderPanel(); A.requestRender(); A.syncUI();
  }
  function placingBack() {
    const p = S.placing;
    if (!p) return;
    if (p.i > 0) { p.i--; delete p.pts[MANUAL[p.i]]; renderCoach(); A.requestRender(); } else cancelPlacing();
  }
  function renderCoach() {
    const p = S.placing;
    els.coach.hidden = !p;
    if (!p) return;
    const which = tk(p.slot === 'drawing' ? 'which.draw' : 'which.ref');
    els.coach.querySelector('.coach-step').textContent = tk('coach.title');
    els.coach.querySelector('.coach-text').textContent = tk(A.IS_TOUCH ? 'coach.step' : 'coach.step.click', { i: p.i + 1, n: MANUAL.length, part: tk('coach.part.' + MANUAL[p.i]), which });
    els.coach.querySelector('[data-coach="back"]').hidden = false;
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
    if (!overlay() && paneSlot !== p.slot) { A.toast(tk(A.IS_TOUCH ? 'coach.step' : 'coach.step.click', { i: p.i + 1, n: MANUAL.length, part: tk('coach.part.' + MANUAL[p.i]), which: tk(p.slot === 'drawing' ? 'which.draw' : 'which.ref') })); return true; }
    const L = A.layers[p.slot], sz = sizeOfSlot(p.slot);
    const o = fromLp(L, { width: 0, height: 0 }, x, y); // pane-centred input: pane size cancels
    const pt = { x: o.x + sz.w / 2, y: o.y + sz.h / 2 };
    if (pt.x < 0 || pt.y < 0 || pt.x > sz.w || pt.y > sz.h) return true;
    p.pts[MANUAL[p.i]] = pt;
    p.i++;
    if (p.i >= MANUAL.length) finishPlacing(); else { renderCoach(); A.requestRender(); }
    return true;
  }
  function finishPlacing() {
    const p = S.placing;
    S.placing = null; els.coach.hidden = true;
    const S0 = p.S0;
    propOf(A.layers[p.slot]).manual = clone(p.pts);
    delete propOf(A.layers[p.slot]).edits;
    const a = recompute();
    if (a && a.ok) { place({ zoom: true, animate: true }); commit(S0, 'undo.manual'); A.toast(tk('coach.done')); } else renderPanel();
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
    if (!a || !a.ok) return;
    const Ld = A.layers.drawing, Lr = A.layers.reference, ov = overlay();
    const dShow = slot === 'drawing' && !Ld.hidden && !A.showingPrev();
    const rShow = (ov ? slot === 'drawing' : slot === 'reference') && !Lr.hidden;
    if (!dShow && !rShow) return;
    const eD = entryFor(Ld).size, eR = entryFor(Lr).size;
    const dPos = (p) => lp(Ld, pane, { x: p.x - eD.w / 2, y: p.y - eD.h / 2 });
    const rPos = (p) => lp(Lr, pane, { x: p.x - eR.w / 2, y: p.y - eR.h / 2 });
    const row = selRow(), dim = !!row, s = st();
    const edited = (slotName, name) => { const p = A.layers[slotName].prop; return !!(p && ((p.edits && p.edits[name]) || (p.manual && p.manual[name]))); };
    const hits = S.hits[slot];
    const hitR = A.IS_TOUCH ? 22 : 9;

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

  function drawPlacing(ctx, slot, pane, W, H) {
    const p = S.placing;
    if (!p) return;
    const L = A.layers[p.slot], sz = sizeOfSlot(p.slot);
    if (!(overlay() ? slot === 'drawing' : slot === p.slot)) return;
    MANUAL.forEach((name, i) => {
      const pt = p.pts[name];
      if (!pt) return;
      const q = lp(L, pane, { x: pt.x - sz.w / 2, y: pt.y - sz.h / 2 });
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
    body.addEventListener('pointerleave', () => { hideBubble(); setCursor(slot, false); });
  }
  const setCursor = (slot, on) => { A.panes[slot].canvas.style.cursor = on ? 'move' : ''; };

  let hoverTimer = 0, hoverHit = null;
  function onHover(slot, e) {
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
    const which = tk(hit.who === 'drawing' ? 'pt.drawing' : 'pt.reference'), nm = tk('pt.' + hit.name), p = A.layers[hit.who].prop;
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
      const store = isManual(h0.who) ? (propOf(L).manual) : edits(L);
      store[h0.name] = { x: o.x + sz.w / 2, y: o.y + sz.h / 2 };
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
    if (d.picked || d.touch) drawLoupe(d, e);
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
    if (h0.kind === 'pt') commit(d.S0, 'undo.moved', { point: lc(tk('pt.' + h0.name)) }, !moved);
    else if (h0.kind === 'pin') commit(d.S0, 'undo.pin.custom', null, false);
    else commit(d.S0, 'undo.size.custom', null, false);
    renderPanel(); A.requestRender(); A.syncUI(); announceTop();
  }
  function announceTop() {
    const a = S.analysis;
    if (!a || !a.ok) return;
    const top = a.view.rows[0] ? a.view.rows[0].text : '';
    if (top && top !== S.announcedTop) { S.announcedTop = top; els.live.textContent = ''; setTimeout(() => { els.live.textContent = tk('announce.one', { sentence: top }); }, 30); }
  }
  function drawLoupe(d, e) {
    const pane = A.panes[d.slot], q = localPt(d.slot, e), k = pane.dpr, Sz = 44.8, ctx = els.loupe.getContext('2d');
    ctx.fillStyle = '#7f7d79'; ctx.fillRect(0, 0, 224, 224);
    ctx.imageSmoothingEnabled = true;
    for (const cv of [pane.canvas, marks[d.slot]]) { try { ctx.drawImage(cv, (q.x - Sz / 2) * k, (q.y - Sz / 2) * k, Sz * k, Sz * k, 0, 0, 224, 224); } catch (_) { /* nothing to show */ } }
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
      const b = h('button', { type: 'button', class: 'prop-proxy', 'data-who': who, 'data-name': name, 'aria-label': tk('pt.name', { name: tk('pt.' + name), which: tk(who === 'drawing' ? 'pt.drawing' : 'pt.reference') }), 'data-tip': tk('pt.hint') });
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
    const store = isManual(who) ? propOf(L).manual : edits(L);
    store[name] = { x: cur.x + dx, y: cur.y + dy };
    recompute({ frozen: true }); renderPanelLight(); A.requestRender();
    clearTimeout(nudge.t);
    nudge.t = setTimeout(() => {
      const n = nudge; nudge = null;
      const a2 = recompute(); let moved = false;
      if (a2 && a2.ok) moved = place({ animate: true });
      commit(n.S0, 'undo.moved', { point: lc(tk('pt.' + n.name)) }, !moved);
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
      pin: pick(o.pin, ['auto', 'eyes', 'nose', 'chin', 'mouth', 'custom'], 'auto'), size: pick(o.size, ['auto', 'head', 'eyeChin', 'eyeSpacing', 'custom'], 'auto'), matchTilt: o.matchTilt === true,
    };
  }
  const undoState = () => { const s = A.state.prop; return { pin: s.pin, size: s.size, matchTilt: s.matchTilt }; };
  const setUndoState = (u) => { if (u) Object.assign(A.state.prop, sanitise({ ...A.state.prop, ...u })); };

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
    init, open, close, toggle, escape, key, sync, draw: drawAll, tap, soloSlot, imagesChanged, afterRestore, repin, canRepin, sanitise, undoState, setUndoState, labelText,
    persistOverrides: () => (S.open && S.blend && S.saved ? { compareMode: S.saved.compareMode, opacity: S.saved.opacity, overlayTop: S.saved.overlayTop } : {}),
    isOpen: () => S.open, isPlacing: () => !!S.placing, bottomInset: sheetHeight, applyLayoutRules,
    get state() { return S; }, recompute, analysis: () => S.analysis,
  };
})();
