import * as THREE from "three";
import { defaultScaleFor, loadAvatarBuffer } from "./avatar-format.js";

// Bake animations from an avatar file (.fbx or .glb) into webm video Blobs.
// Renders each clip on an offscreen Three.js canvas and captures via
// MediaRecorder + canvas.captureStream — no extra encoder dependencies.
//
// Loops are clipped to LOOP_BAKE_SECONDS so we don't ship a 60s recording
// for an idle clip. One-shots use the clip's natural duration.
//
// Usage:
//   const baker = await createAnimationBaker(avatarFile, scale);
//     scale=null/undefined → format default (0.01 fbx, 1.0 glb)
//   const blob = await baker.bake({ name: "wave_once", durationMs: 1800, loop: false });
//   ...
//   baker.dispose();

const FRAME_RATE = 30;
const LOOP_BAKE_SECONDS = 2.0;
const MIN_BAKE_SECONDS = 0.5;
const PIXELS = 480;

// Mime types we'll try in order. webm/vp9 is the cleanest; vp8 is the fallback;
// h264 is a last resort for environments where Chromium ships without VP*.
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
];

function pickMime() {
  for (const mime of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

export async function createAnimationBaker(avatarFile, scaleOverride) {
  const buffer = await avatarFile.arrayBuffer();
  const { format, object: root, animations: parsedAnimations } =
    await loadAvatarBuffer(buffer, avatarFile.name ?? "");
  const scale =
    typeof scaleOverride === "number" ? scaleOverride : defaultScaleFor(format);
  root.scale.setScalar(scale);

  const canvas = document.createElement("canvas");
  canvas.width = PIXELS;
  canvas.height = PIXELS;
  // Don't append — pure offscreen.

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(PIXELS, PIXELS, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Transparent so the gif overlays cleanly on chat backgrounds.
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(root);

  // Three-point lighting consistent with the live AvatarScene.
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(2, 4, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb0c4ff, 0.4);
  fill.position.set(-2, 2, 1);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  // Frame head-and-shoulders for ~1.7m humanoids. Avatars far off this size
  // can override fbxScale before bake.
  camera.position.set(0, 1.55, 1.6);
  camera.lookAt(0, 1.45, 0);

  const mixer = new THREE.AnimationMixer(root);
  const clipsByName = new Map();
  for (const clip of parsedAnimations ?? []) {
    clipsByName.set(clip.name, clip);
  }

  const mime = pickMime();
  if (!mime) {
    throw new Error(
      "MediaRecorder doesn't support webm or mp4 in this environment — cannot bake animations.",
    );
  }

  let activeAction = null;

  function setActive(clip) {
    if (activeAction) {
      activeAction.stop();
      activeAction = null;
    }
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    activeAction = action;
  }

  async function bake(entry) {
    const clip = clipsByName.get(entry.name);
    if (!clip) throw new Error(`no clip named ${entry.name} in this fbx`);

    // Decide how long to record.
    const naturalSec = clip.duration;
    const oneShotSec = entry.durationMs ? entry.durationMs / 1000 : naturalSec;
    const loop = Boolean(entry.loop);
    const targetSec = Math.max(
      MIN_BAKE_SECONDS,
      loop ? LOOP_BAKE_SECONDS : oneShotSec,
    );

    setActive(clip);

    // Render one frame so the canvas has visual content before captureStream
    // grabs it (some browsers freeze on a blank canvas).
    mixer.update(0);
    renderer.render(scene, camera);

    const stream = canvas.captureStream(FRAME_RATE);
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 1_500_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const finished = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e) => reject(e?.error ?? new Error("recorder error"));
    });

    const startTs = performance.now();
    let stopRequested = false;

    recorder.start();
    // Drive the render loop manually so timing is deterministic.
    const frame = () => {
      const elapsedSec = (performance.now() - startTs) / 1000;
      const dt = 1 / FRAME_RATE;
      mixer.update(dt);
      renderer.render(scene, camera);
      if (elapsedSec >= targetSec) {
        if (!stopRequested) {
          stopRequested = true;
          recorder.requestData?.();
          recorder.stop();
        }
        return;
      }
      // Cap below requestAnimationFrame's monitor refresh so we don't outrun
      // captureStream — captureStream samples at FRAME_RATE Hz independently.
      setTimeout(frame, 1000 / FRAME_RATE);
    };
    frame();

    await finished;

    // Stop the action so the next bake starts clean.
    setActive(null);

    return new Blob(chunks, { type: mime });
  }

  function dispose() {
    if (activeAction) activeAction.stop();
    mixer.stopAllAction();
    renderer.dispose();
    scene.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose?.();
      }
    });
  }

  // Map mime → file extension for naming on disk.
  function extForMime() {
    if (mime.startsWith("video/webm")) return "webm";
    if (mime.startsWith("video/mp4")) return "mp4";
    return "webm";
  }

  return { bake, dispose, extForMime, mime };
}
