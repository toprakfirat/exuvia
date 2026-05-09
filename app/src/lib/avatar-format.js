import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Single source of truth for avatar-asset format handling. The user can drop
// an .fbx or .glb (or .gltf) file; we auto-detect, pick the right loader,
// and normalize the result so the rest of the code only sees:
//   { object, animations }
// where `object` is a THREE.Object3D you can add to a scene.

export function detectFormat(filenameOrPath) {
  const lower = String(filenameOrPath ?? "").toLowerCase();
  if (lower.endsWith(".fbx")) return "fbx";
  if (lower.endsWith(".glb")) return "glb";
  if (lower.endsWith(".gltf")) return "gltf";
  return null;
}

// Default model scale per format. FBX from Mixamo/Maya ships in centimeters
// (×100) so 0.01 brings a 170cm character to ~1.7m. GLB/GLTF normally ship
// in meters so the default is 1.0.
export function defaultScaleFor(format) {
  return format === "fbx" ? 0.01 : 1.0;
}

// Parse an ArrayBuffer or fetched URL into { object, animations } regardless
// of source format. `name` is used for error messages and format detection.
export async function loadAvatarBuffer(buffer, name = "") {
  const format = detectFormat(name);
  if (!format) {
    throw new Error(`Unknown avatar format for "${name}" — expected .fbx, .glb, or .gltf`);
  }
  if (format === "fbx") {
    const loader = new FBXLoader();
    const root = loader.parse(buffer, "");
    return { format, object: root, animations: root.animations ?? [] };
  }
  // GLB/GLTF
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });
  return { format, object: gltf.scene, animations: gltf.animations ?? [] };
}

// Load by URL (used by AvatarScene at render time). Wraps loader.load() in a
// promise so callers can await.
export function loadAvatarFromUrl(url) {
  const format = detectFormat(url);
  if (!format) {
    return Promise.reject(
      new Error(`Unknown avatar format for "${url}" — expected .fbx, .glb, or .gltf`),
    );
  }
  return new Promise((resolve, reject) => {
    if (format === "fbx") {
      new FBXLoader().load(
        url,
        (root) =>
          resolve({ format, object: root, animations: root.animations ?? [] }),
        undefined,
        reject,
      );
      return;
    }
    new GLTFLoader().load(
      url,
      (gltf) =>
        resolve({
          format,
          object: gltf.scene,
          animations: gltf.animations ?? [],
        }),
      undefined,
      reject,
    );
  });
}
