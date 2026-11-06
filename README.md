# Form — Motion Studio

A small browser app for bringing a 3D model into a live webcam view and moving it with hand gestures. Model files and camera frames are handled locally in the browser.

## Run it on Windows

1. Double-click `start-app.bat`.
2. Open <http://127.0.0.1:8000> in a modern browser.
3. Choose **Load sample object** or import a `.glb`, `.gltf`, `.obj`, or `.stl` file.
4. Press **Enable camera**, read the camera and data notice, continue, then allow camera access in the browser.

Keep the server window open while using the app. Press `Ctrl+C` in that window to stop it. Camera access requires `localhost` or HTTPS; opening `index.html` as a `file://` URL will not enable it.

The first page load downloads the pinned Three.js runtime and model loaders from jsDelivr. The first camera start downloads MediaPipe's pinned browser runtime and WebAssembly files from jsDelivr. The hand-landmarker model is included at `assets/hand_landmarker.task`, so it does not need a separate model download. Internet access is needed for the libraries; there is no account, application backend, or hosted inference service.

## Gestures and controls

- **Open hand:** move your hand to move the model.
- **One-hand pinch:** pinch your thumb and index finger and the model starts turning clockwise on its own, like a turntable. Open your hand to stop.
- **Both hands pinched:** the model turns anticlockwise.
- **Two hands:** turn both hands as one to rotate the model left, right, up and down; move both to reposition it, or spread and close them to resize.
- **Fist:** hold a fist to lock the model in place.
- **Camera:** if this computer has more than one camera, pick one from the camera menu in the stage toolbar. "Default camera" follows the browser's usual choice.
- **Zoom limit:** choose a maximum from 100% to 1200% in **Object transform**; the default is 500%. The selected limit applies to the Size slider, mouse-wheel zoom, and two-hand resizing.
- **Mouse:** Drag to rotate, Shift-drag to move, scroll to resize. Use the Turn and Size sliders, or press Spin for continuous rotation. Drag again or press Reset to stop spinning.

Supported imports are GLB, GLTF, OBJ and STL. For a GLTF that references separate buffers or textures, select the `.gltf` and its related files together. GLB packages those files into one import and is the simplest option. Imports are limited to 100 MB total per load.

The sample object is generated from Three.js geometry in the app. It does not use downloaded sample media.

## Privacy and network use

Camera access starts only after the in-app notice and browser permission prompt. The app does not upload camera frames or model files. Google's MediaPipe Tasks notice says input frames are processed on-device and are not sent to Google; it also says the library may send performance and utilization metrics to Google. This app does not add its own analytics. See the in-app **Privacy details** for the same disclosure.

## Third-party components

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the `licenses/` folder for versions, sources, attribution, and license texts.
