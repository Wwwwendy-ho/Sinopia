// Automatic subject landmarks and contours. Models and inference stay on this device.
// Every candidate is a similarity transform: features are never individually warped.
(() => {
  'use strict';
  const DC = window.DrawingCompare, A = DC.Aligner;
  const structural = A.estimate, rasterize = A.rasterize, core = A.estimateStructure;
  const base = new URL('../', document.currentScript.src);
  const inputs = new WeakMap(), analyses = new WeakMap(), outlines = new WeakMap();
  let models, inferenceQueue = Promise.resolve();
  const orientKey = image => `${image.rotation}|${+image.flipH}|${+image.flipV}`;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const cancelledResult = () => ({ confident: false, approximate: false, cancelled: true });

  A.rasterize = function(image, maxSide) {
    const raster = rasterize(image, maxSide);
    inputs.set(raster, { source: image.source, rotation: image.rotation, flipH: image.flipH, flipV: image.flipV });
    return raster;
  };

  function loadModels() {
    if (!models) {
      let timer;
      const loading = (async () => {
        if (!window.faceapi) await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = new URL('vendor/face-api/face-api.min.js', base);
          script.onload = resolve; script.onerror = reject;
          document.head.appendChild(script);
        });
        // CPU works on Safari and on devices without a usable WebGL context.
        await faceapi.tf.setBackend('cpu');
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(new URL('models/face/', base).href),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(new URL('models/face/', base).href),
        ]);
        return true;
      })().catch(() => false);
      // A failed or stalled model download must not prevent ordinary image matching.
      models = Promise.race([loading, new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })])
        .finally(() => clearTimeout(timer));
    }
    return models;
  }

  function canvasFor(image, maxSide = 640) {
    const { source, rotation, flipH, flipV } = image;
    const turned = rotation % 180 !== 0, width = turned ? source.height : source.width, height = turned ? source.width : source.height;
    const k = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * k)); canvas.height = Math.max(1, Math.round(height * k));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(canvas.width / width, canvas.height / height);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1); ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return { canvas, width, height };
  }

  function toSource(p, image, width, height) {
    let x = (p.x - width / 2) * (image.flipH ? -1 : 1), y = (p.y - height / 2) * (image.flipV ? -1 : 1);
    const angle = image.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    return { x: c * x + s * y + image.source.width / 2, y: -s * x + c * y + image.source.height / 2 };
  }

  function entryFor(image) {
    let orientations = analyses.get(image.source);
    if (!orientations) analyses.set(image.source, orientations = new Map());
    const key = orientKey(image);
    if (!orientations.has(key)) orientations.set(key, { faces: null, round: null, promise: null });
    return orientations.get(key);
  }

  async function analyze(image) {
    const entry = entryFor(image);
    if (!entry.promise) {
      // TensorFlow's tiny CPU models share a backend; serialize to bound mobile memory.
      const run = async () => {
        const view = canvasFor(image);
        entry.width = view.width; entry.height = view.height;
        // Round contours and silhouettes are only needed when no face decides the match (or for an outline
        // without a face), so they are computed on first use instead of for every image.
        let small = null;
        const lazy = (key, compute) => Object.defineProperty(entry, key, {
          configurable: true, enumerable: true,
          get() { const value = compute(small || (small = A.rasterize(image, 160))); Object.defineProperty(entry, key, { value, writable: true, configurable: true, enumerable: true }); return value; },
          set(value) { Object.defineProperty(entry, key, { value, writable: true, configurable: true, enumerable: true }); },
        });
        lazy('round', roundObjects); lazy('silhouettes', silhouettes);
        entry.faces = [];
        if (await loadModels()) {
          await pause();
          let found = await faceapi.detectAllFaces(view.canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.22 })).withFaceLandmarks(true);
          if (!found.length) {
            await pause();
            found = await faceapi.detectAllFaces(view.canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.18 })).withFaceLandmarks(true);
          }
          const kx = view.width / view.canvas.width, ky = view.height / view.canvas.height;
          entry.faces = found.map(face => ({
            score: face.detection.score,
            box: { x: face.detection.box.x * kx, y: face.detection.box.y * ky, w: face.detection.box.width * kx, h: face.detection.box.height * ky },
            points: face.landmarks.positions.map(p => ({ x: p.x * kx, y: p.y * ky })),
          })).filter(face => saneFace(face));
        }
        return entry;
      };
      entry.promise = inferenceQueue.then(run).catch(() => { entry.faces = []; return entry; });
      inferenceQueue = entry.promise.then(() => undefined);
    }
    return entry.promise;
  }

  const mean = points => ({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length });
  function anchors(face) {
    const p = face.points;
    // Each feature gets one vote; the many lip points cannot outweigh both eyes.
    return [mean(p.slice(36, 42)), mean(p.slice(42, 48)), p[30], mean([p[48], p[54]]), p[8], p[0], p[16], mean(p.slice(17, 22)), mean(p.slice(22, 27))];
  }
  function saneFace(face) {
    if (face.points.length !== 68 || !face.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
    const p = anchors(face), eyes = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), size = Math.hypot(face.box.w, face.box.h);
    return eyes > size * .09 && eyes < size * .65 && Math.hypot(p[4].x - p[2].x, p[4].y - p[2].y) > size * .12;
  }
  function dominant(faces) {
    const sorted = faces.slice().sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
    if (!sorted.length || (sorted[1] && sorted[0].box.w * sorted[0].box.h < sorted[1].box.w * sorted[1].box.h * 1.7)) return null;
    return sorted[0];
  }

  // Weighted least-squares similarity. `maxTheta` caps the rotation: 0 fits scale and translation alone
  // (theta fixed at 0, closed form), a positive cap clamps the best rotation and refits the scale for it.
  function fit(points, targets, weights, maxTheta = 0) {
    let sum = 0, mx = 0, my = 0, fx = 0, fy = 0;
    for (let i = 0; i < points.length; i++) { const w = weights[i]; sum += w; mx += points[i].x * w; my += points[i].y * w; fx += targets[i].x * w; fy += targets[i].y * w; }
    if (sum < 2) return null;
    mx /= sum; my /= sum; fx /= sum; fy /= sum;
    let den = 0, re = 0, im = 0;
    for (let i = 0; i < points.length; i++) {
      const x = points[i].x - mx, y = points[i].y - my, u = targets[i].x - fx, v = targets[i].y - fy, w = weights[i];
      den += w * (x * x + y * y); re += w * (x * u + y * v); im += w * (x * v - y * u);
    }
    if (den < 1e-6) return null;
    let a = re / den, b = im / den;
    if (maxTheta <= 0) b = 0; // s = sum(w p.q) / sum(w |p|^2): the optimum for theta = 0
    else if (Math.abs(Math.atan2(b, a)) > maxTheta) {
      const theta = Math.sign(b) * maxTheta, c = Math.cos(theta), sn = Math.sin(theta), s = Math.max(0, (c * re + sn * im) / den);
      a = s * c; b = s * sn;
    }
    return { s: Math.hypot(a, b), theta: Math.atan2(b, a), tx: fx - a * mx + b * my, ty: fy - b * mx - a * my };
  }
  const distance = (r, p, q) => Math.hypot(r.s * (Math.cos(r.theta) * p.x - Math.sin(r.theta) * p.y) + r.tx - q.x, r.s * (Math.sin(r.theta) * p.x + Math.cos(r.theta) * p.y) + r.ty - q.y);
  function fitFace(moving, fixed, mv, fv, maxTheta = 0, struct = null) {
    const points = anchors(moving), targets = anchors(fixed), size = Math.hypot(fixed.box.w, fixed.box.h), threshold = size * .085;
    let best = null, bestCount = 0, bestError = Infinity;
    // Consensus prevents a misplaced mouth or a guessed jaw from steering the whole fit.
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const weights = points.map((_, k) => +(k === i || k === j));
      const r = fit(points, targets, weights, maxTheta); if (!r) continue;
      const errors = points.map((p, k) => distance(r, p, targets[k]));
      const count = errors.filter(e => e < threshold).length, error = errors.reduce((s, e) => s + Math.min(e, threshold), 0);
      if (count > bestCount || (count === bestCount && error < bestError)) { best = r; bestCount = count; bestError = error; }
    }
    if (!best || bestCount < 6) return null;
    for (let pass = 0; pass < 3; pass++) {
      const weights = points.map((p, i) => { const e = distance(best, p, targets[i]); return e > threshold * 1.8 ? 0 : Math.min(1, threshold * .5 / Math.max(e, 1)); });
      const next = fit(points, targets, weights, maxTheta); if (next) best = next;
    }
    const errors = points.map((p, i) => distance(best, p, targets[i])), inliers = errors.filter(e => e <= threshold);
    // Need several internal features; allow one misplaced feature to remain visibly wrong.
    if (inliers.length < 6 || errors.slice(0, 4).filter(e => e <= threshold).length < 3) return null;
    if (best.s < .08 || best.s > 12 || Math.abs(best.theta) > maxTheta + 1e-9) return null;
    const error = Math.sqrt(inliers.reduce((s, e) => s + e * e, 0) / inliers.length) / size;
    // The same consensus fit with the rotation left free: how much tilt the cap leaves unmodelled.
    const free = fit(points, targets, points.map((p, i) => { const e = distance(best, p, targets[i]); return e > threshold * 1.8 ? 0 : Math.min(1, threshold * .5 / Math.max(e, 1)); }), Math.PI);
    const evidence = faceEvidence(moving, fixed, points, targets, errors, inliers.length, best, free, mv, fv, struct);
    const c = Math.cos(best.theta), s = Math.sin(best.theta);
    best.tx += best.s * (c * mv.width / 2 - s * mv.height / 2) - fv.width / 2;
    best.ty += best.s * (s * mv.width / 2 + c * mv.height / 2) - fv.height / 2;
    const base = { ...best, method: 'face-landmarks', landmarkError: error, inliers: inliers.length, evidence };
    // Calibration mode (benchmark only) keeps every fit as an uncertain one and records its evidence.
    if (DC.Subjects?.calibrate) return { ...base, confident: false, approximate: true };
    const verdict = decideFace(evidence);
    if (verdict.reject) return { ...base, confident: false, approximate: false, rejected: true, why: verdict.why };
    return { ...base, confident: verdict.confident, approximate: !verdict.confident, why: verdict.why };
  }

  // ---- Confidence of a face fit. It rests on evidence that predicts a correct alignment, not on the detector's
  // own score (photo scores of 0.3-0.7 are common and say little about where the landmarks are):
  //  * fit residual of the nine anchors, in inter-ocular distances (IOD) of the reference face, and the inlier count;
  //  * plausibility: the faces must coincide in size and place after the mapping, and the drawing must keep a sane size;
  //  * head pose: a turned head (nose off-centre between the eyes and the jaw sides) gives unreliable landmarks;
  //  * unmodelled tilt: the rotation the fit would take if it were free, beyond what auto-align is allowed to apply;
  //  * agreement with an independent check, the structural edge matcher, when that one is itself confident;
  //  * the detector score only as a soft term with a low floor.
  // Thresholds were calibrated on half of the benchmark cases (CUFS, FS2K) and checked on the other half;
  // see review/automatic-subject-alignment.md.
  const THRESH = {
    nInMin: 7, eyeMax: .16, noseMax: .25, rmsMax: .09, scoreFloor: .2, scoreSoft: .5, rmsSoft: .06,
    yawMax: .15, tiltMax: 2.5, agreeMax: .3,
    faceRelMin: .55, faceRelMax: 1.8, iouMin: .3, faceInMin: .6, relMin: .15, relMax: 6.5,
    sRelFaceMin: .7, sMfInMin: .5,
  };
  const r3 = v => Math.round(v * 1000) / 1000;
  const eyeCentres = face => [mean(face.points.slice(36, 42)), mean(face.points.slice(42, 48))];
  /** Head pose proxies, from the landmarks alone: the nose's offset from the eye midpoint (in IOD) and the left/right jaw asymmetry. */
  function pose(face) {
    const p = face.points, [l, r] = eyeCentres(face), iod = Math.hypot(r.x - l.x, r.y - l.y) || 1;
    const ux = (r.x - l.x) / iod, uy = (r.y - l.y) / iod, along = q => (q.x - l.x) * ux + (q.y - l.y) * uy;
    const nose = along(p[30]), a = nose - along(p[0]), b = along(p[16]) - nose;
    return { iod, eye: (nose - iod / 2) / iod, jaw: (a - b) / Math.max(1e-6, a + b) };
  }
  const bbox = pts => ({ x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) });
  const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = a => Math.max(1e-9, (a.x1 - a.x0) * (a.y1 - a.y0));
  const boxOf = b => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
  /** Apply a similarity (s, theta, tx, ty) to a point. */
  const mapPoint = (t, p) => ({ x: t.s * (Math.cos(t.theta) * p.x - Math.sin(t.theta) * p.y) + t.tx, y: t.s * (Math.sin(t.theta) * p.x + Math.cos(t.theta) * p.y) + t.ty });
  const mapBox = (t, box) => bbox([[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].map(([x, y]) => mapPoint(t, { x, y })));
  /** A centred, oriented-pixel transform (what the matchers return) as one from top-left raw coordinates. */
  const rawOf = (t, mv, fv) => { const c = Math.cos(t.theta), s = Math.sin(t.theta); return { s: t.s, theta: t.theta, tx: t.tx + fv.width / 2 - t.s * (c * mv.width / 2 - s * mv.height / 2), ty: t.ty + fv.height / 2 - t.s * (s * mv.width / 2 + c * mv.height / 2) }; };

  /** Evidence about a face fit (raw top-left coordinates). Only numbers: it is stored with benchmark results. */
  function faceEvidence(moving, fixed, points, targets, errors, inliers, best, free, mv, fv, struct) {
    const pf = pose(fixed), pm = pose(moving), iod = pf.iod, ev = {};
    ev.iod = r3(iod);
    ev.e = errors.map(e => r3(e / iod));
    ev.nIn = inliers;
    const good = errors.filter(e => e <= Math.hypot(fixed.box.w, fixed.box.h) * .085);
    ev.rms = r3(Math.sqrt(good.reduce((s, e) => s + e * e, 0) / Math.max(1, good.length)) / iod);
    ev.sc = [r3(moving.score), r3(fixed.score)];
    ev.yaw = [r3(pm.eye), r3(pm.jaw), r3(pf.eye), r3(pf.jaw)];
    ev.tilt = r3((free ? Math.abs(free.theta - best.theta) : 0) * 180 / Math.PI);
    ev.thetaFree = r3(free ? free.theta * 180 / Math.PI : 0);
    const frame = { x0: 0, y0: 0, x1: fv.width, y1: fv.height }, drawing = mapBox(best, { x0: 0, y0: 0, x1: mv.width, y1: mv.height });
    ev.rel = r3(best.s * Math.max(mv.width, mv.height) / Math.max(fv.width, fv.height));
    ev.ovl = r3(overlap(drawing, frame) / area(drawing));
    const face = mapBox(best, boxOf(moving.box)), fbox = boxOf(fixed.box), inter = overlap(face, fbox);
    ev.faceRel = r3(best.s * Math.hypot(moving.box.w, moving.box.h) / Math.hypot(fixed.box.w, fixed.box.h));
    ev.iou = r3(inter / (area(face) + area(fbox) - inter));
    ev.faceIn = r3(overlap(face, frame) / area(face));
    ev.faceFrac = r3(Math.hypot(fixed.box.w, fixed.box.h) / Math.hypot(fv.width, fv.height));
    if (struct && Number.isFinite(struct.s)) {
      const raw = rawOf(struct, mv, fv);
      ev.struct = { c: +!!struct.confident, a: +!!struct.approximate, ncc: r3(struct.ncc), psr: r3(struct.psr), s: r3(struct.s), th: r3(struct.theta), tx: r3(struct.tx), ty: r3(struct.ty),
        d: r3(points.reduce((s, p) => s + Math.hypot(mapPoint(raw, p).x - mapPoint(best, p).x, mapPoint(raw, p).y - mapPoint(best, p).y), 0) / points.length / iod) };
    }
    return ev;
  }

  /** Decision for a face fit from its evidence: { reject } (implausible: discarded), { confident } (applied) or neither (offered). */
  function decideFace(ev, T = THRESH) {
    const why = [], plausible = ev.faceRel >= T.faceRelMin && ev.faceRel <= T.faceRelMax && ev.iou >= T.iouMin && ev.faceIn >= T.faceInMin && ev.rel >= T.relMin && ev.rel <= T.relMax;
    if (!plausible) return { reject: true, confident: false, why: ['implausible-placement'] };
    const yaw = Math.max(...ev.yaw.map(Math.abs)), score = Math.min(...ev.sc);
    if (ev.nIn < T.nInMin) why.push('few-inliers');
    if (Math.max(ev.e[0], ev.e[1]) > T.eyeMax || ev.e[2] > T.noseMax) why.push('eyes-nose-off');
    if (ev.rms > T.rmsMax) why.push('residual');
    if (score < T.scoreFloor || (score < T.scoreSoft && ev.rms > T.rmsSoft)) why.push('weak-detection');
    if (yaw > T.yawMax) why.push('turned-head');
    if (ev.tilt > T.tiltMax) why.push('unmodelled-tilt');
    if (ev.struct && ev.struct.c && ev.struct.d > T.agreeMax) why.push('structure-disagrees');
    return { reject: false, confident: !why.length, why };
  }

  /** Structure-matcher plausibility against the faces found: where the drawing lands relative to the reference face. */
  function structFeatures(st, mf, ff, mv, fv) {
    const raw = rawOf(st, mv, fv), drawing = mapBox(raw, { x0: 0, y0: 0, x1: mv.width, y1: mv.height }), out = {};
    if (ff) {
      const b = boxOf(ff.box);
      out.relFace = r3(st.s * Math.hypot(mv.width, mv.height) / Math.hypot(ff.box.w, ff.box.h));
      out.covers = +((b.x0 + b.x1) / 2 >= drawing.x0 && (b.x0 + b.x1) / 2 <= drawing.x1 && (b.y0 + b.y1) / 2 >= drawing.y0 && (b.y0 + b.y1) / 2 <= drawing.y1);
    }
    if (mf) { const face = mapBox(raw, boxOf(mf.box)); out.mfIn = r3(overlap(face, { x0: 0, y0: 0, x1: fv.width, y1: fv.height }) / area(face)); }
    return out;
  }
  /** The structural result as an automatic match: refused where it puts the drawing implausibly against a found face,
   * and only offered when both images show a face that the landmark fit could not use (a method switch). */
  function decideStructural(st, sf, conflict, T = THRESH) {
    if (!st || !(st.confident || st.approximate)) return { confident: false, approximate: false, why: ['no-match'] };
    if ((sf.relFace != null && (sf.relFace < T.sRelFaceMin || !sf.covers)) || (sf.mfIn != null && sf.mfIn < T.sMfInMin)) return { confident: false, approximate: false, why: ['implausible-placement'] };
    if (st.confident && conflict) return { confident: false, approximate: true, why: ['faces-not-matched'] };
    return { confident: st.confident, approximate: !st.confident, why: [] };
  }

  // Closed ellipse contours: gradient components nominate candidates, circumference support verifies them.
  // No semantic claim is made about the object: this identifies a round boundary, including a ball.
  function roundObjects(raster) {
    const { w, h, data, k } = raster, mag = new Float32Array(w * h);
    let peak = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, gx = data[i + 1] - data[i - 1], gy = data[i + w] - data[i - w];
      peak = Math.max(peak, mag[i] = Math.hypot(gx, gy));
    }
    if (peak < .07) return [];
    const threshold = Math.max(.045, peak * .18), visited = new Uint8Array(w * h), candidates = [];
    for (let start = 0; start < mag.length; start++) {
      if (visited[start] || mag[start] < threshold) continue;
      visited[start] = 1; const stack = [start]; let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); count++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, n = ny * w + nx;
          if (nx <= 0 || nx >= w - 1 || ny <= 0 || ny >= h - 1 || visited[n] || mag[n] < threshold) continue;
          visited[n] = 1; stack.push(n);
        }
      }
      const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (count < 30 || Math.min(rx, ry) < 9 || rx / ry < .55 || rx / ry > 1.8 || x0 < 3 || y0 < 3 || x1 > w - 4 || y1 > h - 4) continue;
      let hits = 0, aligned = 0;
      for (let n = 0; n < 96; n++) {
        const t = n * Math.PI / 48, cos = Math.cos(t), sin = Math.sin(t);
        let found = false, radial = false;
        for (let d = -2; d <= 2; d++) {
          const x = Math.round(cx + (rx + d) * cos), y = Math.round(cy + (ry + d) * sin), i = y * w + x;
          if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1 || mag[i] < threshold) continue;
          found = true;
          const gx = data[i + 1] - data[i - 1], gy = data[i + w] - data[i - w], nx = cos / rx, ny = sin / ry;
          if (Math.abs(gx * nx + gy * ny) / (Math.hypot(gx, gy) * Math.hypot(nx, ny)) > .8) radial = true;
        }
        hits += +found; aligned += +radial;
      }
      if (hits / 96 < .85 || aligned / 96 < .75) continue;
      const candidate = { cx: (cx - w / 2) * k, cy: (cy - h / 2) * k, rx: rx * k, ry: ry * k, support: aligned / 96 };
      if (!candidates.some(c => Math.hypot(c.cx - candidate.cx, c.cy - candidate.cy) < Math.min(c.rx, c.ry) * .15)) candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.rx * b.ry - a.rx * a.ry);
  }
  function fitRound(mv, fv) { // scale and translation only: a round contour has no rotation to find
    const a = mv.round?.[0], b = fv.round?.[0];
    if (!a || !b || (mv.round[1] && mv.round[1].rx * mv.round[1].ry > a.rx * a.ry * .6) || (fv.round[1] && fv.round[1].rx * fv.round[1].ry > b.rx * b.ry * .6)) return null;
    // Uniform scaling only; different ellipse proportions remain visible to the artist.
    if (Math.abs(Math.log((a.rx / a.ry) / (b.rx / b.ry))) > .14) return null;
    const s = Math.sqrt(b.rx * b.ry / (a.rx * a.ry));
    if (s < .08 || s > 12) return null;
    return { s, theta: 0, tx: b.cx - s * a.cx, ty: b.cy - s * a.cy, confident: false, approximate: true, method: 'round-contour' };
  }

  // Border-connected background removal also pairs closed sketch outlines with filled objects.
  // This is deliberately limited to clear, enclosed subjects; cluttered scenes use structural matching.
  function silhouettes(raster) {
    const { w, h, data, k } = raster, barrier = new Uint8Array(w * h), outside = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      barrier[i] = +(Math.hypot(data[i + 1] - data[i - 1], data[i + w] - data[i - w]) > .07);
    }
    const stack = [];
    const push = i => { if (!outside[i] && !barrier[i]) { outside[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    const seen = new Uint8Array(w * h), found = [];
    for (let start = 0; start < outside.length; start++) {
      if (outside[start] || seen[start]) continue;
      const todo = [start], pixels = []; seen[start] = 1;
      let x0 = w, x1 = 0, y0 = h, y1 = 0, sx = 0, sy = 0;
      while (todo.length) {
        const i = todo.pop(), x = i % w, y = (i / w) | 0;
        pixels.push(i); sx += x; sy += y; x0 = Math.min(x0,x); x1 = Math.max(x1,x); y0 = Math.min(y0,y); y1 = Math.max(y1,y);
        for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (n >= 0 && !outside[n] && !seen[n]) { seen[n] = 1; todo.push(n); }
        }
      }
      const area = pixels.length, width = x1 - x0 + 1, height = y1 - y0 + 1;
      if (area < w * h * .025 || area > w * h * .65 || width < 16 || height < 16 || area / (width * height) < .35 || x0 < 3 || y0 < 3 || x1 > w - 4 || y1 > h - 4) continue;
      const cx = sx / area, cy = sy / area, mask = new Uint8Array(w * h);
      for (const i of pixels) mask[i] = 1;
      if (!mask[Math.round(cy) * w + Math.round(cx)]) continue;
      const radii = [], points = [];
      for (let n = 0; n < 128; n++) {
        const a = n * Math.PI / 64, c = Math.cos(a), s = Math.sin(a); let radius = 0;
        for (let r = 0; r < Math.max(w,h); r += .5) {
          const x = Math.round(cx + r * c), y = Math.round(cy + r * s);
          if (x < 0 || x >= w || y < 0 || y >= h || !mask[y * w + x]) break;
          radius = r;
        }
        radii.push(radius / Math.sqrt(area));
        points.push({ x: (cx + radius * c - w / 2) * k, y: (cy + radius * s - h / 2) * k });
      }
      if (Math.min(...radii) < .08) continue;
      found.push({ cx: (cx - w / 2) * k, cy: (cy - h / 2) * k, area: area * k * k, radii, points });
    }
    return found.sort((a,b) => b.area - a.area);
  }
  function dominantShape(shapes) {
    return shapes?.length && (!shapes[1] || shapes[0].area > shapes[1].area * 1.7) ? shapes[0] : null;
  }
  function fitSilhouette(mv, fv, maxTheta = 0) {
    const a = dominantShape(mv.silhouettes), b = dominantShape(fv.silhouettes);
    if (!a || !b) return null;
    const error = shift => {
      let sum = 0;
      for (let i = 0; i < 128; i++) {
        const p = (i + shift + 128) % 128, j = Math.floor(p), t = p - j;
        const delta = a.radii[i] - ((1 - t) * b.radii[j] + t * b.radii[(j + 1) % 128]); sum += delta * delta;
      }
      return Math.sqrt(sum / 128);
    };
    // The radial profile is cyclic, so a rotation is a shift of it (pi/64 per step). With no rotation
    // allowed only shift 0 is compared; a cap limits the search to shifts within it.
    const maxShift = Math.min(21, Math.floor(maxTheta / (Math.PI / 64) + 1e-9));
    let best = { shift: 0, error: error(0) };
    for (let shift = -maxShift; shift <= maxShift; shift++) {
      const e = error(shift);
      if (e < best.error - .0005) best = { shift, error: e };
    }
    const coarse = best.shift;
    for (let shift = coarse - 1; maxShift && shift <= coarse + 1; shift += .125) {
      if (Math.abs(shift) * Math.PI / 64 > maxTheta + 1e-9) continue;
      const e = error(shift); if (e < best.error) best = { shift, error: e };
    }
    if (best.error > .035) return null;
    const s = Math.sqrt(b.area / a.area), theta = best.shift * Math.PI / 64;
    if (s < .08 || s > 12) return null;
    return { s, theta, tx: b.cx - s * (Math.cos(theta) * a.cx - Math.sin(theta) * a.cy), ty: b.cy - s * (Math.sin(theta) * a.cx + Math.cos(theta) * a.cy), confident: false, approximate: true, method: 'subject-silhouette', contourError: best.error };
  }

  function cropFace(image, face) {
    const view = canvasFor(image, 1024), sx = view.canvas.width / view.width, sy = view.canvas.height / view.height;
    const b = face.box, x = Math.max(0, b.x - b.w * .2), y = Math.max(0, b.y - b.h * .2);
    const w = Math.min(view.width - x, b.w * 1.4), h = Math.min(view.height - y, b.h * 1.4);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(16, Math.round(w * sx)); canvas.height = Math.max(16, Math.round(h * sy));
    canvas.getContext('2d').drawImage(view.canvas, x * sx, y * sy, w * sx, h * sy, 0, 0, canvas.width, canvas.height);
    return { raster: A.rasterize({ source: canvas, rotation: 0, flipH: false, flipV: false }), x: x + w / 2 - view.width / 2, y: y + h / 2 - view.height / 2, kx: w / canvas.width };
  }
  /** Landmark fit, or another estimator guided by the faces found. `getStruct` resolves the structural edge match,
   * which was started alongside the face detection and doubles as the independent check of a landmark fit. */
  async function guidedCandidate(mi, fi, mv, fv, report, maxTheta, getStruct) {
    const mf = dominant(mv.faces || []), ff = dominant(fv.faces || []), context = { mf, ff, conflict: false };
    if (mf && ff) {
      const st = await getStruct(), landmark = fitFace(mf, ff, mv, fv, maxTheta, st);
      if (landmark?.evidence.struct && st) Object.assign(landmark.evidence.struct, structFeatures(st, mf, ff, mv, fv));
      if (landmark && !landmark.rejected) return { candidate: landmark, context };
      context.conflict = true; // two faces were found but the landmark fit is unusable: not a place for a confident edge match
    }
    // A face found only in the reference can still tell the sketch matcher where to look.
    if (!mf && ff && core) {
      const crop = cropFace(fi, ff), r = await core(rasterize(mi), crop.raster, report, { maxRotation: maxTheta });
      if (r.confident) return { candidate: { ...r, s: r.s * crop.kx, tx: r.tx * crop.kx + crop.x, ty: r.ty * crop.kx + crop.y, confident: false, approximate: true, method: 'reference-face-region' }, context };
    }
    // Faces take precedence over circular contours such as eyes or eyeglass lenses.
    if (!mf && !ff) return { candidate: fitRound(mv, fv) || fitSilhouette(mv, fv, maxTheta), context };
    return { candidate: null, context };
  }

  A.estimate = async function(moving, fixed, onProgress, options = {}) {
    // options.maxRotation (radians): the largest rotation any estimator may return. Default 0: scale and
    // translation only, for every path (landmarks, contours, silhouettes, edge matching, regions).
    const maxTheta = Math.max(0, Number(options.maxRotation) || 0), structOptions = { maxRotation: maxTheta };
    const mi = inputs.get(moving), fi = inputs.get(fixed);
    if (!mi || !fi) return structural(moving, fixed, onProgress, structOptions);
    let cancelled = false;
    const report = p => { if (onProgress?.(p) === false) cancelled = true; return !cancelled; };
    if (!report(.01)) return cancelledResult();
    // The structural match runs in its worker while the face detector uses the main thread; it is the fallback
    // and the independent check of a landmark fit, and is computed once per call (never again for a retake).
    let structProgress = null, struct = null;
    const getStruct = () => struct || (struct = core
      ? core(moving, fixed, p => structProgress?.(p), structOptions).catch(() => null)
      : structural(moving, fixed, p => structProgress?.(p), structOptions).catch(() => null));
    try {
      // Retakes are photos of the same paper: a precise structural match comes first.
      if (options.preferStructure && core) {
        struct = core(moving, fixed, p => report(p * .1), structOptions);
        const precise = await struct;
        if (cancelled) return cancelledResult();
        if (precise.confident) return precise;
      } else getStruct();
      const mv = await analyze(mi); if (!report(.12)) return cancelledResult();
      const fv = await analyze(fi); if (!report(.24)) return cancelledResult();
      const { candidate, context } = await guidedCandidate(mi, fi, mv, fv, p => report(.24 + p * .15), maxTheta, getStruct);
      if (cancelled) return cancelledResult();
      if (candidate) { report(1); return cancelled ? cancelledResult() : candidate; }
      structProgress = p => report(.4 + p * .6);
      const st = await getStruct();
      if (cancelled) return cancelledResult();
      if (!st) return structural(moving, fixed, p => report(.4 + p * .6), structOptions);
      const features = structFeatures(st, context.mf, context.ff, mv, fv), verdict = decideStructural(st, features, context.conflict);
      report(1);
      return { ...st, confident: verdict.confident, approximate: verdict.approximate, method: 'structural', why: verdict.why,
        evidence: { struct: { c: +!!st.confident, a: +!!st.approximate, ncc: r3(st.ncc), psr: r3(st.psr), conflict: +context.conflict, ...features } } };
    } catch (error) { console.warn('Subject matching unavailable; using structural alignment.', error); }
    if (cancelled) return cancelledResult();
    return structural(moving, fixed, p => report(.4 + p * .6), structOptions);
  };

  function subjectOutline(layer, detail, hex) {
    const entry = entryFor(layer);
    if (!entry.faces) {
      if (!entry.outlineRequested) {
        entry.outlineRequested = true;
        analyze({ source: layer.source, rotation: layer.rotation, flipH: layer.flipH, flipV: layer.flipV }).then(() => DC.app?.render());
      }
      return null;
    }
    const face = dominant(entry.faces);
    if (entry.faces.length && !face) return null; // several comparable people: keep the general edge view
    const round = !face && entry.round?.[0];
    if (round && entry.round[1] && entry.round[1].rx * entry.round[1].ry > round.rx * round.ry * .6) return null;
    const shape = !face && !round && dominantShape(entry.silhouettes);
    if ((!face || face.score < .5) && !round && !shape) return null;
    const key = `${orientKey(layer)}|${hex}|${detail > .55}`;
    let cache = outlines.get(layer.source); if (!cache) outlines.set(layer.source, cache = new Map());
    if (cache.has(key)) return cache.get(key);
    const c = document.createElement('canvas'), k = Math.min(1, 1024 / Math.max(layer.source.width, layer.source.height));
    c.width = Math.round(layer.source.width * k); c.height = Math.round(layer.source.height * k);
    const ctx = c.getContext('2d'); ctx.strokeStyle = hex; ctx.lineWidth = Math.max(1.2, Math.max(c.width, c.height) / 600); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // Landmark contours are estimates, shown dashed instead of pretending to trace every pixel.
    ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 1.8]);
    const line = (points, closed = false) => {
      ctx.beginPath(); points.forEach((p, i) => { const q = toSource(p, layer, entry.width, entry.height); ctx[i ? 'lineTo' : 'moveTo'](q.x * k, q.y * k); });
      if (closed) ctx.closePath(); ctx.stroke();
    };
    if (face && face.score >= .5) {
      const p = face.points;
      for (const [a, b, closed] of [[0, 17, false], [17, 22, false], [22, 27, false], [27, 31, false], [31, 36, false], [36, 42, true], [42, 48, true], [48, 60, true]]) line(p.slice(a, b), closed);
      if (detail > .55) line(p.slice(60, 68), true);
    } else if (round) {
      line(Array.from({ length: 96 }, (_, i) => ({ x: entry.width / 2 + round.cx + round.rx * Math.cos(i * Math.PI / 48), y: entry.height / 2 + round.cy + round.ry * Math.sin(i * Math.PI / 48) })), true);
    } else if (shape) {
      line(shape.points.map(p => ({ x: p.x + entry.width / 2, y: p.y + entry.height / 2 })), true);
    }
    if (cache.size >= 2) cache.delete(cache.keys().next().value);
    cache.set(key, c); return c;
  }
  DC.Subjects = { analyze, fitFace, fitRound, roundObjects, silhouettes, fitSilhouette, outline: subjectOutline, anchors, toSource,
    thresholds: THRESH, decideFace, decideStructural, structFeatures, pose, calibrate: false };
})();
