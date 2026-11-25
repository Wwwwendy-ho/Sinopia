// Body, hand and outline-mask detectors for the Proportions check (phase 3). Lazy and self-hosted: nothing is downloaded until
// pose() / hands() / segment() / loadTask() is called, and each model is fetched only when ITS mode is first used.
// Adds to window.DrawingCompare.Landmarks (js/landmarks.js, the face loader, is untouched; this file must be loaded AFTER it because landmarks.js assigns DC.Landmarks).
//
//   DC.Landmarks.pose(input, opts?) -> Promise<{ poses, model, ms, retried, error? }>
//       poses: [{ points: [{x,y,z,visibility} x33], world: [{x,y,z,visibility} x33] (metres, hip-centred), box:{x,y,w,h}, score }],
//       largest first, in the SOURCE image's pixel coordinates (MediaPipe's 33 BlazePose points; odd indexes = the person's left).
//       No pose -> poses: [].
//       opts: { model: 'auto'|'full'|'lite' (default 'auto': full, lite when the full model fails to load or navigator.deviceMemory < 4),
//               maxSide: 1024, numPoses: 3, minConfidence: 0.3,
//               crop: {x,y,w,h} | null   subject box in source px; if the whole image finds no pose, retry once on this box padded 1.4x,
//               cropFirst: false         use the padded crop first (when the caller knows the subject box) }
//       Pose segmentation masks are deliberately NOT requested (they abort on the CPU wasm build).
//   DC.Landmarks.hands(input, opts?) -> Promise<{ hands, ms, error? }>
//       hands: [{ points: [{x,y,z} x21], world: [...], label: 'Left'|'Right' (MediaPipe's own label: it assumes a camera image, so it
//       flips for mirrored or drawn hands; callers should take handedness from the pose or the thumb side), score, box }], largest first.
//       opts: { maxSide: 1024, numHands: 2, minConfidence: 0.3, crop: {x,y,w,h} (source px; points come back in source px) }
//   DC.Landmarks.segment(input, opts?) -> Promise<{ mask: Uint8Array (1 = person), width, height, kx, ky, ms, error? }>
//       Selfie segmenter (256x256 float16), person mask at the working size (opts.maxSide, default 512); kx, ky = source px per mask px.
//   DC.Landmarks.loadTask('pose'|'hand'|'segment') -> Promise<boolean>   start loading one task (idempotent)
//   DC.Landmarks.taskStatus(task) -> 'idle'|'loading'|'ready'|'failed'
//   DC.Landmarks.onTaskStatus(fn) -> unsubscribe; fn({ task, status, detail })
//   DC.Landmarks.resetTask(task?)   forget a failure so the next call tries again
//
// Same tasks-vision 0.10.21 bundle and wasm as the face loader (vendor/mediapipe/), CPU delegate, 60 s load timeout.
// Models (Apache-2.0, see vendor/mediapipe/README.md): models/pose/pose_landmarker_{full,lite}.task, models/hand/hand_landmarker.task,
// models/segment/selfie_segmenter.tflite.
(() => {
  'use strict';
  const DC = window.DrawingCompare = window.DrawingCompare || {};
  const L = DC.Landmarks = DC.Landmarks || {};
  const base = new URL('../', (document.currentScript && document.currentScript.src) || document.baseURI);
  const TIMEOUT = 60000;
  const FILES = {
    'pose:full': 'models/pose/pose_landmarker_full.task', 'pose:lite': 'models/pose/pose_landmarker_lite.task',
    hand: 'models/hand/hand_landmarker.task', segment: 'models/segment/selfie_segmenter.tflite',
  };
  const state = { pose: 'idle', hand: 'idle', segment: 'idle' };
  const listeners = new Set(), tasks = {}, loaders = {};
  let visionP = null;
  const emit = (task, status, detail) => { state[task] = status; listeners.forEach(fn => { try { fn({ task, status, detail }); } catch (_) { /* listener errors are theirs */ } }); };

  function vision() { // one shared bundle import + fileset (the browser caches the module; the face loader imports the same URL)
    if (!visionP) visionP = (async () => {
      const mod = await import(new URL('vendor/mediapipe/vision_bundle.mjs', base).href);
      const fileset = await mod.FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', base).href.replace(/\/?$/, ''));
      return { mod, fileset };
    })().catch(e => { visionP = null; throw e; });
    return visionP;
  }
  const withTimeout = (p, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' load timed out')), TIMEOUT); })]).finally(() => clearTimeout(t)); };

  function create(kind, key, opt) { // kind: 'pose' | 'hand' | 'segment'; key: cache key
    if (!loaders[key]) {
      emit(kind, 'loading');
      loaders[key] = withTimeout((async () => {
        const { mod, fileset } = await vision();
        const baseOptions = { modelAssetPath: new URL(FILES[key], base).href, delegate: 'CPU' };
        if (kind === 'pose') return mod.PoseLandmarker.createFromOptions(fileset, { baseOptions, runningMode: 'IMAGE', numPoses: opt.numPoses, minPoseDetectionConfidence: opt.minConfidence, minPosePresenceConfidence: opt.minConfidence, minTrackingConfidence: opt.minConfidence, outputSegmentationMasks: false });
        if (kind === 'hand') return mod.HandLandmarker.createFromOptions(fileset, { baseOptions, runningMode: 'IMAGE', numHands: opt.numHands, minHandDetectionConfidence: opt.minConfidence, minHandPresenceConfidence: opt.minConfidence, minTrackingConfidence: opt.minConfidence });
        return mod.ImageSegmenter.createFromOptions(fileset, { baseOptions, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
      })(), kind + ' model').then(v => { tasks[key] = v; emit(kind, 'ready'); return v; },
        e => { delete loaders[key]; emit(kind, 'failed', String(e && e.message || e)); throw e; });
      loaders[key].catch(() => {});
    }
    return loaders[key];
  }

  // ---- input handling
  const sizeOf = src => ({ w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height });
  async function ready(input) { if (input && input.decode && !(input.complete && input.naturalWidth)) { try { await input.decode(); } catch (_) { /* size check follows */ } } }
  // draws region (sx,sy,sw,sh) of src at most maxSide px on its long side, on white
  function view(src, maxSide, region) {
    const s = sizeOf(src), r = region || { x: 0, y: 0, w: s.w, h: s.h }, k = Math.min(1, maxSide / Math.max(r.w, r.h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high';
    x.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return { canvas: c, ox: r.x, oy: r.y, kx: r.w / c.width, ky: r.h / c.height };
  }
  const padBox = (b, f, W, H) => { const cx = b.x + b.w / 2, cy = b.y + b.h / 2, w = b.w * f, h = b.h * f, x0 = Math.max(0, cx - w / 2), y0 = Math.max(0, cy - h / 2), x1 = Math.min(W, cx + w / 2), y1 = Math.min(H, cy + h / 2); return { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) }; };
  const boxOf = pts => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

  // ---- pose
  function poseModelOrder(model) {
    if (model === 'full' || model === 'lite') return [model];
    const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    return mem && mem < 4 ? ['lite'] : ['full', 'lite'];
  }
  async function pose(input, opts) {
    const o = Object.assign({ model: 'auto', maxSide: 1024, numPoses: 3, minConfidence: 0.3, crop: null, cropFirst: false }, opts || {});
    await ready(input);
    const { w, h } = sizeOf(input || {});
    if (!w || !h) return { poses: [], model: null, ms: 0, retried: false, error: 'empty image' };
    const t0 = performance.now(); let landmarker = null, model = null, error = null;
    for (const m of poseModelOrder(o.model)) {
      try { landmarker = await create('pose', 'pose:' + m, o); model = m; error = null; break; } catch (e) { error = String(e && e.message || e); }
    }
    if (!landmarker) return { poses: [], model: null, ms: performance.now() - t0, retried: false, error };
    const run = region => {
      const v = view(input, o.maxSide, region), r = landmarker.detect(v.canvas), out = [];
      (r.landmarks || []).forEach((lm, i) => {
        const wl = (r.worldLandmarks && r.worldLandmarks[i]) || [];
        const points = lm.map(p => ({ x: v.ox + p.x * v.canvas.width * v.kx, y: v.oy + p.y * v.canvas.height * v.ky, z: p.z, visibility: p.visibility === undefined ? 1 : p.visibility }));
        const vis = points.filter(p => p.visibility >= 0.5);
        out.push({ points, world: wl.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })), box: boxOf(vis.length ? vis : points), score: points.reduce((s, p) => s + p.visibility, 0) / points.length });
      });
      return out.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
    };
    const cropBox = o.crop ? padBox(o.crop, 1.4, w, h) : null;
    let poses = [], retried = false;
    try {
      if (o.cropFirst && cropBox) { poses = run(cropBox); retried = true; }
      if (!poses.length) poses = run(null);
      if (!poses.length && cropBox && !o.cropFirst) { poses = run(cropBox); retried = true; }
    } catch (e) { error = String(e && e.message || e); }
    return { poses, model, ms: performance.now() - t0, retried, error };
  }

  // ---- hands
  async function hands(input, opts) {
    const o = Object.assign({ maxSide: 1024, numHands: 2, minConfidence: 0.3, crop: null }, opts || {});
    await ready(input);
    const { w, h } = sizeOf(input || {});
    if (!w || !h) return { hands: [], ms: 0, error: 'empty image' };
    const t0 = performance.now();
    try {
      const lm = await create('hand', 'hand', o), v = view(input, o.maxSide, o.crop ? padBox(o.crop, 1, w, h) : null), r = lm.detect(v.canvas), out = [];
      (r.landmarks || []).forEach((l, i) => {
        const points = l.map(p => ({ x: v.ox + p.x * v.canvas.width * v.kx, y: v.oy + p.y * v.canvas.height * v.ky, z: p.z }));
        const hd = r.handedness && r.handedness[i] && r.handedness[i][0];
        out.push({ points, world: ((r.worldLandmarks && r.worldLandmarks[i]) || []).map(p => ({ x: p.x, y: p.y, z: p.z })), label: hd ? hd.categoryName : null, score: hd ? hd.score : null, box: boxOf(points) });
      });
      return { hands: out.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h), ms: performance.now() - t0 };
    } catch (e) { return { hands: [], ms: performance.now() - t0, error: String(e && e.message || e) }; }
  }

  // ---- person mask
  async function segment(input, opts) {
    const o = Object.assign({ maxSide: 512 }, opts || {});
    await ready(input);
    const { w, h } = sizeOf(input || {});
    if (!w || !h) return { mask: null, width: 0, height: 0, kx: 1, ky: 1, ms: 0, error: 'empty image' };
    const t0 = performance.now();
    try {
      const seg = await create('segment', 'segment', o), v = view(input, o.maxSide), r = seg.segment(v.canvas), cm = r.categoryMask;
      const arr = cm.getAsUint8Array(), mw = cm.width, mh = cm.height, W = v.canvas.width, H = v.canvas.height, mask = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = arr[Math.min(mh - 1, Math.floor(y * mh / H)) * mw + Math.min(mw - 1, Math.floor(x * mw / W))] > 0 ? 1 : 0;
      if (r.close) r.close();
      return { mask, width: W, height: H, kx: v.kx, ky: v.ky, ms: performance.now() - t0 };
    } catch (e) { return { mask: null, width: 0, height: 0, kx: 1, ky: 1, ms: performance.now() - t0, error: String(e && e.message || e) }; }
  }

  const kindOf = t => (t === 'pose' || t === 'hand' || t === 'segment') ? t : null;
  Object.assign(L, {
    pose, hands, segment,
    loadTask: async (task, opts) => {
      const k = kindOf(task); if (!k) return false;
      try {
        if (k === 'pose') { const o = Object.assign({ numPoses: 3, minConfidence: 0.3 }, opts || {}); let err; for (const m of poseModelOrder(o.model || 'auto')) { try { await create('pose', 'pose:' + m, o); return true; } catch (e) { err = e; } } throw err; }
        await create(k, k, Object.assign({ numHands: 2, minConfidence: 0.3 }, opts || {})); return true;
      } catch (_) { return false; }
    },
    taskStatus: task => state[task] || 'idle',
    onTaskStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    resetTask(task) { for (const k of Object.keys(loaders)) if (!task || k === task || k.startsWith(task + ':')) { delete loaders[k]; delete tasks[k]; } for (const t of (task ? [task] : Object.keys(state))) if (state[t] === 'failed') state[t] = 'idle'; },
    MODEL_FILES: FILES,
  });
})();
