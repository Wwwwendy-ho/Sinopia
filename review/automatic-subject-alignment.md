# Automatic subject alignment

Auto-align now tries meaningful subjects before the existing structural matcher. It runs on first loading the pair, through Auto align, and through Fit all. No new controls or subject-selection steps are required.

- **Faces:** the local detector finds a dominant face and 68 landmarks. Each eye, brow, nose, mouth, chin and jaw side contributes one anchor, so dense lip landmarks cannot dominate. Consensus and robust fitting tolerate a misplaced feature. Multiple comparable faces fall back to structural matching instead of choosing arbitrarily.
- **Reference guidance:** when the face is detected only in the reference, its region guides a structural search against the drawing. Only a strong regional result is offered, labelled approximate.
- **Round boundaries:** circumference support and radial gradient direction verify circles and axis-aligned ellipses. Matching position and uniform size does not invent an unobservable rotation for a plain ball. Incompatible ellipse proportions or comparable competing objects are declined.
- **Enclosed silhouettes:** border-connected background removal pairs closed sketch outlines with filled objects, including simple boxes and bottles on a clear background. Normalized radial contours guide position, uniform scale and rotation. Unrelated shapes and ambiguous objects are rejected. This is a geometric fallback, not a general object-classification model.
- **Structural fallback:** full-image edge matching and the existing sparse-paper regional search remain available. Blank images, model failures and unsupported subjects do not disable ordinary matching.
- **Retakes:** photos of the same drawing try the precise structural match first, before subject estimates, to preserve their placement and dots.

All placements are similarity transforms: one translation, one rotation and one uniform scale for the entire drawing. Features are never individually warped. Approximate fits show the existing translated warning and Undo. Fit all preserves an existing alignment when a new estimate is weaker; hand-tuned placements and alignment dots retain priority. Cancellation and photo/orientation cache keys remain in effect.

## Outline

For a sufficiently clear dominant face, Outline draws estimated jaw, brows, eyes, nose and lips; Detail adds the inner lips. Clear round boundaries and enclosed silhouettes receive their own contour. Dashed strokes distinguish these estimates from a literal tracing. Unsupported or ambiguous images retain the original edge view. Contours stay in source-image coordinates, so turns, mirrors, zoom, export and layer placement follow the original rendering pipeline.

## Validation

The Playwright tests use Chromium. Start `python -m http.server 8772` in the repository, then run `node tests/subjects.cjs` and `node tests/subjects-integration.cjs` in an environment with Playwright installed. `SINOPIA_URL` and `CHROMIUM_PATH` can override the defaults.

The geometry tests check known transforms for faces, a deliberately misplaced mouth, circle/ellipse matching, outline-to-filled box/bottle matching, unrelated shapes, competing objects, and orientation inversion. Integration tests exercise actual local model requests, automatic matching on a phone viewport, warning, contour output, cancellation, and model-unavailable structural fallback. Private portrait fixtures can be supplied with `SINOPIA_DRAWING` and `SINOPIA_REFERENCE`; tests cover both upload orders and a precise same-image retake. Those user photos are not committed.

The supplied real drawing/reference pair detects faces in both images, fits all nine feature anchors, and applies an approximate facial alignment in either upload order. The earlier synthetic structural test still recovers known scale/rotation with incomplete marks, including the approximate 25%-complete case, and rejects a blank drawing.

This is best effort. Very faint or unfinished faces, strong perspective differences, occlusion, large head turns and complex backgrounds can prevent detection or produce imperfect landmarks. Clear-boundary geometry does not identify every object in a cluttered photograph. Cold model loading and CPU inference add time, especially on older phones. No claim is made of physical iPhone testing or universal matching accuracy.
