# Sinopia: handoff

Sinopia is a free, browser-only tool for artists: load a photo of your drawing and a reference image, compare them (side by side, stacked, overlaid with Tint/Blend/Wipe/Outline), line them up, and get a "Proportions" report that names proportion and placement mistakes in plain words ("Nose 8% too long", "Eyes 4% too close together"). Images never leave the device.

- Live site: https://wwwwendy-ho.github.io/Sinopia/ (GitHub Pages, branch `main`, repo root)
- Repo: https://github.com/Wwwwendy-ho/Sinopia
- Owner: Wwwwendy-ho. The owner approves design directions from snapshots and approves pushes.

This zip contains:
- `app/` the CURRENT local code, which is AHEAD of the live site (see "State" below). Large model/runtime files are excluded (see "Model files").
- `design/` the UX specs, decision records and approved snapshot mock-ups.
- `bench/` the test bench (pages, scripts, result summaries) used to measure everything.
- `datasets-info/` where the test datasets came from and how to re-download them (datasets themselves are NOT included: research-only licences and ~3.9 GB).

---

## 1. Tech overview

- Plain HTML/CSS/JS, no build step, no framework. Classic `<script defer>` files that attach to `window.DrawingCompare` (alias `DC`). `index.html` loads them in order; bump the `?v=` cache-buster when you change a file (GitHub Pages caches ~10 min).
- Rendering: one canvas per pane (`js/pane.js`), layers with similarity transforms (`js/layer.js`), app wiring in `js/app.js` (big).
- Persistence: IndexedDB via `js/storage.js` and per-slot photo "shelves" (`js/shelf.js`, up to 12 photos each). DO NOT rename `DB_NAME` in storage.js (users would lose saved photos).
- i18n: `js/i18n.js` (legacy text-matching) plus `js/prop-i18n.js` (key-based `DC.i18n.t('prop.key', {n})`, whole-sentence templates) in en, zh-Hans, zh-Hant, es, fr. Every new user-visible string must exist in all five.
- Home-screen app: `manifest.webmanifest`, `icons/`, Apple tags in `<head>`. Don't break these.
- Sounds: `js/sound.js` (interaction sounds, on by default for users).

### Auto-align (`js/align.js`, `js/align-regions.js`, `js/subjects.js`)
- Estimates scale + translation only (rotation OFF by default; setting "Allow rotation in auto-align", cap 15 deg; retakes may rotate up to 10 deg).
- Uncertain results are OFFERED (Apply / Preview / Dismiss panel), never applied silently. Confidence rule documented in `review/automatic-subject-alignment.md`.
- Persistent Undo/Redo bar with a 12-step alignment history (Z / Shift+Z).

### Proportions check, faces (live)
- `js/landmarks.js`: lazy MediaPipe Face Landmarker (tasks-vision 0.10.21, self-hosted in `vendor/mediapipe/` + `models/face/face_landmarker.task`), face-api tiny fallback. Nothing downloads on page load; the model loads the first time Proportions is opened.
- `js/proportions.js`: features, robust L1 (IRLS) scale+translation fit ("Robust auto"), pin options, midline tilt frame, per-feature measures in % of eye-to-chin with detector bias + gain correction, tolerance presets, distortion grid (thin-plate spline), knock-on grouping, sentence data (keys + numbers, no English).
- `js/prop-ui.js`, `css/proportions.css`: report column (desktop) / bottom sheet (phone), marks canvas, editable points, pin/size pickers, Undo steps, manual point coaches.
- Method, tolerances, bias/gain tables and validation: `review/proportions-engine.md`.

### Phase 3 engines (local only, NO UI yet)
- `js/landmarks-body.js` (lazy Pose Landmarker, Hand Landmarker, selfie segmenter), `js/proportions-body.js`, `js/proportions-hands.js`, `js/outline.js`, `js/proportions-mode.js`. API, method, held-out results and the done/partial/not-started list: `review/proportions-body-hands-outline.md`.

---

## 2. State (what is live vs. local)

LIVE on `main` (last commit `e95687e` "Proportions: add the Proportions check to the page (7/7)"):
- Everything up to the face Proportions check v1 (auto-align fixes, Undo bar, offers, Proportions with MediaPipe, report, grid, editable points, 5 languages).

LOCAL ONLY in `app/` (finished and tested by the bench, NOT pushed; the owner said "not yet"):
1. Face robustness v2: style-resistant measures (eye spacing = mean of iris-centre and inner-corner spacing; nose width from nose-wing points), noise-aware adaptive tolerances with a "Drawing style" control (Auto / Realistic / Stylised), stronger "heads turned differently" warning (threshold 0.09, far-turn 0.25) with cos(yaw) width compensation, "not drawn yet" detection for unfinished mouth/chin (`js/prop-ink.js`), mirrored-drawing prompt with Flip, multi-face selection by overlap, conditional contrast normalisation for faint low-noise drawings.
2. PNG export includes Proportions marks and a report strip (`js/export.js`).
3. Matching points ("pairs") mode for non-face art, face-coach Skip.
4. Illustrated "?" explainer in the Proportions panel.
5. Phase 3 engines (body, hands, outline, mode choice) without UI.

To publish the local work: compare `app/` with the repo, copy over changed/new files, and push. The model files for phase 3 must be downloaded first (next section).

---

## 3. Model files (excluded from the zip because of upload size limits)

Already in the repo (copy them from `main`, byte-identical to local):
- `vendor/mediapipe/vision_bundle.mjs`, `vendor/mediapipe/wasm/*` (tasks-vision 0.10.21, Apache-2.0)
- `models/face/face_landmarker.task` (float16)

Needed for phase 3 (download from Google, verify SHA256; all Apache-2.0 per their model cards; details and card URLs in `app/vendor/mediapipe/README.md` and `bench/results/b0-licences.json`):
| file | path in app | bytes | SHA256 |
|---|---|---:|---|
| pose_landmarker_full.task | models/pose/ | 9,398,198 | 4EAA5EB7A98365221087693FCC286334CF0858E2EB6E15B506AA4A7ECDCEC4AD |
| pose_landmarker_lite.task | models/pose/ | 5,777,746 | 59929E1D1EE95287735DDD833B19CF4AC46D29BC7AFDDBBF6753C459690D574A |
| hand_landmarker.task | models/hand/ | 7,819,105 | FBC2A30080C3C557093B5DDFC334698132EB341044CCEE322CCF8BCF3607CDE1 |
| selfie_segmenter.tflite | models/segment/ | 249,537 | 191AC9529AE506EE0BEEFA6B2C945A172DAB9D07D1E802A290A4E4038226658B |
URLs: `https://storage.googleapis.com/mediapipe-models/<task>/<model>/float16/latest/<file>` (pose_landmarker/pose_landmarker_full, pose_landmarker/pose_landmarker_lite, hand_landmarker/hand_landmarker, image_segmenter/selfie_segmenter). Do NOT vendor deeplab_v3 (licence not confirmed).

---

## 4. Decisions the owner made (binding; see design/)

- `design/DECISIONS.md` (faces) and `design/phase3/DECISIONS-phase3.md` (body/hands/outline) override the specs where they differ.
- Defaults: Size by = Robust auto, Pin = Auto (best fit), never rotate the drawing by default (tilt is one report item; "Match head tilt" option), tolerance presets Strict/Usual/Relaxed without a single % label, left/right = the subject's own, desktop report column (images shrink), phone bottom sheet.
- Figures: lengths in heads, single segments in %; outline band ALWAYS ON by default; MANUAL-FIRST for drawings (guided point coaches), auto-detect on photo references, detection on drawings only offered.
- Visual style: warm studio-paper look, spiral sketchbook background with taped windows, graphite thumbprints and warm-up doodles; avoid generic AI styling (no purple gradients, glassmorphism, emoji).
- Owner preferences: approve designs from snapshot mock-ups before building; push only after approval; keep test runs SILENT (see 6).

---

## 5. Measured results (summary; full tables in review/*.md and bench/results/*.md)

Faces (MediaPipe, planted errors on CUFS sketches, Usual): eye spacing/eye level/mouth height caught from about 4%, nose length 4-6%, mouth width from about 8%; chin and jaw unreliable ("possible" only). Clean controls flagged about 2-3%.
Robustness v2 (held-out): faithful stylized FS2K copies with any flag 77% -> 24%, 3+ flags 21% -> 2%; cost: planted detection at >=6% FS2K 56% -> 42%, CUFS 72% -> 65%.
Phase 3 go/no-go: Pose Landmarker finds 13% of pencil-look figures (30% painted originals); Hand Landmarker finds 0% of grey pencil hands (99% of colour photos). Hence manual-first.
Phase 3 engines (held-out, simulated taps): body controls ~3% flagged but headline detection only 9% at the default tap noise (42% with precise taps); hands 65.5% at default noise; outline needs an 8% tolerance on CUFS (35% of 8% bulges found), stylized FS2K flags 23% of controls. These targets were NOT met; see review/proportions-body-hands-outline.md for why (robust fit absorbs torso changes; tap noise dominates) and ideas.

---

## 6. How to test (rules)

- ALWAYS mute the app in tests: `localStorage.setItem('sinopia:interaction-sounds','off')` then reload; in harness pages also stub `AudioContext`, `HTMLMediaElement.prototype.play` and `DrawingCompare.sound.play` before app scripts run.
- Serve over HTTP (file:// breaks modules/wasm). The bench uses `bench/serve-multi.ps1` (PowerShell HttpListener, Windows) mapping `/app-tuned/` (app folder), `/data/` (datasets), `/bench/`; it must serve `.mjs .wasm .task .tflite`. Any static server works (e.g. `python -m http.server`, `npx serve`).
- Confirm no model downloads on page load (Network tab) and no console errors.
- Never put dataset images into the app folder or the public repo; clear the app's IndexedDB after tests that loaded dataset images.
- Bench pages: `run.html` (auto-align suites), `planted.html`, `detectors.html`, `proportions-validate.html`, `robust.html`/`robust2.html`, `p3-*.html`. See `bench/README.md`.

---

## 7. Deploying

GitHub Pages builds `main` at the repo root automatically (~1 min). Hard-reload after deploying. If a Pages build gets stuck in "queued", push any small commit to start a fresh build. The owner previously uploaded via the GitHub web UI (no git installed on their machine); web uploads have a 25 MB per-file limit.

---

## 8. What's left (suggested order)

1. Get owner approval and push the local face robustness v2 + export + pairs + explainer.
2. Phase 3 UI: body and hand point coaches (manual-first), combined report with Face/Body/Hands/Outline sections and a ranked "All" list, outline band (always on), mode picker, i18n in 5 languages, Undo steps. Specs: design/phase3/SPEC-phase3.md + DECISIONS-phase3.md; snapshots in design/phase3/.
3. Improve phase 3 accuracy before shipping: zoom-lens tapping to reduce tap noise, rethink the robust fit for torso changes, better outline extraction for stylized drawings; re-validate on held-out halves.
4. Open items: real-device touch testing (iPhone/Android), Safari/Firefox checks, native-speaker review of zh/es/fr strings, real (not simulated) 3/4-view, mirrored and unfinished drawings.
