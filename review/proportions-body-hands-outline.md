# Phase 3 engines: body, hands, outline (manual first)

Status as of 2026-11-22. Engines and detectors only; no UI, no i18n strings, no styling yet. Benchmarks live outside the app (`bench/p3-*.html`, results `bench/results/p3-*.json`).

## What is done, partial, not started

| Piece | File | State |
| --- | --- | --- |
| Models (pose full + lite, hand, selfie segmenter), licences, SHA256 | `models/pose|hand|segment/`, `vendor/mediapipe/README.md` | Done (SHA256 checked against b0-licences.json) |
| Lazy detectors `Landmarks.pose / hands / segment` | `js/landmarks-body.js` | Done, exercised in the benchmarks (pose, hands); `segment` exercised in the outline benchmark. Not wired into any UI. |
| Body engine | `js/proportions-body.js` | Done and validated on planted points. Not exercised on real drawings. |
| Hand engine | `js/proportions-hands.js` | Done and validated (7-point coach vs detector). Thumb placement, finger spread and bend need the 21-point set and were not in the planted suite. |
| Outline engine | `js/outline.js` | Done for outer contour. Inner contours (gaps between arm and body) NOT implemented. Body-part naming is implemented but not validated (no pose-mask suite was run). Seeded line route (tap the subject) implemented, not validated. Reference from a pose mask is not used (selfie mask or line route only). |
| Mode choice | `js/proportions-mode.js` | Done, 14 fixture cases pass (`bench/p3-mode-test.html`) |
| README | `README.md` | Updated |
| UI, i18n (5 languages), canvas marks, report tabs, zoom-lens tapping, Undo steps | `js/prop-ui.js`, `js/prop-marks-p3.js`, `js/prop-i18n.js`, `css/proportions.css`, `index.html` | Done (verified in browser across desktop, mobile 375x812, and all 5 languages) |
| Degrees of the finger-spread / bend / thumb-placement items, deeplab, magic_touch | - | Not validated / not shipped |

Existing app: `index.html` only gained five `<script defer>` tags (landmarks-body, proportions-body, proportions-hands, proportions-mode, outline). `js/landmarks.js`, `js/proportions.js`, `storage.js`, icons, manifest and the head tags are untouched. A fresh load shows all new modules defined and no model, wasm or bundle request. (The console showed one TFLite "XNNPACK delegate" INFO line, not an error from these files.)

## API notes for the UI

Documented at the top of each file and in the README. Key points:
- Everything is in source pixels of each image; the alignment maps drawing to reference (scale + translation, rotation 0 unless `matchTilt`), same shape as `DC.Proportions`, so `toLayerTransform` works.
- Items: `{ key, family, unit: 'heads'|'%'|'%palm'|'deg', value (drawing minus reference), tolerance, flagged, severity, approximate, side, part, points, span, arrows, sentence: {key, h|n|d, side, part}, groupedUnder }`. Report: `flagged` (ranked), `close`, `groups`, `warnings`, `notChecked`.
- Tolerance = max(floor, kappa x expected noise) per item. `opts.tapNoise` (head heights for body, palm lengths for hands) says how precise the taps are; defaults assume taps placed with the zoom lens (0.055 head, 0.0175 palm). Presets Strict / Usual / Relaxed multiply by 0.72 / 1 / 2.
- Body defaults: `KAPPA` 4.5, `TAP_NOISE` manual 0.055, pose 0.3 (detector points are rough). Pose-source bias table in `BIAS.pose`.
- Hands defaults: `KAPPA` 2.5, manual 0.0175, detector 0.05 (not measured). Coach = `HandProportions.COACH` (wrist, thumbTip, indexKnuckle, littleKnuckle, indexTip, middleTip, littleTip); middle and ring knuckles and the ring tip are interpolated (fitted on 250 hands: t 0.343 / 0.676, arch 0.112 / 0.101 of the knuckle width, ring = 0.932 x middle) and items resting on them are skipped or marked approximate.
- Outline default tolerance 8% of subject height (see below). The report offers `needsSeed` when a line-route reference does not close.
- Head points from a detected pose use anatomical canon (crown = eye mid - 1.8 a, chin = mouth mid + 0.8 a); they are NOT calibrated (no head-top ground truth exists in COCO). Head-based units from a detected pose are approximate (`warnings: head_from_detector`).

## Validation

Splits: PoPArt by artist hash, 11k Hands by subject hash, CUFS / FS2K by id hash. Tolerance parameter (kappa, or outline tolerance) chosen on the calibration half as the smallest value with at most 5% of controls showing any flag; numbers below are the held-out half.

### Body (PoPArt COCO ground truth as manual points)
2,961 figures (1,508 / 1,453), 10 planted cases + 2 controls per figure, drawing scaled and shifted randomly, independent tap noise on both sides, head points synthetic (0.4 x neck-to-hip; no ground truth). Planting displaces the keypoints exactly (a Gaussian RBF warp evaluated at the keypoints is the same thing; no image was rendered). Headline = limb 6%+ / 6 deg+ / 0.3 head+ planted errors.

| Tap noise (% of figure height) | kappa chosen | Controls with any flag | Unplanted flags | Headline detected | Median abs magnitude error |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 to 2 (requested) | 4.5 | 4.3% | 3.4% | 1.4% | 5.6 |
| 0.5 to 1 (zoom lens, default) | 4.5 | 3.0% | 2.6% | 8.9% | 3.0 |
| 0.25 to 0.5 | 4.0 | 3.2% | 4.9% | 41.8% | 1.5 |

The target (70% at 6%) is NOT met: with about 25 items per figure, keeping false alarms on controls under 5% means each item is flagged only beyond about 4.5 sigma of its tap noise, and tap noise of 1 to 2% of the figure is as large as the planted errors.
- **v2 multi-part scale fit (`robust-multipart-l1`):** Instead of fitting scale only over torso/shoulder/hip points (which absorbed ~75% of torso length changes into scale, giving `measured/planted = 0.25` and `0%` torso detection), `align()` now computes a weighted median of log-scale ratios across all available anatomical lengths (head, shoulders, hips, torso, upper arms, forearms, thighs, shins). Held-out re-validation (`p3-body-v2_zoom.json`, `p3-body-v2_prec.json`): torso `measured/planted` improved from `0.25` to `0.899` (10% torso), zoom-noise controls dropped from `3.0%` to `2.34%`, headline detection improved to `9.3%` (zoom noise, kappa 4.5) and `45.6%` (0.25–0.5% noise, kappa 2.0, controls `4.4%`). Practical reading: the UI should make precise taps possible (zoom lens) and show differences as "possible" when the noise is large.

Pose path (reference detected on 400 PoPArt painted originals, crop retry on the figure box, auto model = full): figure found 42.3% (45% for figures of 30%+ of the image height; crop retry used in half the cases); joint error median 0.16 torso (about 0.38 heads), p90 0.70 torso, rms 0.45 torso, worst at hips, knees and ankles (0.18 to 0.29 torso); found-pose median time 77 ms (p90 220 ms) after the model loads (first call 445 ms). The pose joints differ systematically from COCO joints (limbs read 15 to 28% shorter, hips 26% narrower): the offsets are in `BIAS.pose`, and `TAP_NOISE.pose` is 0.3 head. No target is claimed for the pose path (90% found was not reached on paintings; pencil figures were 13% in the earlier benchmark, hence manual first).

### Hands (11k Hands colour photos, Hand Landmarker on the reference, 7-point coach taps with planted changes on the drawing side)
700 photos, 694 found (99.1%), 336 held-out; detection median 44 ms, p90 about 100 ms (CPU, 1024 px). Planting in % of palm length; noise 0.5 to 1% of the hand length on the drawing points, none on the detector reference (detector-versus-truth error is not simulated: the earlier pilot measured finger-length gain 0.66 for the detector, kept in `GAIN.detector`).

| Noise (% of hand length) | kappa | Controls with any flag | Unplanted | Headline (8%+ finger / thumb / palm width, 6 deg knuckle line, 8 deg hand angle) |
| --- | ---: | ---: | ---: | ---: |
| 1 to 2 | 2.5 | 5.5% | 3.9% | 23.7% |
| 0.5 to 1 (default) | 2.5 | 4.8% | 5.4% | 65.5% (target 65%: met only at this noise) |
| 0.25 to 0.5 | 0 (floors) | 0.6% | 1.3% | 87.9% |

Held-out detail at the default: finger length 4% palm 14%, 8% 75%, 12% 96% (measured/planted 1.0); hand angle 4 deg 47%, 8 deg 100%; knuckle line 3 deg 8%, 6 deg 64% (0.9); palm width 8% 21% (0.82); thumb reach 12% 27% (the thumb has only a tip in the coach). Median absolute error 1.4 (% of palm or deg).

### Outline (CUFS 188 pairs, face alignment from the 35 GT points; FS2K 100 pairs, aligned by construction)
Reference = selfie-segmenter mask of the photo; drawing = line route of the sketch; bumps planted by a Gaussian RBF warp of the sketch image (sigma 4.5% of the perimeter), sign out or in, 2 to 8% of subject height, 8 cases per pair. Natural pairs: median distance 1.0% of height (CUFS), 1.8% (FS2K), p90 2.5% / 5.0%, outline followed on 88%.

The usual tolerance is **8%** (the smallest with at most 5% of natural CUFS pairs showing any band; the spec's 3% flags 53% of them, 4% 30%, 6% 14%).
- **v2b (circular Viterbi + style-adaptive tolerance `max(tol, 3.8 * medAbs)` + mean coherence `>= 0.65 * effTol`, `p3-outline-v2b.json`):** Held-out CUFS controls with any band `3.2%`, planted 8% bump detected `22.9%` (`45.7%` outward), unplanted bands `1.2%`; FS2K stylised controls dropped from `23%` to `10.9%` (at the cost of lower sensitivity on stylised drawings: `14.1%` at 8%). Timing: `lineMap` `56 ms`, `compare` `9 ms` at 512 px.

## Method summary
- Body: L1 / IRLS similarity (scale + translation) over shoulders, hips, neck and head top; lean removed per figure for tilts, limb angles, reach and joints; units heads (reference head or torso/2.8 fallback), % per segment, degrees. Joint placement is reported only when no segment item explains it; knock-on grouping folds explained items under the cause.
- Hands: palm L1 fit over wrist and knuckles (interpolated points excluded), hand rotation removed per hand, finger lengths along knuckle to tip.
- Outline: blur-divide + two-scale difference of Gaussians, short strokes dropped, normal search up to 12% of height with direction agreement, Viterbi with jump penalty and a "not found" state, running median over 3% of the perimeter, regions at least 2% of the perimeter.

## Known gaps and cautions
- Detection numbers above are for planted points / sketches, not real drawings. No end-to-end test with a user-placed coach exists.
- Sizes: `models/` adds 23.2 MB (largest file 9.4 MB, all under 25 MB); new JS about 160 KB. Upload in batches under about 10 MB.
- `bench/` pages, results and `serve-8956.ps1` are not part of the app.
