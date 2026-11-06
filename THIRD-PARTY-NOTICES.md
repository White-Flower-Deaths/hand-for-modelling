# Third-party notices

Form — Motion Studio uses these third-party components:

| Component | Version / asset | License | Source |
| --- | --- | --- | --- |
| Three.js | `three@0.187.0` and its GLTF, OBJ, MTL, and STL loaders | MIT | [Three.js](https://github.com/mrdoob/three.js) |
| MediaPipe Tasks Vision | `@mediapipe/tasks-vision@1.2.2` browser bundle and WebAssembly runtime | Apache-2.0 | [MediaPipe](https://github.com/google-ai-edge/mediapipe) |
| MediaPipe Hand Landmarker | `assets/hand_landmarker.task`, float16 version 1 | Apache-2.0 | [Official model file](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task) · [Model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf) |

The application uses the package and model on-device. No code is copied from the MediaPipe sample repository; the web implementation follows the official Hand Landmarker documentation and video-mode API.

License texts are included in [`licenses/`](licenses/). Google's MediaPipe Tasks privacy notice states that input frames are processed on-device and are not sent to Google, while performance and utilization metrics may be sent. See the [MediaPipe package privacy notice](https://www.npmjs.com/package/@mediapipe/tasks-vision).
