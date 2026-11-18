# Automatic subject alignment

Auto-align now tries meaningful subjects before the existing structural matcher. It runs on first loading the pair, through Auto align, and through Fit all. No new controls or subject-selection steps are required.

- **Faces:** the local detector finds a dominant face and 68 landmarks. Each eye, brow, nose, mouth, chin and jaw side contributes one anchor, so dense lip landmarks cannot dominate. Consensus and robust fitting tolerate a misplaced feature. Multiple comparable faces fall back to structural matching instead of choosing arbitrarily.
- **Reference guidance:** when the face is detected only in the reference, its region guides a structural search against the drawing. Only a strong regional result is offered, labelled approximate.
- **Round boundaries:** circumference support and radial gradient direction verify circles and axis-aligned ellipses. Matching position and uniform size does not invent an unobservable rotation for a plain ball. Incompatible ellipse proportions or comparable competing objects are declined.
- **Enclosed silhouettes:** border-connected background removal pairs closed sketch outlines with filled objects, including simple boxes and bottles on a clear background. Normalized radial contours guide position, uniform scale and rotation. Unrelated shapes and ambiguous objects are rejected. This is a geometric fallback, not a general object-classification model.
- **Structural fallback:** full-image edge matching and the existing sparse-paper regional search remain available. Blank images, model failures and unsupported subjects do not disable ordinary matching.
- **Retakes:** photos of the same drawing try the precise structural match first, before subject estimates, to preserve their placement and dots. A small camera tilt (up to ±10°) is kept.

All placements are one translation and one uniform scale for the entire drawing; rotation is fixed at 0 for every estimator (landmarks use a closed-form scale-and-translation fit, the edge matcher searches angle 0 only, silhouettes compare the unshifted radial profile). Only retakes (cap ±10°) and the opt-in "Allow rotation in auto-align" setting (cap ±15°) may rotate, and never beyond the cap. Features are never individually warped. Approximate fits are not applied: they are offered (Apply / Preview / Dismiss), and every applied alignment is on the persistent Undo align / Redo list. Fit all preserves an existing alignment when a new estimate is weaker; hand-tuned placements and alignment dots retain priority. Cancellation and photo/orientation cache keys remain in effect.

## Confidence rule (applied vs offered vs declined)

The old rule (detector score >= 0.7 on both faces and first four anchors within 8.5% of the face box) labelled 36% of CUFS matches approximate although all were accurate; real photo/sketch scores of 0.3-0.7 are normal. The rule now uses evidence that predicts a correct fit. All distances are in inter-ocular distances (IOD) of the reference face. The evidence is attached to every result as `result.evidence` (numbers only); the pure functions `Subjects.decideFace` / `decideStructural` and the object `Subjects.thresholds` hold the rule.

**Face fit (`face-landmarks`)** is first checked for plausibility; an implausible fit is discarded (never applied, never offered) and the structural result takes over, only ever as an offer:
- face-box size ratio after mapping within 0.55-1.8, IoU of the mapped drawing face box with the reference face box >= 0.3, mapped face box >= 60% inside the reference frame, drawing scale relative to the reference 0.15-6.5.

A plausible fit is **applied** only if all hold, otherwise it is **offered**:
- at least 7 of 9 anchors are inliers; eyes within 0.16 IOD and nose within 0.25 IOD of their targets; RMS residual of the inliers <= 0.09 IOD;
- head pose: the nose offset from the eye midpoint and the left/right jaw asymmetry (both faces) are each <= 0.15 (a turned, 3/4-view head gives unreliable landmarks);
- unmodelled tilt <= 2.5 degrees: the same fit with the rotation left free is compared with the rotation auto-align may apply (0 by default), so a tilted photo is offered instead of applied slightly crooked;
- detector score only as a soft term: minimum score >= 0.2, and below 0.5 the residual must be <= 0.06 IOD;
- agreement: if the independent structural edge matcher (run in its worker alongside the detector, so it costs no extra time) is itself confident, its mapping of the anchors must be within 0.3 IOD of the face fit; a strong disagreement is offered.

**Structural result**: refused when a face was found in the reference and the mapped drawing is smaller than 0.7x the face box diagonal or does not cover the face centre, or when the mapped sketch face lies mostly (> 50%) outside the frame (the "sketch lands tiny on the cheek" failure). If both images show a face but the landmark fit was unusable (a method switch) a confident structural result is only offered. Reference-face-region, round and silhouette results stay offered-only; retakes keep the precise structural match first.

**Calibration** (`bench/calib.js`, evidence recorded with `DrawingCompare.Subjects.calibrate = true`; 190 CUFS cases, 120 FS2K pairs): the cases were split by a hash of the person/photo id (cases of one person stay together); thresholds were grid-searched on the calibration half only (objective: zero confident-but-wrong, at most 5% of CUFS rot-0 offered, then maximise good-and-applied) and reported on the other half. Held-out CUFS rot-0 (79 cases): 100% applied, 0 offered, 0 confident-but-wrong; FS2K held-out (44 pairs): 0 wrongly applied pairs (baseline 4, previous fixed 4), all 14 inconsistent pairs offered or declined. See `bench/results/SUMMARY-tuned.md`.

Limits: with rotation off, CUFS photos tilted by 2.5-8 degrees are offered (about 90% of tilt cases), by design. The thresholds were fitted on two research datasets of frontal-ish faces; other photo types are untested.

## Outline

For a sufficiently clear dominant face, Outline draws estimated jaw, brows, eyes, nose and lips; Detail adds the inner lips. Clear round boundaries and enclosed silhouettes receive their own contour. Dashed strokes distinguish these estimates from a literal tracing. Unsupported or ambiguous images retain the original edge view. Contours stay in source-image coordinates, so turns, mirrors, zoom, export and layer placement follow the original rendering pipeline.

## Validation

The Playwright tests use Chromium. Start `python -m http.server 8772` in the repository, then run `node tests/subjects.cjs` and `node tests/subjects-integration.cjs` in an environment with Playwright installed. `SINOPIA_URL` and `CHROMIUM_PATH` can override the defaults.

The geometry tests check known transforms for faces, a deliberately misplaced mouth, circle/ellipse matching, outline-to-filled box/bottle matching, unrelated shapes, competing objects, and orientation inversion. Integration tests exercise actual local model requests, automatic matching on a phone viewport, warning, contour output, cancellation, and model-unavailable structural fallback. Private portrait fixtures can be supplied with `SINOPIA_DRAWING` and `SINOPIA_REFERENCE`; tests cover both upload orders and a precise same-image retake. Those user photos are not committed.

The supplied real drawing/reference pair detects faces in both images, fits all nine feature anchors, and applies an approximate facial alignment in either upload order. The earlier synthetic structural test still recovers known scale/rotation with incomplete marks, including the approximate 25%-complete case, and rejects a blank drawing.

This is best effort. Very faint or unfinished faces, strong perspective differences, occlusion, large head turns and complex backgrounds can prevent detection or produce imperfect landmarks. Clear-boundary geometry does not identify every object in a cluttered photograph. Cold model loading and CPU inference add time, especially on older phones. No claim is made of physical iPhone testing or universal matching accuracy.
