import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { defaultScaleFor, detectFormat, loadAvatarBuffer } from "../lib/avatar-format.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  BarrelDistortionShader,
  ColorGradingShader,
  DistanceBlurShader,
  FilmGrainShader,
} from "../lib/post-processing-shaders.js";

// Avatar scene:
//   - loads an FBX, runs an idle clip, exposes playAnimation imperative API
//   - optional post-processing chain driven by `postProcessing` prop
//     (bloom, distance blur, barrel distortion, color grading, film grain)
//   - chain rebuilds when the *enabled set* changes; uniform tweaks live-apply
//
// Still not in scope: head/eye tracking, camera state machine, thinking sprite.

const IDLE_HINTS = ["idle", "stand", "breathing"];
// Crossfade duration between animation clips. ~400ms feels natural —
// long enough to smooth pose differences, short enough that quick
// gesture cues (wave, nod) still feel responsive. The return-to-idle
// path uses the same value.
const CROSSFADE_MS = 400;

// Default scale is now format-driven (see lib/avatar-format.js): 0.01 for FBX
// (Mixamo/Maya cm units), 1.0 for GLB/GLTF (typically meters). Per-avatar
// override via the `scale` prop.

// Treat anything that looks like a local OS path as needing IPC-bytes load.
// Bundled assets (Vite-served paths starting with /) and http(s) URLs go
// through three.js's normal loader.load(url, ...) pipeline.
function isLocalPath(p) {
  if (typeof p !== "string" || !p) return false;
  if (p.startsWith("file://")) return true;
  if (/^https?:\/\//i.test(p)) return false;
  if (p.startsWith("/")) return false; // app/public/assets/...
  // Windows drive letter, UNC, or POSIX absolute outside web root.
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  if (p.startsWith("~")) return true;
  return false;
}

async function readLocalAsArrayBuffer(rawPath) {
  if (!window.exuvia?.path?.expand || !window.exuvia?.fbx?.read) {
    console.warn("[scene] local-path IPC unavailable — running outside Electron?");
    return null;
  }
  // Strip file:// if present so the IPC sees a normal OS path.
  let p = String(rawPath);
  if (p.startsWith("file:///")) p = p.slice("file:///".length);
  else if (p.startsWith("file://")) p = p.slice("file://".length);
  const expanded = await window.exuvia.path.expand(p);
  const res = await window.exuvia.fbx.read(expanded);
  if (!res?.ok) {
    console.warn("[scene] local file read failed", expanded, res?.error);
    return null;
  }
  const bytes = res.bytes;
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes?.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(
      bytes.byteOffset ?? 0,
      (bytes.byteOffset ?? 0) + bytes.byteLength,
    );
  }
  if (Array.isArray(bytes?.data)) return new Uint8Array(bytes.data).buffer;
  console.warn("[scene] could not normalize bytes from IPC for", expanded);
  return null;
}

// Stable string identifying the *enabled set* of effects + the quality tier,
// so we know when to rebuild the composer chain vs. live-update uniforms.
const EFFECT_KEYS = ["bloom", "distanceBlur", "barrelDistortion", "colorGrading", "filmGrain"];
function signatureFor(cfg) {
  if (!cfg) return "";
  const parts = [];
  for (const k of EFFECT_KEYS) if (cfg[k]?.enabled) parts.push(k);
  if (parts.length === 0) return "";
  const quality = cfg.quality === "low" ? "lo" : "hi";
  return `${quality}:${parts.join("|")}`;
}

function pickIdleClip(animations) {
  if (!animations || animations.length === 0) return null;
  const lower = animations.map((c) => c.name.toLowerCase());
  for (const hint of IDLE_HINTS) {
    const idx = lower.findIndex((n) => n.includes(hint));
    if (idx >= 0) return animations[idx];
  }
  return animations[0];
}

const AvatarScene = forwardRef(function AvatarScene(
  {
    avatarPath, // .fbx or .glb / .gltf
    scale, // explicit override; falls back to defaultScaleFor(format)
    // Environment lighting + scenery. All optional.
    //   environmentHdriPath — .exr equirectangular HDRI used as
    //     scene.environment (image-based lighting / reflections) and as
    //     a dim sky background.
    //   environmentIntensity — multiplier on IBL contribution to the
    //     avatar's shading (default 1.0). Higher = more reflections.
    //   backgroundIntensity — multiplier on the visible sky brightness
    //     (default 0.3). Higher = brighter visible background.
    //   scenePath — GLB of a 3D set/room placed around the avatar.
    environmentHdriPath,
    environmentIntensity = 1.0,
    backgroundIntensity = 0.3,
    // Multiplier on the three baseline lights baked into the scene
    // (1× ambient + 2× directional). 0 = avatar lit only by HDRI.
    lightsIntensity = 1.0,
    // Custom per-avatar lights. Array of objects:
    //   { id, type: "directional"|"point"|"ambient",
    //     enabled, color, intensity, position?: [x,y,z], target?: [x,y,z] }
    // When undefined or empty, the scene uses the default key/fill/ambient
    // baked-in trio. lightsIntensity multiplies whichever set is active.
    lights,
    scenePath,
    // Multiplier applied to the environment GLB's root scale. Default 1.
    // Useful when the imported set is in different units than the avatar.
    environmentScale = 1.0,
    // When true (default), the orbit controls are disabled so mouse drags
    // pass through to the chat / picker UI underneath. Toggle off to fly
    // around the scene with the camera.
    cameraLocked = true,
    // backward-compat aliases for callers that still pass fbxPath/fbxScale
    fbxPath,
    fbxScale,
    postProcessing,
    onLoad,
    onError,
  },
  ref,
) {
  const resolvedPath = avatarPath ?? fbxPath ?? null;
  const resolvedScale =
    typeof scale === "number"
      ? scale
      : typeof fbxScale === "number"
        ? fbxScale
        : null; // null means "use format default"
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const composerRef = useRef(null);
  const passesRef = useRef({}); // { bloom, distanceBlur, barrel, colorGrading, filmGrain, output }
  const mixerRef = useRef(null);
  const envMixerRef = useRef(null); // animations on the environment GLB
  const envModelRef = useRef(null); // the env GLB root, so we can swap it out
  const hdriTextureRef = useRef(null); // current HDRI, disposed on swap
  const defaultLightsRef = useRef({ ambient: null, key: null, fill: null });
  // Lights built from the avatar's config — keyed by stable id so we can
  // edit individual lights without rebuilding the whole set.
  const customLightsRef = useRef(new Map());
  const clockRef = useRef(new THREE.Clock());
  const animationsRef = useRef([]); // { name, clip, action, duration, loop }
  const idleActionRef = useRef(null);
  const currentActionRef = useRef(null);
  const animationFrameRef = useRef(null);
  const oneShotTimerRef = useRef(null);
  const enabledSignatureRef = useRef("");

  const [status, setStatus] = useState("idle");
  const [statusDetail, setStatusDetail] = useState(null);
  // Bumped each time the avatar mesh finishes loading. Lights and post-FX
  // effects depend on this so they re-run after the model is in the scene
  // — without this, three.js sometimes renders the avatar unlit (or with
  // post-FX disabled) until the user touches a slider, because the
  // effects ran before the mesh existed and the renderer cached a
  // draw-call set that didn't include lighting/effects for the new mesh.
  const [modelLoadCount, setModelLoadCount] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      listAnimations() {
        return animationsRef.current.map((a) => ({
          name: a.name,
          duration: a.duration,
          loop: a.loop,
        }));
      },
      playAnimation(name) {
        const entry = animationsRef.current.find(
          (a) => a.name.toLowerCase() === String(name ?? "").toLowerCase(),
        );
        if (!entry) {
          console.warn("[scene] no animation named", name);
          return false;
        }
        crossfadeTo(entry);
        return true;
      },
      stop() {
        const idleAction = idleActionRef.current;
        if (!idleAction || currentActionRef.current === idleAction) return;
        const idleEntry = animationsRef.current.find((a) => a.action === idleAction);
        if (idleEntry) crossfadeTo(idleEntry);
      },
    }),
    [],
  );

  // Setup scene once on mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = null;
    sceneRef.current = scene;

    const container = containerRef.current;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 400;

    const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 100);
    camera.position.set(0, 1.5, 2.4);
    camera.lookAt(0, 1.4, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // OrbitControls — left-drag to rotate, right-drag to pan, wheel to zoom.
    // Mostly free orbit; only the polar floor limit (just below horizon) is
    // kept to stop the camera from clipping under the avatar's feet.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.4, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.2;
    controls.maxDistance = 12;
    // Allow looking from nearly straight up to slightly under horizon —
    // matches what the original ai-assistant scene allowed.
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI * 0.95;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.7;
    controls.update();
    // cameraLocked === true means controls are disabled (mouse passes through
    // to the chat overlay). Default lock-on so the chat is the primary
    // interaction; user explicitly unlocks to look around.
    controls.enabled = false;
    controlsRef.current = controls;

    // Baseline three-point-ish lighting so the avatar is visible without
    // an HDRI or custom lights. Used when avatar.lights is unset/empty.
    // Stored on a ref so we can disable them when custom lights take over.
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(2, 4, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb0c4ff, 0.4);
    fill.position.set(-2, 2, 1);
    scene.add(fill);
    defaultLightsRef.current = { ambient, key, fill };
    ambient.userData.baseIntensity = 0.6;
    key.userData.baseIntensity = 0.9;
    fill.userData.baseIntensity = 0.4;

    const onResize = () => {
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 400;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composerRef.current?.setSize(w, h);
      const dbp = passesRef.current.distanceBlur;
      if (dbp) dbp.uniforms.resolution.value.set(w, h);
    };
    window.addEventListener("resize", onResize);

    // Animation loop. Renders through the composer when one is built;
    // otherwise renders direct to canvas (cheaper, identical pixels).
    const tick = () => {
      animationFrameRef.current = requestAnimationFrame(tick);
      const dt = clockRef.current.getDelta();
      mixerRef.current?.update(dt);
      envMixerRef.current?.update(dt);
      controlsRef.current?.update();
      const grain = passesRef.current.filmGrain;
      if (grain) grain.uniforms.time.value += dt;
      const composer = composerRef.current;
      if (composer) composer.render(dt);
      else renderer.render(scene, camera);
    };
    tick();

    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animationFrameRef.current);
      clearTimeout(oneShotTimerRef.current);
      controlsRef.current?.dispose?.();
      controlsRef.current = null;
      composerRef.current?.dispose?.();
      composerRef.current = null;
      passesRef.current = {};
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Build/update the post-processing chain whenever `postProcessing` changes.
  // Strategy:
  //   - if no effects are enabled, drop the composer entirely (direct render)
  //   - if the enabled set changed, rebuild the chain
  //   - otherwise live-update uniforms in place
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const cfg = postProcessing ?? null;
    const enabled = signatureFor(cfg);

    if (!enabled) {
      composerRef.current?.dispose?.();
      composerRef.current = null;
      passesRef.current = {};
      enabledSignatureRef.current = "";
      return;
    }

    // Force a rebuild on every modelLoadCount bump too — the pre-built
    // composer was created against a scene that didn't yet contain the
    // avatar mesh. Cheaper than chasing material recompile races.
    const sigKey = `${enabled}#${modelLoadCount}`;
    if (sigKey !== enabledSignatureRef.current) {
      composerRef.current?.dispose?.();
      composerRef.current = null;
      passesRef.current = {};

      const container = containerRef.current;
      const w = container?.clientWidth || 600;
      const h = container?.clientHeight || 400;

      // LDR (UnsignedByte) target with sRGB color space so the renderer
      // applies tone mapping AND gamma encoding when writing the scene
      // through RenderPass. Without sRGBColorSpace, the HDRI background
      // ends up linear-encoded and display-sampling reads it as too-dark
      // / wrong-color (HDRI appears not to render). The sRGB tag also
      // prevents UnrealBloomPass from sampling raw linear values which
      // produced the square mip artifacts before.
      const composer = new EffectComposer(
        renderer,
        new THREE.WebGLRenderTarget(w, h, {
          type: THREE.UnsignedByteType,
          colorSpace: THREE.SRGBColorSpace,
        }),
      );
      composer.setSize(w, h);
      composer.addPass(new RenderPass(scene, camera));

      const passes = {};
      const lowQ = cfg.quality === "low";
      if (cfg.bloom?.enabled) {
        // Half-res bloom on low quality — same look, ~4× cheaper on the GPU.
        const bloomW = lowQ ? Math.max(64, Math.floor(w / 2)) : w;
        const bloomH = lowQ ? Math.max(64, Math.floor(h / 2)) : h;
        const p = new UnrealBloomPass(
          new THREE.Vector2(bloomW, bloomH),
          cfg.bloom.strength ?? 0.15,
          cfg.bloom.radius ?? 0.5,
          cfg.bloom.threshold ?? 0.9,
        );
        composer.addPass(p);
        passes.bloom = p;
      }
      if (cfg.distanceBlur?.enabled) {
        const p = new ShaderPass(DistanceBlurShader);
        p.uniforms.resolution.value = new THREE.Vector2(w, h);
        p.uniforms.blurStrength.value = cfg.distanceBlur.strength ?? 0.4;
        composer.addPass(p);
        passes.distanceBlur = p;
      }
      if (cfg.barrelDistortion?.enabled) {
        const p = new ShaderPass(BarrelDistortionShader);
        p.uniforms.amount.value = cfg.barrelDistortion.amount ?? 1.0;
        p.uniforms.zoom.value = cfg.barrelDistortion.zoom ?? 1.1;
        composer.addPass(p);
        passes.barrel = p;
      }
      if (cfg.colorGrading?.enabled) {
        const p = new ShaderPass(ColorGradingShader);
        const cg = cfg.colorGrading;
        p.uniforms.contrast.value = cg.contrast ?? 1.0;
        p.uniforms.brightness.value = cg.brightness ?? 0.0;
        p.uniforms.saturation.value = cg.saturation ?? 1.0;
        p.uniforms.temperature.value = cg.temperature ?? 0.0;
        p.uniforms.vignette.value = cg.vignette ?? 0.0;
        composer.addPass(p);
        passes.colorGrading = p;
      }
      if (cfg.filmGrain?.enabled) {
        const p = new ShaderPass(FilmGrainShader);
        p.uniforms.intensity.value = cfg.filmGrain.intensity ?? 0.06;
        p.uniforms.time.value = 0;
        composer.addPass(p);
        passes.filmGrain = p;
      }
      // No OutputPass — in this setup the renderer applies tone mapping &
      // sRGB conversion inside RenderPass (when materials render). OutputPass
      // would double-apply tone mapping in r163+, producing a very dark
      // image. The trade-off is that effects after RenderPass operate on
      // tone-mapped LDR values rather than HDR linear, which is what worked
      // in the previous three.js version anyway.
      const lastPass = composer.passes[composer.passes.length - 1];
      if (lastPass) lastPass.renderToScreen = true;

      composerRef.current = composer;
      passesRef.current = passes;
      enabledSignatureRef.current = sigKey;
      return;
    }

    // Live-update uniforms without rebuilding.
    const passes = passesRef.current;
    if (passes.bloom && cfg.bloom) {
      passes.bloom.strength = cfg.bloom.strength ?? 0.15;
      passes.bloom.radius = cfg.bloom.radius ?? 0.5;
      passes.bloom.threshold = cfg.bloom.threshold ?? 0.9;
    }
    if (passes.distanceBlur && cfg.distanceBlur) {
      passes.distanceBlur.uniforms.blurStrength.value =
        cfg.distanceBlur.strength ?? 0.4;
    }
    if (passes.barrel && cfg.barrelDistortion) {
      passes.barrel.uniforms.amount.value = cfg.barrelDistortion.amount ?? 1.0;
      passes.barrel.uniforms.zoom.value = cfg.barrelDistortion.zoom ?? 1.1;
    }
    if (passes.colorGrading && cfg.colorGrading) {
      const cg = cfg.colorGrading;
      passes.colorGrading.uniforms.contrast.value = cg.contrast ?? 1.0;
      passes.colorGrading.uniforms.brightness.value = cg.brightness ?? 0.0;
      passes.colorGrading.uniforms.saturation.value = cg.saturation ?? 1.0;
      passes.colorGrading.uniforms.temperature.value = cg.temperature ?? 0.0;
      passes.colorGrading.uniforms.vignette.value = cg.vignette ?? 0.0;
    }
    if (passes.filmGrain && cfg.filmGrain) {
      passes.filmGrain.uniforms.intensity.value = cfg.filmGrain.intensity ?? 0.06;
    }
  }, [postProcessing, modelLoadCount]);

  // Load (or reload) the HDRI environment map. Drives image-based lighting
  // (reflections, ambient color) and acts as a dim sky background.
  // Bundled URLs (e.g. /assets/hdri/scifi.exr) load directly. Local
  // file paths route through Electron IPC because the renderer can't
  // fetch file:// from an http origin.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (!environmentHdriPath) {
      if (hdriTextureRef.current) {
        hdriTextureRef.current.dispose?.();
        hdriTextureRef.current = null;
      }
      scene.environment = null;
      scene.background = null;
      return;
    }

    let cancelled = false;
    const applyTexture = (texture) => {
      if (cancelled) {
        texture.dispose?.();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = texture;
      scene.environmentIntensity = environmentIntensity;
      scene.background = texture;
      scene.backgroundIntensity = backgroundIntensity;
      if (hdriTextureRef.current && hdriTextureRef.current !== texture) {
        hdriTextureRef.current.dispose?.();
      }
      hdriTextureRef.current = texture;
      // Force every existing avatar material to recompile so they bind
      // the new scene.environment. Without this, the avatar mesh keeps
      // the program it compiled against the previous (null) environment
      // and stays unaffected by IBL until something else triggers an
      // update (e.g., the user touches a slider).
      scene.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material)
          ? child.material
          : child.material
            ? [child.material]
            : [];
        for (const m of mats) {
          if ("envMapIntensity" in m && m.envMapIntensity == null) {
            m.envMapIntensity = 1;
          }
          m.needsUpdate = true;
        }
      });
      if (rendererRef.current && cameraRef.current) {
        rendererRef.current.compile(scene, cameraRef.current);
      }
    };

    (async () => {
      try {
        const loader = new EXRLoader();
        if (isLocalPath(environmentHdriPath)) {
          const buffer = await readLocalAsArrayBuffer(environmentHdriPath);
          if (cancelled || !buffer) return;
          const texture = loader.parse(buffer);
          applyTexture(texture);
        } else {
          loader.load(
            environmentHdriPath,
            applyTexture,
            undefined,
            (err) =>
              console.warn(
                "[scene] HDRI load failed",
                environmentHdriPath,
                err,
              ),
          );
        }
      } catch (err) {
        console.warn("[scene] HDRI load error", environmentHdriPath, err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [environmentHdriPath]);

  // Live-update HDRI intensities when sliders move — cheap, no reload.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (scene.environment) {
      scene.environmentIntensity = environmentIntensity;
    }
    if (scene.background) {
      scene.backgroundIntensity = backgroundIntensity;
    }
  }, [environmentIntensity, backgroundIntensity]);

  // Reconcile the custom lights array into the scene. Lights are tracked by
  // id so editing one doesn't rebuild the others (cheap; no flicker).
  // When the user has any custom lights at all, the default trio is hidden
  // so the user gets exactly the setup they configured.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const cmap = customLightsRef.current;
    const wantIds = new Set();

    const arr = Array.isArray(lights) ? lights : [];

    for (const cfg of arr) {
      if (!cfg?.id) continue;
      wantIds.add(cfg.id);
      let light = cmap.get(cfg.id);

      // If type changed or it's new, (re)create.
      const wantType = cfg.type ?? "directional";
      if (!light || light.userData.lightType !== wantType) {
        if (light) {
          scene.remove(light);
          light.dispose?.();
        }
        if (wantType === "ambient") {
          light = new THREE.AmbientLight(0xffffff, 1);
        } else if (wantType === "point") {
          light = new THREE.PointLight(0xffffff, 1, 0, 2);
        } else {
          light = new THREE.DirectionalLight(0xffffff, 1);
        }
        light.userData.lightType = wantType;
        light.userData.isCustomLight = true;
        scene.add(light);
        cmap.set(cfg.id, light);
      }

      // Apply config to the light.
      const baseIntensity = cfg.enabled === false ? 0 : (cfg.intensity ?? 1);
      light.userData.baseIntensity = baseIntensity;
      light.intensity = baseIntensity * lightsIntensity;
      if (typeof cfg.color === "string") {
        light.color.set(cfg.color);
      }
      if (Array.isArray(cfg.position) && light.position) {
        light.position.set(cfg.position[0] ?? 0, cfg.position[1] ?? 0, cfg.position[2] ?? 0);
      }
      if (light.target && Array.isArray(cfg.target)) {
        light.target.position.set(cfg.target[0] ?? 0, cfg.target[1] ?? 0, cfg.target[2] ?? 0);
      }
    }

    // Remove lights that are no longer in config.
    for (const [id, light] of [...cmap.entries()]) {
      if (!wantIds.has(id)) {
        scene.remove(light);
        light.dispose?.();
        cmap.delete(id);
      }
    }

    // When there's any custom light at all, hide the defaults so the user
    // sees exactly what they configured. When the array is empty, restore.
    const { ambient, key, fill } = defaultLightsRef.current;
    const hasCustom = arr.length > 0;
    for (const l of [ambient, key, fill]) {
      if (l) l.visible = !hasCustom;
    }
    // Three.js caches a "lights uniform group" keyed by the set of
    // active lights in the scene. When lights are added before the
    // avatar mesh's materials first compile their shader programs,
    // those programs sometimes bind to a stale uniform group that
    // lacks the lights — the mesh draws unlit until something else
    // forces a re-link. Removing-and-re-adding each custom light is
    // the single signal three reliably treats as "lighting changed,
    // invalidate everything," matching what happens naturally when
    // the user toggles settings (which produces fresh light objects
    // with fresh ids). Doing it here mimics that effect without
    // waiting for user interaction.
    for (const light of customLightsRef.current.values()) {
      scene.remove(light);
      scene.add(light);
    }
    scene.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material)
        ? child.material
        : child.material
          ? [child.material]
          : [];
      for (const m of mats) {
        m.needsUpdate = true;
      }
    });
    if (rendererRef.current && cameraRef.current) {
      rendererRef.current.compile(scene, cameraRef.current);
    }
  }, [lights, lightsIntensity, modelLoadCount]);

  // Honor the cameraLocked prop on the orbit controls. Toggling this flips
  // mouse-event handling between "chat layer" (locked) and "scene layer"
  // (unlocked) — without rebuilding the controls.
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.enabled = !cameraLocked;
    }
  }, [cameraLocked]);

  // Live-scale every active light from the lightsIntensity prop. Each light
  // remembers its base intensity in userData so we can scale repeatedly
  // without losing the original value.
  useEffect(() => {
    const scaleLight = (light) => {
      if (!light) return;
      const base = light.userData.baseIntensity ?? light.intensity;
      light.intensity = base * lightsIntensity;
    };
    const { ambient, key, fill } = defaultLightsRef.current;
    scaleLight(ambient);
    scaleLight(key);
    scaleLight(fill);
    for (const light of customLightsRef.current.values()) {
      scaleLight(light);
    }
  }, [lightsIntensity]);

  // Load (or reload) the environment scene model — a GLB of a room/set/stage
  // that surrounds the avatar. Optional. Auto-plays any animations baked in
  // (helpful for moving stage lights, swaying trees, etc.).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Tear down any existing env model first.
    const teardown = () => {
      if (envMixerRef.current) {
        envMixerRef.current.stopAllAction();
        envMixerRef.current = null;
      }
      if (envModelRef.current) {
        scene.remove(envModelRef.current);
        envModelRef.current.traverse?.((obj) => {
          obj.geometry?.dispose?.();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) m?.dispose?.();
          }
        });
        envModelRef.current = null;
      }
    };

    if (!scenePath) {
      teardown();
      return;
    }

    let cancelled = false;
    teardown();

    const applyGltf = (gltf) => {
      if (cancelled) return;
      const root = gltf.scene;
      root.userData.isEnvironment = true;
      root.position.set(0, 0, 0);
      root.scale.setScalar(environmentScale);
      root.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      scene.add(root);
      envModelRef.current = root;

      if (gltf.animations?.length > 0) {
        const mixer = new THREE.AnimationMixer(root);
        for (const clip of gltf.animations) {
          mixer.clipAction(clip).play();
        }
        envMixerRef.current = mixer;
      }
    };

    (async () => {
      try {
        const loader = new GLTFLoader();
        if (isLocalPath(scenePath)) {
          const buffer = await readLocalAsArrayBuffer(scenePath);
          if (cancelled || !buffer) return;
          await new Promise((resolve, reject) => {
            loader.parse(buffer, "", (gltf) => {
              applyGltf(gltf);
              resolve();
            }, reject);
          });
        } else {
          loader.load(
            scenePath,
            applyGltf,
            undefined,
            (err) => console.warn("[scene] env GLB load failed", scenePath, err),
          );
        }
      } catch (err) {
        console.warn("[scene] env GLB load error", scenePath, err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scenePath]);

  // Live-scale the environment GLB without reloading. Decoupled from the
  // load effect so dragging the slider doesn't refetch+reparse the model.
  useEffect(() => {
    const root = envModelRef.current;
    if (root) root.scale.setScalar(environmentScale);
  }, [environmentScale]);

  // Load (or reload) the avatar whenever the path changes. Format is detected
  // from the file extension (.fbx, .glb, .gltf).
  //
  // We read bytes via Electron IPC instead of letting Three.js fetch the URL
  // directly. Reason: the renderer is served by Vite over http://, and
  // Chromium refuses to fetch file:// from an http origin. The IPC bridge
  // sidesteps the protocol gate and works the same in dev and packaged.
  useEffect(() => {
    if (!resolvedPath || !sceneRef.current) return;
    setStatus("loading");
    setStatusDetail(null);

    const scene = sceneRef.current;
    let cancelled = false;

    (async () => {
      try {
        const expanded = await window.exuvia.path.expand(resolvedPath);
        const readRes = await window.exuvia.fbx.read(expanded);
        if (cancelled) return;
        if (!readRes?.ok) {
          throw new Error(readRes?.error ?? "file read failed");
        }
        const bytes = readRes.bytes;
        // Electron IPC sometimes marshals Buffer/Uint8Array losslessly;
        // sometimes as { type: "Buffer", data: [...] }. Normalize.
        const buffer =
          bytes instanceof ArrayBuffer
            ? bytes
            : bytes?.buffer instanceof ArrayBuffer
              ? bytes.buffer.slice(
                  bytes.byteOffset ?? 0,
                  (bytes.byteOffset ?? 0) + bytes.byteLength,
                )
              : Array.isArray(bytes?.data)
                ? new Uint8Array(bytes.data).buffer
                : null;
        if (!buffer) {
          throw new Error("could not normalize file bytes from IPC");
        }
        return loadAvatarBuffer(buffer, expanded);
      } catch (err) {
        if (cancelled) return;
        console.error("[scene] avatar load error", err);
        setStatus("error");
        setStatusDetail(err?.message ?? "load failed");
        onError?.(err);
        return null;
      }
    })()
      .then((result) => {
        if (cancelled || !result) return;
        const { format, object, animations } = result;
        if (cancelled) return;

        // Replace any previous model.
        for (const child of [...scene.children]) {
          if (child.userData?.isAvatar) scene.remove(child);
        }

        const effectiveScale =
          resolvedScale != null ? resolvedScale : defaultScaleFor(format);
        object.userData.isAvatar = true;
        object.scale.setScalar(effectiveScale);
        scene.add(object);

        // Force every material in the freshly-loaded mesh to recompile.
        // FBX/GLTF materials cache a shader program based on the scene
        // state at the moment the renderer first draws them. If lights
        // or scene.environment landed BEFORE the model (which they
        // usually do — the load is async, lights are sync), three.js can
        // bind a stale program that ignores them. Setting needsUpdate
        // marks the program for rebuild on the next frame, picking up
        // current lights + env automatically.
        object.traverse((child) => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material)
            ? child.material
            : child.material
              ? [child.material]
              : [];
          for (const m of mats) {
            // envMap auto-binding via scene.environment requires the
            // material to expose envMapIntensity. Ensure it's at least 1
            // so the IBL contribution is visible.
            if ("envMapIntensity" in m && m.envMapIntensity == null) {
              m.envMapIntensity = 1;
            }
            m.needsUpdate = true;
          }
        });

        const mixer = new THREE.AnimationMixer(object);
        mixerRef.current = mixer;

        const entries = (animations ?? []).map((clip) => {
          const action = mixer.clipAction(clip);
          const loop = inferLoop(clip.name);
          action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
          action.clampWhenFinished = !loop;
          return {
            name: clip.name,
            clip,
            action,
            duration: clip.duration,
            loop,
          };
        });
        animationsRef.current = entries;

        const idle = pickIdleClip(entries);
        if (idle) {
          idle.action.reset().fadeIn(CROSSFADE_MS / 1000).play();
          idleActionRef.current = idle.action;
          currentActionRef.current = idle.action;
        }

        setStatus("ready");
        // Force a recompile of materials so they pick up the current
        // scene.environment + lights configuration. Without this, the
        // first render of the freshly-added mesh can use a stale shader
        // program compiled before lights/HDRI were attached.
        if (rendererRef.current && cameraRef.current) {
          rendererRef.current.compile(scene, cameraRef.current);
        }
        // Trigger lights + post-FX effects to re-evaluate now that the
        // avatar mesh is in the scene. See modelLoadCount declaration.
        setModelLoadCount((n) => n + 1);
        onLoad?.({
          format,
          animations: entries.map((e) => ({
            name: e.name,
            duration: e.duration,
            loop: e.loop,
          })),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[scene] avatar load error", err);
        setStatus("error");
        setStatusDetail(err?.message ?? "load failed");
        onError?.(err);
      });

    return () => {
      cancelled = true;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      animationsRef.current = [];
      idleActionRef.current = null;
      currentActionRef.current = null;
      clearTimeout(oneShotTimerRef.current);
      for (const child of [...scene.children]) {
        if (child.userData?.isAvatar) scene.remove(child);
      }
    };
  }, [resolvedPath, resolvedScale]);

  function crossfadeTo(entry) {
    if (!entry || !mixerRef.current) return;
    const next = entry.action;
    const prev = currentActionRef.current;
    if (next === prev) return;

    const fadeSec = CROSSFADE_MS / 1000;

    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.time = 0; // start the new clip from the beginning

    if (prev && prev !== next) {
      // crossFadeFrom is the proper transition primitive — it ramps
      // `next` UP and `prev` DOWN with matched curves, ensuring the
      // sum of weights stays ≈ 1 throughout. Plain fadeIn+fadeOut
      // briefly double-weights both actions, which can cause subtle
      // pose pops.
      // `warpEnabled = true` syncs the two clips' playback rates so
      // their feet/hands don't suddenly jump between cycles.
      next.play();
      prev.crossFadeTo(next, fadeSec, true);
    } else {
      next.fadeIn(fadeSec).play();
    }
    currentActionRef.current = next;

    clearTimeout(oneShotTimerRef.current);
    if (!entry.loop && idleActionRef.current && idleActionRef.current !== next) {
      // Schedule a return to idle. Start the crossfade BEFORE the clip
      // would otherwise end so the blend completes right around the
      // clip's natural end pose — landing on a still moment instead of
      // mid-action. We aim for `fadeStart = duration - fadeSec`.
      const ms = Math.max(50, entry.duration * 1000 - CROSSFADE_MS);
      oneShotTimerRef.current = setTimeout(() => {
        const idle = idleActionRef.current;
        if (!idle || currentActionRef.current !== next) return;
        idle.enabled = true;
        idle.setEffectiveTimeScale(1);
        idle.setEffectiveWeight(1);
        idle.time = 0;
        idle.play();
        next.crossFadeTo(idle, fadeSec, true);
        currentActionRef.current = idle;
      }, ms);
    }
  }

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.35)",
            fontSize: 13,
            letterSpacing: "0.4px",
            pointerEvents: "none",
          }}
        >
          {status === "loading" && "loading avatar…"}
          {status === "error" && `scene error: ${statusDetail ?? "unknown"}`}
          {status === "idle" && "no avatar"}
        </div>
      )}
    </div>
  );
});

function inferLoop(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith("_loop") || lower.includes("loop") || lower.includes("idle")) {
    return true;
  }
  if (lower.endsWith("_once") || lower.endsWith("_oneshot")) return false;
  // Default: short clips probably one-shot, long clips probably loop.
  return false;
}

export default AvatarScene;
