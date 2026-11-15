# Local face models

Sinopia bundles **face-api.js 0.22.2** (MIT, Vincent Mühler), including its TensorFlow.js runtime, and the Tiny Face Detector and 68-point Tiny Face Landmark models. The upstream MIT license is in `LICENSE`.

Sources:

- Runtime: https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js
- Models and manifests: https://github.com/justadudewhohacks/face-api.js/tree/master/weights (the `tiny_face_detector` and `face_landmark_68_tiny` files only).

The exact downloaded files are committed under `vendor/face-api` and `models/face`. The app never loads a CDN or model service at runtime. Models load lazily from the site's own origin; inference uses the CPU backend and image data never leaves the browser. Network/model failure uses the structural matcher instead. The runtime and weights total approximately 925 KiB, before HTTP compression.
