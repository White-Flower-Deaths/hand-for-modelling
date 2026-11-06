import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const CDN_ROOT = 'https://cdn.jsdelivr.net/npm';
const THREE_VISION_VERSION = '1.2.2';
const MEDIAPIPE_PACKAGE = `${CDN_ROOT}/@mediapipe/tasks-vision@${THREE_VISION_VERSION}`;
const MEDIAPIPE_WASM = `${MEDIAPIPE_PACKAGE}/wasm`;
const HAND_MODEL = new URL('../assets/hand_landmarker.task', import.meta.url).href;
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const video = $('webcam');
const rendererHost = $('rendererHost');
const handCanvas = $('handCanvas');
const handCtx = handCanvas.getContext('2d');
const infoDialog = $('infoDialog');

const state = {
  renderer: null,
  scene: null,
  camera: null,
  pivot: null,
  mixer: null,
  animationFrame: 0,
  stream: null,
  landmarker: null,
  landmarkerPromise: null,
  trackerDelegate: '',
  detectionFailed: false,
  lastVideoTime: -1,
  lastDetectionAt: 0,
  stageVisible: true,
  previousGesture: '',
  gestureAnchor: null,
  lastGestureAt: 0,
  gestureAlpha: 0,
  stageRect: { width: 0, height: 0 },
  motionEnabled: true,
  showLandmarks: true,
  debugHands: [],
  cameraDeviceId: '',
  cameraConsentGranted: false,
  usedObjectUrls: [],
  dragging: null,
  spinning: false,
  autoRotateDirection: 0,
  autoRotateUntil: 0,
  frameCounter: 0,
  lastFpsAt: performance.now(),
  initialized: false,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, amount) => a + (b - a) * amount;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const GESTURE_SMOOTHING_SECONDS = 0.045;
const MAX_GESTURE_STEP = THREE.MathUtils.degToRad(6);
const GESTURE_DEAD_ZONE = THREE.MathUtils.degToRad(0.15);
const AUTO_ROTATE_SPEED = THREE.MathUtils.degToRad(26);
const AUTO_ROTATE_HOLD_MS = 350;
const SINGLE_PINCH_RATIO = 0.45;
const DOUBLE_PINCH_RATIO = 0.42;
const wrapRadians = (angle) => {
  const period = Math.PI * 2;
  const wrapped = (angle + Math.PI) % period;
  return (wrapped <= 0 ? wrapped + period : wrapped) - Math.PI;
};

function setText(id, value) {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
}

function setHudText(value) {
  setText('hudText', value);
}

function setStatus(status, hint = '') {
  setText('trackingStatus', status);
  if (hint) setText('trackingHint', hint);
}

function setGestureToast(title, detail, icon = '✋') {
  setText('toastTitle', title);
  setText('toastDetail', detail);
  setText('toastIcon', icon);
}

function showToast(message, detail = '', type = '') {
  const toast = document.createElement('div');
  toast.className = `app-toast ${type}`.trim();
  toast.textContent = message;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    toast.append(small);
  }
  $('toastRegion').append(toast);
  window.setTimeout(() => toast.remove(), 4700);
}

function openInfo(title, body, eyebrow = 'ABOUT THE CAMERA') {
  $('dialogActions').hidden = true;
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren();
  $('dialogEyebrow').textContent = eyebrow;
  for (const paragraph of body) {
    const p = document.createElement('p');
    p.innerHTML = paragraph;
    $('dialogBody').append(p);
  }
  infoDialog.showModal();
}

function initializeScene() {
  if (state.initialized) return;
  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  state.camera.position.set(0, 0, 8);
  state.camera.lookAt(0, 0, 0);

  state.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance' });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  state.renderer.setClearColor(0x000000, 0);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.1;
  rendererHost.append(state.renderer.domElement);

  state.scene.add(new THREE.HemisphereLight(0xdfffe8, 0x27302b, 2.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
  keyLight.position.set(-3.5, 5, 7);
  state.scene.add(keyLight);
  const mintLight = new THREE.PointLight(0x9dffbc, 18, 14);
  mintLight.position.set(3.5, 0, 3);
  state.scene.add(mintLight);
  const rimLight = new THREE.PointLight(0xb7d9ff, 12, 12);
  rimLight.position.set(-2, 2, -2);
  state.scene.add(rimLight);

  state.initialized = true;
  resizeStage();
  new ResizeObserver(resizeStage).observe(stage);
  if ('IntersectionObserver' in window) {
    const stageVisibility = new IntersectionObserver(([entry]) => {
      state.stageVisible = Boolean(entry?.isIntersecting);
    }, { threshold: 0 });
    stageVisibility.observe(stage);
  }
  requestAnimationFrame(renderLoop);
}

function resizeStage() {
  if (!state.renderer) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  state.stageRect = { width: rect.width, height: rect.height };
  state.renderer.setSize(rect.width, rect.height, false);
  state.camera.aspect = rect.width / rect.height;
  state.camera.updateProjectionMatrix();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  handCanvas.width = Math.round(rect.width * pixelRatio);
  handCanvas.height = Math.round(rect.height * pixelRatio);
  handCanvas.style.width = `${rect.width}px`;
  handCanvas.style.height = `${rect.height}px`;
  handCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function renderLoop(now) {
  state.animationFrame = requestAnimationFrame(renderLoop);
  if (!state.renderer) return;
  const delta = Math.min(0.05, (now - (state.lastRenderAt || now)) / 1000);
  state.lastRenderAt = now;
  trackHands(now);
  if (state.mixer) state.mixer.update(delta);
  if (state.spinning && state.pivot && !state.dragging) {
    state.pivot.rotation.y = wrapRadians(state.pivot.rotation.y + THREE.MathUtils.degToRad(28) * delta);
    syncTransformControls();
  }
  if (state.autoRotateDirection && state.pivot && !state.dragging) {
    if (now < state.autoRotateUntil) {
      state.pivot.rotation.y = wrapRadians(state.pivot.rotation.y + state.autoRotateDirection * AUTO_ROTATE_SPEED * delta);
      syncTransformControls();
    } else {
      stopAutoRotate();
    }
  }
  state.renderer.render(state.scene, state.camera);
  state.frameCounter += 1;
  if (now - state.lastFpsAt > 1000) {
    $('fpsBadge').textContent = `${Math.round((state.frameCounter * 1000) / (now - state.lastFpsAt))} FPS`;
    state.frameCounter = 0;
    state.lastFpsAt = now;
  }
}

function trackHands(now) {
  if (!state.landmarker || !state.stream) return;
  if (document.hidden || !state.stageVisible) return;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  let result;
  try {
    result = state.landmarker.detectForVideo(video, now);
  } catch (error) {
    console.error('Hand tracking frame failed', error);
    setStatus('Tracking paused', 'Reload the page to restart hand tracking');
    state.landmarker = null;
    return;
  }
  state.lastDetectionAt = performance.now();
  state.debugHands = result && result.landmarks ? result.landmarks : [];
  applyHandMotion(state.debugHands);
  drawHandOverlay();
}

function stagePointFromLandmark(landmark) {
  const rect = state.stageRect;
  const sourceWidth = video.videoWidth || rect.width;
  const sourceHeight = video.videoHeight || rect.height;
  const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  const cropX = (scaledWidth - rect.width) / 2;
  const cropY = (scaledHeight - rect.height) / 2;
  return {
    x: (1 - landmark.x) * scaledWidth - cropX,
    y: landmark.y * scaledHeight - cropY,
  };
}

function normalizedToWorld(point) {
  const width = Math.max(1, state.stageRect.width);
  const height = Math.max(1, state.stageRect.height);
  const ndcX = (point.x / width) * 2 - 1;
  const ndcY = 1 - (point.y / height) * 2;
  const distance = state.camera.position.z;
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(state.camera.fov) / 2) * distance;
  return { x: ndcX * viewHeight * state.camera.aspect / 2, y: ndcY * viewHeight / 2 };
}

function palmCenter(landmarks) {
  const ids = [0, 5, 9, 13, 17];
  const center = ids.reduce((acc, id) => ({ x: acc.x + landmarks[id].x / ids.length, y: acc.y + landmarks[id].y / ids.length }), { x: 0, y: 0 });
  return stagePointFromLandmark(center);
}

function palmNormal(landmarks) {
  const wrist = landmarks[0];
  const little = landmarks[17];
  const index = landmarks[5];
  const ax = little.x - wrist.x;
  const ay = little.y - wrist.y;
  const az = (little.z || 0) - (wrist.z || 0);
  const bx = index.x - wrist.x;
  const by = index.y - wrist.y;
  const bz = (index.z || 0) - (wrist.z || 0);
  const normal = {
    x: ay * bz - az * by,
    y: az * bx - ax * bz,
    z: ax * by - ay * bx,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function orientationFromNormal(normal) {
  return {
    yaw: Math.atan2(normal.x, normal.z),
    pitch: Math.atan2(-normal.y, Math.hypot(normal.x, normal.z)),
  };
}

function averagePalmOrientation(handA, handB) {
  const normalA = palmNormal(handA);
  let normalB = palmNormal(handB);
  const dot = normalA.x * normalB.x + normalA.y * normalB.y + normalA.z * normalB.z;
  if (dot < 0) normalB = { x: -normalB.x, y: -normalB.y, z: -normalB.z };
  const normal = {
    x: normalA.x + normalB.x,
    y: normalA.y + normalB.y,
    z: normalA.z + normalB.z,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return orientationFromNormal({ x: normal.x / length, y: normal.y / length, z: normal.z / length });
}

function gestureAlphaForFrame() {
  const now = performance.now();
  const elapsed = state.lastGestureAt ? Math.min(0.25, (now - state.lastGestureAt) / 1000) : GESTURE_SMOOTHING_SECONDS;
  state.lastGestureAt = now;
  return 1 - Math.exp(-elapsed / GESTURE_SMOOTHING_SECONDS);
}

function followAngle(target, anchor, key, alpha) {
  const delta = angleDelta(target, anchor[key]);
  const step = clamp(delta * alpha, -MAX_GESTURE_STEP, MAX_GESTURE_STEP);
  anchor[key] = wrapRadians(anchor[key] + step);
  return step;
}

function setGestureMode(mode, anchor) {
  state.previousGesture = mode;
  state.gestureAnchor = anchor;
}

function startAutoRotate(direction) {
  state.autoRotateDirection = direction;
  state.autoRotateUntil = performance.now() + AUTO_ROTATE_HOLD_MS;
  if (state.spinning) setSpin(false);
}

function stopAutoRotate() {
  state.autoRotateDirection = 0;
  state.autoRotateUntil = 0;
}

function extendedFingerCount(landmarks) {
  const wrist = landmarks[0];
  const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]];
  let count = 0;
  for (const [tipId, pipId] of pairs) {
    if (dist2(landmarks[tipId], wrist) > dist2(landmarks[pipId], wrist) * 1.08) count += 1;
  }
  return count;
}

function pinchRatio(landmarks) {
  const palm = dist2(landmarks[0], landmarks[9]);
  return dist2(landmarks[4], landmarks[8]) / Math.max(palm, 0.02);
}


function applyHandMotion(hands) {
  setText('handCount', String(hands.length));
  if (!hands.length) {
    state.lastGestureAt = 0;
    stopAutoRotate();
    $('trackingCard').classList.remove('locked');
    $('trackingCard').classList.toggle('active', state.motionEnabled);
    if (!state.motionEnabled) {
      setStatus('Motion control paused', 'Use the controls or turn it back on');
      setHudText('MOTION CONTROL PAUSED');
    } else {
      setStatus('Show your hand', state.pivot ? 'Move into the camera frame' : 'Add a model to use hand control');
      setHudText(state.pivot ? 'LOOKING FOR HANDS' : 'MODEL REQUIRED');
    }
    setGestureMode('', null);
    return;
  }

  $('trackingCard').classList.add('active');
  if (!state.motionEnabled || !state.pivot) {
    state.lastGestureAt = 0;
    stopAutoRotate();
    setStatus(state.motionEnabled ? 'Load a model' : 'Motion control paused', state.motionEnabled ? 'Add a model to use hand control' : 'Use the controls or turn it back on');
    setHudText(state.motionEnabled ? 'MODEL REQUIRED' : 'MOTION CONTROL PAUSED');
    setGestureMode('', null);
    return;
  }

  state.gestureAlpha = gestureAlphaForFrame();

  if (hands.length >= 2) {
    const handA = hands[0];
    const handB = hands[1];
    const bothPinching = pinchRatio(handA) < DOUBLE_PINCH_RATIO && pinchRatio(handB) < DOUBLE_PINCH_RATIO;
    if (bothPinching) {
      startAutoRotate(1);
      setGestureMode('', null);
      $('trackingCard').classList.remove('locked');
      setStatus('Auto-rotating anticlockwise', 'Release the pinch to stop');
      setHudText('AUTO-ROTATE · ANTICLOCKWISE');
      setGestureToast('Auto-rotate', 'Both hands pinched: the model turns anticlockwise', '↺');
      return;
    }
    stopAutoRotate();

    const aCenter = palmCenter(handA);
    const bCenter = palmCenter(handB);
    const midpoint = { x: (aCenter.x + bCenter.x) / 2, y: (aCenter.y + bCenter.y) / 2 };
    const target = normalizedToWorld(midpoint);
    const distance = Math.max(0.03, dist2(handA[9], handB[9]));
    const orientation = averagePalmOrientation(handA, handB);
    const roll = -Math.atan2(bCenter.y - aCenter.y, bCenter.x - aCenter.x);
    if (state.previousGesture !== 'twoHands') {
      setGestureMode('twoHands', {
        center: target,
        distance,
        scale: state.pivot.scale.x,
        position: state.pivot.position.clone(),
        yaw: orientation.yaw,
        pitch: orientation.pitch,
        roll,
      });
    } else {
      const anchor = state.gestureAnchor;
      const nextX = lerp(state.pivot.position.x, anchor.position.x + target.x - anchor.center.x, state.gestureAlpha);
      const nextY = lerp(state.pivot.position.y, anchor.position.y + target.y - anchor.center.y, state.gestureAlpha);
      let changed = false;
      if (Math.abs(nextX - state.pivot.position.x) > 0.0001) { state.pivot.position.x = nextX; changed = true; }
      if (Math.abs(nextY - state.pivot.position.y) > 0.0001) { state.pivot.position.y = nextY; changed = true; }
      const maxScale = Number($('scaleSlider').max) / 100;
      const scale = clamp(lerp(state.pivot.scale.x, anchor.scale * (distance / anchor.distance), state.gestureAlpha), 0.3, maxScale);
      if (Math.abs(scale - state.pivot.scale.x) > 0.0005) { state.pivot.scale.setScalar(scale); changed = true; }
      const yawStep = followAngle(orientation.yaw, anchor, 'yaw', state.gestureAlpha);
      const pitchStep = followAngle(orientation.pitch, anchor, 'pitch', state.gestureAlpha);
      const rollStep = followAngle(roll, anchor, 'roll', state.gestureAlpha);
      if (Math.abs(yawStep) >= GESTURE_DEAD_ZONE) { state.pivot.rotation.y = wrapRadians(state.pivot.rotation.y + yawStep); changed = true; }
      if (Math.abs(pitchStep) >= GESTURE_DEAD_ZONE) { state.pivot.rotation.x = wrapRadians(state.pivot.rotation.x + pitchStep); changed = true; }
      if (Math.abs(rollStep) >= GESTURE_DEAD_ZONE) { state.pivot.rotation.z = wrapRadians(state.pivot.rotation.z + rollStep); changed = true; }
      if (changed) syncTransformControls();
    }
    $('trackingCard').classList.remove('locked');
    setStatus('Turn with two hands', 'Move both to reposition; spread or close to resize');
    setHudText('ROTATE · TWO HANDS');
    setGestureToast('Rotate', 'Turn both hands as one to rotate; spread to resize', '↔');
    return;
  }

  const hand = hands[0];
  const fingers = extendedFingerCount(hand);
  const pinching = pinchRatio(hand) < SINGLE_PINCH_RATIO;

  if (fingers === 0) {
    stopAutoRotate();
    setGestureMode('lock', null);
    $('trackingCard').classList.add('locked');
    setStatus('Model locked', 'Open your hand to move it again');
    setHudText('LOCKED · FIST');
    setGestureToast('Locked', 'Make a fist to hold the model still', '✊');
    return;
  }

  $('trackingCard').classList.remove('locked');

  if (pinching) {
    startAutoRotate(-1);
    setGestureMode('', null);
    setStatus('Auto-rotating clockwise', 'Open your hand to stop');
    setHudText('AUTO-ROTATE · CLOCKWISE');
    setGestureToast('Auto-rotate', 'Pinch with one hand: the model turns clockwise', '↻');
    return;
  }

  stopAutoRotate();
  const center = palmCenter(hand);
  const target = normalizedToWorld(center);
  if (state.previousGesture !== 'move') {
    setGestureMode('move', { center: target, position: state.pivot.position.clone() });
  } else {
    const anchor = state.gestureAnchor;
    const nextX = lerp(state.pivot.position.x, anchor.position.x + target.x - anchor.center.x, state.gestureAlpha);
    const nextY = lerp(state.pivot.position.y, anchor.position.y + target.y - anchor.center.y, state.gestureAlpha);
    let changed = false;
    if (Math.abs(nextX - state.pivot.position.x) > 0.0001) { state.pivot.position.x = nextX; changed = true; }
    if (Math.abs(nextY - state.pivot.position.y) > 0.0001) { state.pivot.position.y = nextY; changed = true; }
    if (changed) syncTransformControls();
  }
  setStatus('Move', 'Move your open hand to reposition the model');
  setHudText('MOVE · OPEN HAND');
  setGestureToast('Move', 'Move your open hand to reposition', '✋');
}

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawHandOverlay() {
  const rect = state.stageRect;
  handCtx.clearRect(0, 0, rect.width, rect.height);
  if (!state.showLandmarks || !state.debugHands.length || !state.stream) return;
  for (const hand of state.debugHands) {
    handCtx.lineWidth = 1.4;
    handCtx.strokeStyle = 'rgba(205,255,161,.78)';
    handCtx.fillStyle = 'rgba(214,255,177,.95)';
    handCtx.shadowColor = 'rgba(183,255,128,.6)';
    handCtx.shadowBlur = 5;
    for (const [a, b] of HAND_LINKS) {
      const start = stagePointFromLandmark(hand[a]);
      const end = stagePointFromLandmark(hand[b]);
      handCtx.beginPath();
      handCtx.moveTo(start.x, start.y);
      handCtx.lineTo(end.x, end.y);
      handCtx.stroke();
    }
    for (const point of hand) {
      const pos = stagePointFromLandmark(point);
      handCtx.beginPath();
      handCtx.arc(pos.x, pos.y, 2.35, 0, Math.PI * 2);
      handCtx.fill();
    }
  }
  handCtx.shadowBlur = 0;
}

function syncTransformControls() {
  if (!state.pivot) return;
  const scalePercent = Math.round(state.pivot.scale.x * 100);
  let rotationDegrees = Math.round(THREE.MathUtils.radToDeg(wrapRadians(state.pivot.rotation.y)));
  if (rotationDegrees <= -180) rotationDegrees = 180;
  const scaleSlider = $('scaleSlider');
  const rotateSlider = $('rotateSlider');
  const nextScale = String(clamp(scalePercent, 30, Number(scaleSlider.max)));
  const nextRotation = String(clamp(rotationDegrees, -180, 180));
  if (scaleSlider.value !== nextScale) {
    scaleSlider.value = nextScale;
    paintSlider(scaleSlider);
  }
  if ($('scaleOutput').value !== `${scalePercent}%`) $('scaleOutput').value = `${scalePercent}%`;
  if (rotateSlider.value !== nextRotation) {
    rotateSlider.value = nextRotation;
    paintSlider(rotateSlider);
  }
  if ($('rotateOutput').value !== `${rotationDegrees}°`) $('rotateOutput').value = `${rotationDegrees}°`;
}

function setSpin(enabled) {
  state.spinning = Boolean(enabled && state.pivot);
  if (state.spinning) stopAutoRotate();
  const button = $('spinButton');
  button.disabled = !state.pivot;
  button.setAttribute('aria-pressed', String(state.spinning));
  button.textContent = state.spinning ? 'Stop spin' : 'Spin';
}

function paintSlider(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(to right, var(--green) 0%, var(--green) ${percent}%, #39443d ${percent}%, #39443d 100%)`;
}

function disposeCurrentModel() {
  if (state.pivot) {
    state.scene.remove(state.pivot);
    state.pivot.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          for (const key of ['map','normalMap','roughnessMap','metalnessMap','emissiveMap','alphaMap']) material[key]?.dispose();
          material.dispose();
        }
      }
    });
  }
  for (const url of state.usedObjectUrls) URL.revokeObjectURL(url);
  state.usedObjectUrls = [];
  state.pivot = null;
  state.mixer = null;
  setSpin(false);
  stopAutoRotate();
  state.previousGesture = '';
  state.gestureAnchor = null;
  $('modelInfo').classList.remove('loaded');
  $('stageModelTitle').textContent = 'Untitled scene';
  $('modelName').textContent = 'No model loaded';
  $('modelDetails').textContent = 'Try the sample object below';
  $('scaleSlider').value = '100';
  $('rotateSlider').value = '0';
  syncTransformControls();
}

function attachModel(object, name, details = '3D model ready', animations = [], objectUrls = []) {
  disposeCurrentModel();
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw new Error('This file does not contain a visible 3D mesh.');
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  object.position.sub(center);
  object.scale.multiplyScalar(2.65 / Math.max(maxDimension, 0.001));
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if ('roughness' in material && material.roughness > 0.9) material.roughness = 0.68;
        material.needsUpdate = true;
      }
    }
  });
  const pivot = new THREE.Group();
  pivot.add(object);
  state.scene.add(pivot);
  state.pivot = pivot;
  setSpin(false);
  state.usedObjectUrls = objectUrls;
  if (animations.length) {
    state.mixer = new THREE.AnimationMixer(object);
    for (const clip of animations) state.mixer.clipAction(clip).play();
  }
  $('modelName').textContent = name;
  $('modelDetails').textContent = `${details}${animations.length ? ` · ${animations.length} animation${animations.length > 1 ? 's' : ''}` : ''}`;
  $('modelInfo').classList.add('loaded');
  $('stageModelTitle').textContent = name.replace(/\.[^.]+$/, '').slice(0, 28);
  syncTransformControls();
  setGestureToast('Model is on stage', state.motionEnabled ? 'Open hand to move, pinch to auto-rotate' : 'Use the sliders or drag to position', '✋');
}

function makeSampleModel() {
  const root = new THREE.Group();
  const ceramic = new THREE.MeshPhysicalMaterial({ color: 0xc4f277, roughness: 0.28, metalness: 0.05, clearcoat: 0.75, clearcoatRoughness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2924, roughness: 0.32, metalness: 0.2 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xe3ffd0, emissive: 0x5a8f3b, emissiveIntensity: 0.65, roughness: 0.25 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.82, 48, 36), ceramic);
  body.scale.set(0.83, 1.05, 0.72);
  body.position.y = -0.12;
  root.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.53, 40, 32), ceramic);
  head.position.y = 0.86;
  root.add(head);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 18), ceramic);
    ear.scale.set(0.62, 1.55, 0.58);
    ear.position.set(side * 0.39, 1.17, 0.04);
    ear.rotation.z = side * -0.18;
    root.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.072, 20, 16), dark);
    eye.position.set(side * 0.19, 0.92, 0.47);
    eye.scale.set(1, 1, 0.48);
    root.add(eye);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.024, 14, 12), glow);
    glint.position.set(side * 0.19 - 0.018, 0.94, 0.509);
    root.add(glint);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 18, 14), dark);
  nose.scale.set(1.2, 0.7, 0.7);
  nose.position.set(0, 0.76, 0.51);
  root.add(nose);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.026, 10, 100), new THREE.MeshStandardMaterial({ color: 0x8de0bf, metalness: 0.75, roughness: 0.22, emissive: 0x173e2b, emissiveIntensity: 0.4 }));
  ring.rotation.x = Math.PI / 2.35;
  ring.position.y = -0.16;
  root.add(ring);
  const badge = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 16), glow);
  badge.position.set(0, -0.2, 0.63);
  badge.scale.set(0.9, 1.15, 0.45);
  root.add(badge);
  return root;
}

function normalizedFileName(value) {
  return decodeURIComponent(value).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function createFileManager(files) {
  const manager = new THREE.LoadingManager();
  const byPath = new Map();
  const byName = new Map();
  const objectUrls = [];
  for (const file of files) {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    const rel = normalizedFileName(file.webkitRelativePath || file.name);
    byPath.set(rel, url);
    byName.set(normalizedFileName(file.name), url);
  }
  manager.setURLModifier((requested) => {
    if (/^(data:|blob:|https?:)/i.test(requested)) return requested;
    const clean = normalizedFileName(new URL(requested, `${location.origin}/`).pathname);
    const fromPath = byPath.get(clean) || byPath.get(clean.replace(/^.*?\/(?:textures|images)\//, ''));
    const fromName = byName.get(clean.split('/').pop());
    return fromPath || fromName || requested;
  });
  return { manager, objectUrls };
}

async function loadModelFiles(fileList) {
  const files = Array.from(fileList).filter((file) => file instanceof File);
  if (!files.length) return;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_MODEL_BYTES) {
    showToast('Model files are too large', 'Choose up to 100 MB of model and texture files.', 'error');
    return;
  }
  const modelFile = files.find((file) => /\.(glb|gltf|obj|stl)$/i.test(file.name));
  if (!modelFile) {
    showToast('Choose a supported 3D model', 'Formats: GLB, GLTF, OBJ, or STL.', 'error');
    return;
  }
  initializeScene();
  $('modelName').textContent = 'Loading model…';
  $('modelDetails').textContent = 'Preparing local file';
  $('modelInfo').classList.add('loaded');
  const { manager, objectUrls } = createFileManager(files);
  const extension = modelFile.name.split('.').pop().toLowerCase();
  try {
    if (extension === 'glb' || extension === 'gltf') {
      const loader = new GLTFLoader(manager);
      const result = await new Promise((resolve, reject) => {
        const onLoad = (gltf) => resolve(gltf);
        const onError = (error) => reject(error instanceof Error ? error : new Error(String(error)));
        if (extension === 'glb') {
          modelFile.arrayBuffer().then((data) => loader.parse(data, '', onLoad, onError), reject);
        } else {
          modelFile.text().then((data) => loader.parse(data, '', onLoad, onError), reject);
        }
      });
      attachModel(result.scene, modelFile.name, `${formatBytes(modelFile.size)} · GLTF`, result.animations, objectUrls);
    } else if (extension === 'obj') {
      const objText = await modelFile.text();
      const mtl = files.find((file) => file.name.toLowerCase() === `${modelFile.name.replace(/\.obj$/i, '').toLowerCase()}.mtl`)
        || files.find((file) => file.name.toLowerCase().endsWith('.mtl'));
      let loader = new OBJLoader(manager);
      if (mtl) {
        const materialLoader = new MTLLoader(manager);
        const creator = materialLoader.parse(await mtl.text(), '');
        creator.preload();
        loader = loader.setMaterials(creator);
      }
      attachModel(loader.parse(objText), modelFile.name, `${formatBytes(modelFile.size)} · OBJ`, [], objectUrls);
    } else {
      const geometry = new STLLoader(manager).parse(await modelFile.arrayBuffer());
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xa9c5ab, roughness: 0.47, metalness: 0.12 }));
      attachModel(mesh, modelFile.name, `${formatBytes(modelFile.size)} · STL`, [], objectUrls);
    }
    showToast('Model loaded', 'Drag to rotate, Shift-drag to move, or use your hands.');
  } catch (error) {
    disposeCurrentModel();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    console.error('Model load failed', error);
    showToast('Could not load this model', error?.message || 'Check the file and try again.', 'error');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function createHandLandmarker() {
  if (state.landmarker) return state.landmarker;
  if (state.landmarkerPromise) return state.landmarkerPromise;

  state.landmarkerPromise = (async () => {
    const vision = await import(`${MEDIAPIPE_PACKAGE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    const options = {
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.52,
      minTrackingConfidence: 0.52,
    };
    try {
      state.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      });
      state.trackerDelegate = 'GPU';
    } catch (error) {
      console.info('GPU hand tracking is unavailable; using the CPU path.', error);
      state.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
      });
      state.trackerDelegate = 'CPU';
    }
    state.lastVideoTime = -1;
    return state.landmarker;
  })();

  try {
    return await state.landmarkerPromise;
  } catch (error) {
    state.landmarkerPromise = null;
    state.landmarker = null;
    throw error;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Camera access needs a secure local page', 'Open this app at localhost or on an HTTPS website.', 'error');
    return;
  }
  if (state.stream) return;
  state.lastVideoTime = -1;
  state.lastDetectionAt = 0;
  state.previousGesture = '';
  state.gestureAnchor = null;
  stopAutoRotate();
  $('cameraButton').disabled = true;
  $('cameraButton').querySelector('span').textContent = 'Starting camera…';
  $('topStatus').textContent = 'Connecting camera';
  setStatus('Starting camera', 'Allow access in your browser');
  try {
    const videoConstraint = state.cameraDeviceId
      ? { deviceId: { exact: state.cameraDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
      : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    stage.classList.add('camera-on');
    $('cameraStateText').textContent = 'Camera active on this device';
    $('cameraStateText').parentElement.classList.add('is-on');
    $('cameraStateLight').classList.add('is-on');
    $('stopCameraButton').disabled = false;
    $('cameraSelect').hidden = false;
    $('cameraButton').querySelector('span').textContent = 'Camera on';
    $('cameraButton').classList.remove('button-primary');
    $('cameraButton').classList.add('button-quiet');
    $('topStatus').textContent = 'Camera is live';
    setText('bottomTip', 'Open hand moves, one-hand pinch spins clockwise, both hands rotate and resize.');
    await refreshCameras(stream.getVideoTracks()[0]?.getSettings()?.deviceId || '');
    setStatus('Loading hand tracking', 'First start downloads the vision runtime');
    setHudText('LOADING HAND TRACKING');
    await createHandLandmarker();
    setStatus('Show your hand', 'Move into the camera frame');
    $('trackingCard').classList.add('active');
    setHudText('LOOKING FOR HANDS');
  } catch (error) {
    console.error('Camera setup failed', error);
    await stopCamera(false);
    const detail = error?.name === 'NotAllowedError'
      ? 'Allow camera access in the browser permission prompt.'
      : error?.name === 'NotFoundError'
        ? 'No camera was found on this device.'
        : 'Check camera permissions and try again.';
    setStatus('Camera unavailable', detail);
    $('topStatus').textContent = 'Camera unavailable';
    setHudText('CAMERA UNAVAILABLE');
    showToast('Could not start the camera', detail, 'error');
  } finally {
    $('cameraButton').disabled = false;
    if (!state.stream) $('cameraButton').querySelector('span').textContent = 'Enable camera';
  }
}

function requestCameraStart() {
  if (state.cameraConsentGranted) return startCamera();
  openInfo('A quick note before camera access.', [
    'Your camera starts only after you continue, and the camera can be stopped at any time. Video frames and imported models are processed in this browser and are not uploaded by this app.',
    'MediaPipe says its input frames stay on-device, but the library may send performance and usage metrics to Google. This app does not add analytics. The tracking runtime loads from jsDelivr; the hand model is included with the app.',
    'Press <strong>Continue & enable camera</strong> to proceed to your browser’s camera permission prompt. Choose <strong>Not now</strong> to keep the camera off.',
  ], 'CAMERA & DATA');
  $('dialogActions').hidden = false;
}

async function refreshCameras(activeId = state.cameraDeviceId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    const select = $('cameraSelect');
    select.replaceChildren();
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Default camera';
    select.append(fallback);
    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      select.append(option);
    });
    select.value = cameras.some((camera) => camera.deviceId === activeId) ? activeId : '';
    select.hidden = cameras.length < 2;
  } catch (error) {
    console.info('Camera list unavailable', error);
  }
}

async function stopCamera(updateStatus = true) {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state.stream = null;
  state.debugHands = [];
  state.lastVideoTime = -1;
  stopAutoRotate();
  video.pause();
  video.srcObject = null;
  stage.classList.remove('camera-on');
  handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
  $('cameraStateText').textContent = 'Camera not connected';
  $('cameraStateText').parentElement.classList.remove('is-on');
  $('cameraStateLight').classList.remove('is-on');
  $('stopCameraButton').disabled = true;
  await refreshCameras();
  $('cameraButton').querySelector('span').textContent = 'Enable camera';
  $('cameraButton').classList.add('button-primary');
  $('cameraButton').classList.remove('button-quiet');
  $('topStatus').textContent = 'Studio ready';
  $('handCount').textContent = '0';
  $('trackingCard').classList.remove('active', 'locked');
  setHudText('WAITING FOR CAMERA');
  setText('bottomTip', 'Open hand moves, one-hand pinch spins clockwise, both hands rotate and resize.');
  setGestureMode('', null);
  if (updateStatus) setStatus('Camera is off', 'Enable the camera to start');
}

async function switchCamera(deviceId) {
  state.cameraDeviceId = deviceId;
  if (!state.stream) return;
  await stopCamera(false);
  await startCamera();
}

function installInteractions() {
  $('cameraButton').addEventListener('click', () => state.stream ? stopCamera() : requestCameraStart());
  $('placeholderCameraButton').addEventListener('click', requestCameraStart);
  $('cancelCameraButton').addEventListener('click', () => infoDialog.close());
  $('continueCameraButton').addEventListener('click', () => {
    state.cameraConsentGranted = true;
    infoDialog.close();
    startCamera();
  });
  $('stopCameraButton').addEventListener('click', () => stopCamera());
  $('cameraSelect').addEventListener('change', (event) => switchCamera(event.target.value));
  $('browseButton').addEventListener('click', () => $('modelInput').click());
  $('modelInput').addEventListener('change', async (event) => {
    await loadModelFiles(event.target.files);
    event.target.value = '';
  });
  $('sampleButton').addEventListener('click', () => {
    initializeScene();
    attachModel(makeSampleModel(), 'Little Orbit', 'Built-in sample · procedural');
  });
  $('removeModelButton').addEventListener('click', disposeCurrentModel);
  $('resetButton').addEventListener('click', () => {
    if (!state.pivot) return;
    setSpin(false);
    stopAutoRotate();
    state.pivot.position.set(0, 0, 0);
    state.pivot.rotation.set(0, 0, 0);
    state.pivot.scale.setScalar(1);
    setGestureMode('', null);
    syncTransformControls();
  });
  $('motionToggle').addEventListener('change', (event) => {
    state.motionEnabled = event.target.checked;
    setGestureMode('', null);
    stopAutoRotate();
    setText('bottomTip', state.motionEnabled ? 'Open hand moves, one-hand pinch spins clockwise, both hands rotate and resize.' : 'Hand motion is paused. Drag or use the sliders.');
  });
  if (navigator.mediaDevices) {
    refreshCameras();
    if ('addEventListener' in navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => refreshCameras());
  }
  $('landmarksToggle').addEventListener('change', (event) => { state.showLandmarks = event.target.checked; });
  $('zoomLimitSelect').addEventListener('change', (event) => {
    const maxPercent = Number(event.target.value);
    $('scaleSlider').max = String(maxPercent);
    if (state.pivot) {
      state.pivot.scale.setScalar(Math.min(state.pivot.scale.x, maxPercent / 100));
      syncTransformControls();
    }
  });
  $('scaleSlider').addEventListener('input', (event) => {
    if (!state.pivot) return;
    state.pivot.scale.setScalar(Number(event.target.value) / 100);
    $('scaleOutput').value = `${event.target.value}%`;
    paintSlider(event.target);
    stopAutoRotate();
    setGestureMode('', null);
  });
  $('rotateSlider').addEventListener('input', (event) => {
    if (!state.pivot) return;
    state.pivot.rotation.y = THREE.MathUtils.degToRad(Number(event.target.value));
    $('rotateOutput').value = `${event.target.value}°`;
    paintSlider(event.target);
    stopAutoRotate();
    setGestureMode('', null);
  });
  $('spinButton').addEventListener('click', () => setSpin(!state.spinning));
  for (const input of document.querySelectorAll('.slider-control input')) paintSlider(input);

  rendererHost.addEventListener('pointerdown', (event) => {
    if (!state.pivot) return;
    const moveDrag = event.shiftKey || event.button === 2;
    rendererHost.setPointerCapture(event.pointerId);
    state.dragging = {
      x: event.clientX,
      y: event.clientY,
      position: state.pivot.position.clone(),
      rotation: state.pivot.rotation.clone(),
      move: moveDrag,
    };
    if (state.spinning) setSpin(false);
    stopAutoRotate();
    setGestureMode('', null);
  });
  rendererHost.addEventListener('pointermove', (event) => {
    if (!state.dragging || !state.pivot) return;
    const rect = stage.getBoundingClientRect();
    const dx = event.clientX - state.dragging.x;
    const dy = event.clientY - state.dragging.y;
    if (state.dragging.move) {
      const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(state.camera.fov) / 2) * state.camera.position.z;
      state.pivot.position.x = state.dragging.position.x + dx / rect.height * viewHeight * state.camera.aspect;
      state.pivot.position.y = state.dragging.position.y - dy / rect.height * viewHeight;
    } else {
      state.pivot.rotation.y = wrapRadians(state.dragging.rotation.y + dx * 0.009);
      state.pivot.rotation.x = wrapRadians(state.dragging.rotation.x + dy * 0.009);
    }
    syncTransformControls();
  });
  rendererHost.addEventListener('pointerup', () => { state.dragging = null; });
  rendererHost.addEventListener('pointercancel', () => { state.dragging = null; });
  rendererHost.addEventListener('wheel', (event) => {
    if (!state.pivot) return;
    event.preventDefault();
    const maxScale = Number($('scaleSlider').max) / 100;
    const scale = clamp(state.pivot.scale.x * (event.deltaY < 0 ? 1.06 : 0.94), 0.3, maxScale);
    state.pivot.scale.setScalar(scale);
    syncTransformControls();
    stopAutoRotate();
    setGestureMode('', null);
  }, { passive: false });
  rendererHost.addEventListener('contextmenu', (event) => event.preventDefault());

  $('fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch (error) { showToast('Could not enter fullscreen', error.message, 'error'); }
  });
  $('helpButton').addEventListener('click', () => openInfo('A little movement goes a long way.', [
    '<strong>Open hand:</strong> move your hand to move the model.',
    '<strong>One-hand pinch:</strong> the model turns clockwise on its own, like a turntable. Open your hand to stop.',
    '<strong>Both hands pinched:</strong> the model turns anticlockwise.',
    '<strong>Two hands:</strong> turn both as one to rotate the model left, right, up and down; move both to reposition, or spread and close them to resize.',
    '<strong>Fist:</strong> hold a fist to lock the model in place.',
    'Drag to rotate, Shift-drag to move, scroll to resize. Press <strong>Spin</strong> for a continuous turn; drag or press <strong>Reset</strong> to stop it.',
  ], 'GESTURE GUIDE'));
  $('privacyButton').addEventListener('click', () => openInfo('Your motion stays yours.', [
    'Camera access starts only after you press <strong>Enable camera</strong>. Video frames and imported models are processed in this browser and are not uploaded by this app. The camera stops when you press <strong>Stop camera</strong> or leave the page.',
    'The hand tracking library is MediaPipe Tasks Vision. Google says its input frames are processed on-device and are not sent to Google, but the library may send performance and usage metrics to Google. This app does not add analytics of its own.',
    'The first camera start loads the pinned MediaPipe runtime from jsDelivr. The hand model is included locally. Three.js and its model loaders also load from jsDelivr. An internet connection is needed for those libraries; camera access needs localhost or HTTPS.',
    '<a href="https://www.npmjs.com/package/@mediapipe/tasks-vision" target="_blank" rel="noreferrer">MediaPipe privacy notice</a> · <a href="https://threejs.org/manual/pages/installation.html" target="_blank" rel="noreferrer">Three.js CDN setup</a>',
  ], 'PRIVACY & CONNECTIONS'));

  document.addEventListener('dragenter', (event) => {
    if (event.dataTransfer?.types.includes('Files')) document.body.classList.add('dragging-page');
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('dragleave', (event) => {
    if (event.target === document.documentElement || event.target === document.body) document.body.classList.remove('dragging-page');
  });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging-page');
    if (event.dataTransfer?.files?.length) await loadModelFiles(event.dataTransfer.files);
  });
  const dropzone = $('browseButton');
  for (const type of ['dragenter','dragover']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('drag-over'); });
  for (const type of ['dragleave','drop']) dropzone.addEventListener(type, () => dropzone.classList.remove('drag-over'));
}

initializeScene();
installInteractions();

