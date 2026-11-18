// Face landmarks for the Proportions check. Lazy and self-hosted: nothing is downloaded until detect() / load() is called.
//
//   DC.Landmarks.detect(canvasOrImage, opts?) -> Promise<{ faces, detector, ms, fellBack, error? }>
//       faces: [{ points: [{x,y}...], score, box: {x,y,w,h}, detector: 'mediapipe'|'faceapi' }], largest first,
//       in the SOURCE image's pixel coordinates (478 points for 'mediapipe', 68 for 'faceapi'). No face -> faces: [].
//       opts: { detector: 'auto'|'mediapipe'|'faceapi' (default 'auto': MediaPipe, face-api only if MediaPipe cannot load or run),
//               maxSide: 640, numFaces: 3, minConfidence: 0.25 }
//   DC.Landmarks.status   'idle' | 'loading' | 'ready' | 'fallback' | 'failed'
//                         ready = MediaPipe loaded; fallback = MediaPipe failed, the face-api tiny model is used; failed = neither
//   DC.Landmarks.ready    boolean (status === 'ready' || 'fallback')
//   DC.Landmarks.load()   Promise<'mediapipe'|'faceapi'|null>: start loading (idempotent, cached)
//   DC.Landmarks.onstatus(fn) -> unsubscribe; fn({ status, detail })
//   DC.Landmarks.reset()  forget a failure so the next call tries again
//
// MediaPipe Face Landmarker (tasks-vision 0.10.21, float16 model, Apache-2.0) runs on CPU/WASM (about 17 ms per image in the
// benchmark). The GPU delegate is deliberately not used: it differs per device and driver, and CPU is already fast.
// Files: vendor/mediapipe/ (ES module bundle + wasm) and models/face/face_landmarker.task. See vendor/mediapipe/README.md.
(() => {
  'use strict';
  const DC = window.DrawingCompare = window.DrawingCompare || {};
  const base = new URL('../', (document.currentScript && document.currentScript.src) || document.baseURI);
  const MP_TIMEOUT = 60000;
  let status = 'idle', loading = null, landmarker = null, failure = null, faQueue = Promise.resolve(), faModels = null;
  const listeners = new Set();
  function setStatus(s, detail) { status = s; listeners.forEach(fn => { try { fn({ status: s, detail }); } catch (_) { /* listener errors are theirs */ } }); }

  // ---- MediaPipe
  function loadMediaPipe(minConfidence, numFaces) {
    if (!loading) {
      setStatus('loading');
      loading = (async () => {
        const mod = await import(new URL('vendor/mediapipe/vision_bundle.mjs', base).href);
        const fileset = await mod.FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', base).href.replace(/\/?$/, ''));
        landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: new URL('models/face/face_landmarker.task', base).href, delegate: 'CPU' },
          runningMode: 'IMAGE', numFaces: numFaces || 3,
          minFaceDetectionConfidence: minConfidence, minFacePresenceConfidence: minConfidence, minTrackingConfidence: minConfidence,
          outputFaceBlendshapes: false,
        });
        return landmarker;
      })();
      let timer;
      const guard = Promise.race([loading, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('MediaPipe load timed out')), MP_TIMEOUT); })]);
      loading = guard.then(v => { clearTimeout(timer); setStatus('ready'); return v; },
        e => { clearTimeout(timer); failure = e; landmarker = null; setStatus('fallback', String(e && e.message || e)); throw e; });
      loading.catch(() => {}); // surfaced through detect()'s fallback, never as an unhandled rejection
    }
    return loading;
  }

  // ---- face-api tiny (fallback)
  function loadFaceApi() {
    if (!faModels) {
      faModels = (async () => {
        if (!window.faceapi) await new Promise((res, rej) => {
          const s = document.createElement('script'); s.src = new URL('vendor/face-api/face-api.min.js', base); s.onload = res; s.onerror = () => rej(new Error('face-api script')); document.head.appendChild(s);
        });
        await faceapi.tf.setBackend('cpu'); await faceapi.tf.ready();
        const dir = new URL('models/face/', base).href;
        await Promise.all([faceapi.nets.tinyFaceDetector.isLoaded ? 0 : faceapi.nets.tinyFaceDetector.loadFromUri(dir), faceapi.nets.faceLandmark68TinyNet.isLoaded ? 0 : faceapi.nets.faceLandmark68TinyNet.loadFromUri(dir)]);
        return true;
      })().catch(e => { faModels = null; throw e; });
    }
    return faModels;
  }

  // ---- input handling
  function sizeOf(src) { return { w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height }; }
  function view(src, maxSide) {
    const { w, h } = sizeOf(src), k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, kx: w / c.width, ky: h / c.height, w, h };
  }
  const boxOf = pts => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
  const area = f => f.box.w * f.box.h;

  function runMediaPipe(v) {
    const r = landmarker.detect(v.canvas), out = [];
    for (const lm of (r.faceLandmarks || [])) {
      const pts = lm.map(p => ({ x: p.x * v.canvas.width * v.kx, y: p.y * v.canvas.height * v.ky }));
      out.push({ points: pts, score: 1, box: boxOf(pts), detector: 'mediapipe' }); // the Face Landmarker reports no per-face score
    }
    return out;
  }
  async function runFaceApi(src, v) {
    // Prefer the app's own serialized, cached face-api path when it is present.
    if (DC.Subjects && DC.Subjects.analyze) {
      const entry = await DC.Subjects.analyze({ source: v.canvas, rotation: 0, flipH: false, flipV: false });
      return (entry.faces || []).map(f => ({ points: f.points.map(p => ({ x: p.x * v.kx, y: p.y * v.ky })), score: f.score, box: { x: f.box.x * v.kx, y: f.box.y * v.ky, w: f.box.w * v.kx, h: f.box.h * v.ky }, detector: 'faceapi' }));
    }
    await loadFaceApi();
    const run = async () => {
      const chain = o => faceapi.detectAllFaces(v.canvas, o).withFaceLandmarks(true);
      let found = await chain(new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.22 }));
      if (!found.length) found = await chain(new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.18 }));
      return found.map(f => ({ points: f.landmarks.positions.map(p => ({ x: p.x * v.kx, y: p.y * v.ky })), score: f.detection.score, box: { x: f.detection.box.x * v.kx, y: f.detection.box.y * v.ky, w: f.detection.box.width * v.kx, h: f.detection.box.height * v.ky }, detector: 'faceapi' }));
    };
    const job = faQueue.then(run); faQueue = job.then(() => undefined, () => undefined); return job;
  }

  async function detect(input, opts) {
    const o = Object.assign({ detector: 'auto', maxSide: 640, numFaces: 3, minConfidence: 0.25 }, opts || {});
    if (input && input.decode && !(input.complete && input.naturalWidth)) { try { await input.decode(); } catch (_) { /* fall through to the size check */ } }
    const { w, h } = sizeOf(input || {});
    if (!w || !h) return { faces: [], detector: null, ms: 0, fellBack: false, error: 'empty image' };
    const v = view(input, o.maxSide), t0 = performance.now();
    let error = null, fellBack = false;
    if (o.detector !== 'faceapi') {
      try {
        await loadMediaPipe(o.minConfidence, o.numFaces);
        const faces = runMediaPipe(v).sort((a, b) => area(b) - area(a));
        return { faces, detector: 'mediapipe', ms: performance.now() - t0, fellBack: false };
      } catch (e) { error = String(e && e.message || e); if (o.detector === 'mediapipe') return { faces: [], detector: null, ms: performance.now() - t0, fellBack: false, error }; fellBack = true; }
    }
    try {
      const faces = (await runFaceApi(input, v)).sort((a, b) => area(b) - area(a));
      if (status !== 'ready' && o.detector === 'auto' && status !== 'fallback') setStatus('fallback', error || 'face-api requested');
      return { faces, detector: 'faceapi', ms: performance.now() - t0, fellBack, error };
    } catch (e) { setStatus('failed', String(e && e.message || e)); return { faces: [], detector: null, ms: performance.now() - t0, fellBack, error: String(e && e.message || e) }; }
  }

  DC.Landmarks = {
    detect,
    load: async (opts) => { try { await loadMediaPipe((opts && opts.minConfidence) || 0.25, (opts && opts.numFaces) || 3); return 'mediapipe'; } catch (_) { try { await loadFaceApi(); return 'faceapi'; } catch (e) { setStatus('failed', String(e && e.message || e)); return null; } } },
    onstatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { loading = null; landmarker = null; failure = null; faModels = null; setStatus('idle'); },
    get status() { return status; },
    get ready() { return status === 'ready' || status === 'fallback'; },
    get failure() { return failure; },
    base: base.href,
  };
})();
