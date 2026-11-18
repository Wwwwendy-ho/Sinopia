# Proportions engine

Engine only (no UI). Files: `js/landmarks.js`, `js/proportions.js`, `vendor/mediapipe/`, `models/face/face_landmarker.task`.

## Method

1. **Landmarks.** `DC.Landmarks.detect(canvasOrImage)` downsizes to at most 640 px and runs MediaPipe Face Landmarker (478 points, CPU/WASM, about 17 ms). Loading is lazy and cached; if it fails (import, wasm, model, 60 s timeout) the face-api tiny 68-point detector already in the app is used (through `DC.Subjects.analyze` when present). The GPU delegate is not used: it differs by device and driver, and CPU is fast enough.
2. **Features.** `Proportions.features(points, source)` maps either detector to one named set (indices in `Proportions.INDEX`): eye centres, corners and eyelids; three brow points per side; nose bridge, tip, base, alae; mouth corners, centre, upper and lower lip; chin; jaw at two heights; cheeks; hairline (MediaPipe only). R/L are the person's own (R = image left).
3. **Frame.** Each face is expressed in a frame with the eye midpoint as origin, rotated so the midline (eye midpoint to nose base, mouth and chin, summed) is vertical, and scaled by its own eye-to-chin distance (EC). Measuring in this frame is what makes a tilted head not flag every feature; the tilt difference is reported once (`head_tilt`).
4. **Alignment** (`align`). `size: 'auto'` is an L1 (IRLS) fit of scale and translation over eyes, nose base, mouth corners, chin and jaw, so one mis-drawn feature does not move the fit. `head`, `eyeChin`, `eyeSpacing`, `custom` fix the scale; the features that define the measure are returned in `locked`. A pin (`eyes`, `nose`, `chin`, `mouth` or `{x,y}`) replaces the translation, the scale is re-fitted about the pin, and the pinned pair coincides exactly. The returned similarity never rotates unless `matchTilt` is true.
5. **Measure** (`measure`). Per item, the drawing's value in the aligned frame minus the reference's, in % of the reference EC, minus the detector bias on sketches; compared with the tolerance. Items: eye spacing, each eye's height, eye tilt, each brow's height, nose length, nose width, mouth height, mouth width, chin length, jaw width (two heights), head tilt (degrees). Each has arrows (drawing point to where the reference says it belongs, in drawing and in reference pixels), the points involved, an optional `span` for brackets, a structured `sentence` (key and numbers, no English), and `side`.
6. **Knock-on grouping.** The mouth is grouped under a too-long or too-short nose when both are flagged in the same direction and the nose-to-mouth distance is within tolerance; the chin likewise under the lowest cause; a second eye under the first when both move together.
7. **Distortion grid** (`distortionGrid`). Thin-plate spline from the reference's landmarks to the drawing's (after the alignment), small smoothing; reference squares of 16% EC from the brows to below the chin; the same lines as the drawing bends them (in reference pixels and in the drawing's own); per-cell area change, smoothed over 3x3, classed stretched / squashed above 4%. Diagnostic only.

## Value correction: bias, then gain

`value = (raw - bias) / gain`. Bias is the mean sketch-minus-photo difference; gain is how much of a drawn displacement the detector reports. The correction factor 1/gain is capped at 2 (gain below 0.5 counts as 0.5), so chin and jaw stay under-reported and weak.

### Bias table (mean of sketch minus photo over 188 CUFS pairs, same engine; % of EC)

| Item | MediaPipe | face-api tiny |
| --- | ---: | ---: |
| eye spacing | +0.70 | +1.61 |
| eye height R / L | -0.14 / -0.16 | 0 (not measured) |
| eye tilt | +0.02 | +0.12 |
| brow height R / L | +0.24 / +0.43 | 0 (not measured) |
| nose length | +0.40 | +0.26 |
| nose width | +0.61 | 0 (not measured) |
| mouth height | +0.35 | +0.64 |
| mouth width | +0.13 | +0.67 |
| chin length | -0.40 | -0.40 |
| jaw width low / high | +1.18 / +1.82 | +0.74 / 0 |
| head tilt (deg) | +0.17 | 0 |

The seven benchmarked values come from the planted benchmark; the rest were measured by this engine (`bench/proportions-validate.html`, `PV.naturalStats`), which reproduces the benchmark's seven to two decimals. The mouth-width bias is +0.13 for MediaPipe (the +2% in the brief is the oracle annotations' bias). One artist set only.

### Gain table (median measured / planted over single-error planted cases >= 4%, bias-corrected)

| Item | MediaPipe (n=64) | face-api tiny (n=7 to 21, indicative) | benchmark (MediaPipe) |
| --- | ---: | ---: | ---: |
| eye spacing | 0.85 | 0.43 | 0.86 |
| eye tilt | 0.78 | 0.32 | 0.73 |
| eye height R / L | 0.72 / 0.70 | 0.32 (eye tilt's) | |
| nose length | 0.71 | 0.66 | 0.69 |
| mouth height | 0.76 | 0.43 | 0.75 |
| mouth width | 0.90 | 0.26 | 0.88 |
| chin length | 0.36 | 0.08 | 0.43 |
| jaw width (low, high) | 0.31 | 0.16 | 0.30 |
| brows, nose width, head tilt | 1 (not planted) | 1 | |

Effect: the median signed error at >= 4% for MediaPipe is between 0.02 and 0.06 (% EC) for eye spacing, eye tilt, nose length, mouth height and mouth width; chin -2.0 and jaw -2.7 (capped correction).

## Tolerances (Usual, % of EC, applied after bias and gain correction)

Chosen by sweeping the planted suite (MediaPipe, 720 cases): maximise detection at >= 4% subject to controls with any false alarm <= 5% and unplanted false alarms on planted cases <= 5% (collateral movement over 2% excluded, as in the benchmark). Core = eye spacing, each eye height, eye tilt, nose length, mouth height.

| Item | Usual | Notes |
| --- | ---: | --- |
| core (see above) | 3.5 | sweep 1.5 to 4 |
| mouth width | 6.5 | sweep 3 to 7 |
| chin length | 7 | sweep 3 to 7 |
| jaw width (both heights) | 10 | only ever `possible` above this (not swept) |
| nose width, each brow height | 4 | not planted; natural CUFS p99 about 2 to 2.6 |
| head tilt | 3 degrees | natural p99 about 1.9 |

Strict = 0.72x (controls false-alarm rate about 10%), Relaxed = 2x. Major = 2x tolerance. DECISIONS.md had 3 / 5 / 5 (core / mouth width / chin) and Strict 0.67x, chosen before gain correction; with gain correction the same false-alarm budget needs larger numbers. The sweep is in-sample (tuned and scored on the same suite). A flagged item ranks by how many tolerances it is; `possible` items rank last. `displayPercent` rounds, but a value over the tolerance never displays as within it.

Core sweep (mouth width 6.5, chin 7 fixed). Columns: tolerance, detected >=4%, detected >=6%, controls with a false alarm, planted cases with an unplanted false alarm (all %):

| core | >=4 | >=6 | controls FA | unplanted FA |
| ---: | ---: | ---: | ---: | ---: |
| 1.5 | 72.4 | 76.5 | 26.3 | 39.1 |
| 1.75 | 72.4 | 76.5 | 15.0 | 28.0 |
| 2.0 | 72.4 | 76.5 | 10.0 | 21.4 |
| 2.25 | 72.0 | 76.5 | 3.8 | 15.3 |
| 2.5 | 71.4 | 76.1 | 2.5 | 10.9 |
| 2.75 | 70.6 | 76.1 | 2.5 | 8.9 |
| 3.0 | 69.7 | 75.9 | 2.5 | 7.2 |
| 3.25 | 68.8 | 75.4 | 2.5 | 5.6 |
| **3.5** | **68.1** | **75.4** | **2.5** | **5.0** |
| 3.75 | 66.4 | 75.2 | 1.3 | 4.7 |
| 4.0 | 65.1 | 75.2 | 1.3 | 3.9 |

Mouth width and chin swept together (core 3.5; the same value for both, so the chosen pair 6.5 / 7 is slightly different):

| width and chin | >=4 | >=6 | controls FA | unplanted FA |
| ---: | ---: | ---: | ---: | ---: |
| 3.0 | 77.6 | 84.1 | 33.8 | 27.5 |
| 4.0 | 74.3 | 81.3 | 20.0 | 16.9 |
| 5.0 | 71.9 | 78.9 | 7.5 | 9.7 |
| 6.0 | 69.6 | 77.0 | 6.3 | 6.4 |
| 6.5 | 68.3 | 75.7 | 3.8 | 5.6 |
| 7.0 | 66.9 | 73.9 | 2.5 | 5.0 |

(The full 0.25 step table is in the validation page, `PV.sweep`.) Unplanted false alarms, not control false alarms, are the binding constraint.

## Validation (planted-error suite, 720 cases from 188 CUFS sketches; reference = unmodified photo; defaults: size auto, pin auto, bias and gain on)

MediaPipe, all 720 cases (`results/pv-planted-mediapipe.json`):

| preset (core / mouth width / chin / jaw) | detected >=4% | >=6% | by magnitude 2/4/6/8/12 | controls with any false alarm | unplanted false alarm, planted cases | median abs magnitude error |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Strict 0.72x (2.52 / 4.68 / 5.04 / 7.2) | 77.1% | 82.2% | 16/61/74/80/92 | 10.0% | 18.0% | 1.24 |
| Usual (3.5 / 6.5 / 7 / 10) | 68.1% | 75.4% | 4/45/67/75/85 | 2.5% (2 of 80) | 5.0% | 1.24 |
| Relaxed 2x | 32.4% | 42.4% | 1/1/16/48/63 | 0% | 0% | 1.24 |

(The benchmark: 81% at >=4% with 21% of controls false-alarming at p95 tolerances. At Strict, 77% detection costs 10% control false alarms.)

Detection by feature and magnitude at Usual (2/4/6/8/12 %):

| Feature | 2 | 4 | 6 | 8 | 12 |
| --- | ---: | ---: | ---: | ---: | ---: |
| eye spacing | 13 | 82 | 96 | 100 | 100 |
| eye tilt (an eye too high or low) | 0 | 77 | 100 | 100 | 100 |
| nose length | 0 | 64 | 100 | 95 | 100 |
| mouth height | 6 | 76 | 86 | 100 | 100 |
| mouth width | 0 | 0 | 44 | 89 | 100 |
| chin length | 13 | 15 | 20 | 29 | 71 |
| jaw width | 0 | 0 | 5 | 9 | 22 |

Other (MediaPipe, defaults): head tilt, 180 tilted cases (2 to 5 degrees), median absolute error against the planted angle 0.48 degrees (p95 1.8), flagged (over 3 degrees) in 110, and in 3 of 540 untilted cases; tilted controls produce no flags. Eye cases (111): any eye item flagged in the right direction in 90%. Timing: detection 16 ms median (p95 19) per image, engine 0.1 ms, grid about 1 ms.

face-api tiny fallback, every 4th case (180 cases, gains from 7 to 21 cases per feature, so indicative): Usual detects 54% at >=4% (60% at >=6%) with 5% of controls false-alarming and 20% unplanted false alarms; Strict 66% / 68% with 45% / 54%. Median magnitude error 2.6; about 850 ms per image. Use only for large differences; the UI should say the fallback is rougher.
## Limitations

- Chin length and jaw width are unreliable: the detector follows imposed chin/jaw displacements poorly (gain 0.45 or less). Chin is flagged at 7% and detected mostly only at 12% (71%); jaw is never above `possible` and was detected in only 22% of 12% errors. Treat both as hints.
- Only frontal, clean CUFS sketches were tested (one artist set). Not tested: faint pencil, 3/4 views, large roll or yaw, photos as drawings, mirrored drawings, several faces. A pose check is included (`warnings: heads_turned_differently`, width items flagged `approximate`) but its 0.15 threshold is untested.
- The robust fit assumes most features are roughly right. If most of the lower face is wrong together (nose, mouth, chin all low), the fit treats the eyes as the odd ones out. Choosing `eyeChin` sizing with the `eyes` pin avoids this.
- Brow height and nose width were not planted in the benchmark; only their natural spread is known.
- The bias table is from one dataset; face-api biases for the extra items were not measured.
- The planted warps are synthetic; the reference photos are the sketches' own subjects (best case for matching).
- Hairline exists for MediaPipe only; `size: 'head'` falls back to eye line to chin without it (reported in `size.note`).
- MediaPipe reports no per-face score (`score` is 1).
