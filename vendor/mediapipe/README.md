# MediaPipe Face Landmarker (self-hosted)

Used by the Proportions check (`js/landmarks.js`). Loaded lazily, only when a proportions check is first requested; never on page load. Everything runs in the browser (WebAssembly, CPU); images never leave the device.

- **@mediapipe/tasks-vision 0.10.21**, Apache-2.0 (Google). Licence text: `LICENSE` in this folder (the standard Apache 2.0 text).
- **face_landmarker.task** (float16), Apache-2.0 (Google), stored at `models/face/face_landmarker.task`.

## Sources

| File | Source |
| --- | --- |
| `vision_bundle.mjs`, `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm`, `wasm/vision_wasm_nosimd_internal.js`, `wasm/vision_wasm_nosimd_internal.wasm` | npm package `@mediapipe/tasks-vision@0.10.21` (`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/`, files `vision_bundle.mjs` and `wasm/*`) |
| `../../models/face/face_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` |

These are the standard upstream locations; the benchmark folder did not record where its copy was fetched from, so the SHA256 values below (of the files actually tested) are the reference. The files were taken unchanged from the copies used in the benchmark (the tested files). The browser picks the SIMD or the no-SIMD wasm build itself.

## SHA256 and sizes

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `vision_bundle.mjs` | 137,735 | 40F4123DFCD75CFA58ADD046919CC6F52FDE66F009FF582997C09BA54C6BA27C |
| `wasm/vision_wasm_internal.js` | 204,284 | 4A97E2520BA506C680ECD6BA6ACFB146888AFA0E2746D57F205352BC6EBB82EB |
| `wasm/vision_wasm_internal.wasm` | 9,574,032 | F00EC4731FAA23B3E714D00E88D4D10E2DF5C0A427D3A2B4AE6E3526FDD14EF7 |
| `wasm/vision_wasm_nosimd_internal.js` | 204,137 | 927DEF7B465C51B86E4B3060F93646ACA4E27121F4B8FC0483786E407EA9CF1F |
| `wasm/vision_wasm_nosimd_internal.wasm` | 9,448,638 | 3821EA9B1F7FB8C549EF2A064EF5C85750BF375C545A49FD6EEA0DF44A95F1F4 |
| `models/face/face_landmarker.task` | 3,758,596 | 64184E229B263107BC2B804C6625DB1341FF2BB731874B0BCC2FE6544E0BC9FF |

A browser downloads the bundle, one wasm pair (about 9.8 MB) and the model (3.8 MB): roughly 13.5 MB once, then from the HTTP cache. Each file is under 25 MB (GitHub's web upload limit); the largest is 9.6 MB.
