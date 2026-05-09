import { loadAvatarBuffer } from "./avatar-format.js";

// Parse an avatar file (.fbx, .glb, .gltf) in-browser to extract animation
// metadata. Returns: { format, animations: [{ name, duration, loop }], hasSkeleton }
//
// The wizard uses this *before* the file is committed to disk, so the user
// can describe each clip as part of avatar setup. Parsing succeeds purely on
// the binary bytes — no DOM, no fetch.
//
// The legacy name `parseFbxFile` is kept; under the hood it now handles GLB
// too. Format is included in the result so callers can branch on it.
export async function parseFbxFile(file) {
  const buffer = await file.arrayBuffer();
  return parseFbxBuffer(buffer, file.name);
}

export async function parseFbxBuffer(arrayBuffer, name = "") {
  const { format, object, animations } = await loadAvatarBuffer(arrayBuffer, name);

  const clips = animations.map((clip) => ({
    name: String(clip.name ?? "anim"),
    duration: Number(clip.duration ?? 0),
    loop: inferLoop(String(clip.name ?? "")),
  }));

  let hasSkeleton = false;
  object.traverse?.((obj) => {
    if (obj.isSkinnedMesh || obj.isBone) hasSkeleton = true;
  });

  // Free GPU/CPU memory we don't need to keep around.
  object.traverse?.((obj) => {
    obj.geometry?.dispose?.();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose?.();
    }
  });

  return { format, animations: clips, hasSkeleton };
}

function inferLoop(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith("_loop") || lower.includes("loop") || lower.includes("idle")) {
    return true;
  }
  if (lower.endsWith("_once") || lower.endsWith("_oneshot")) return false;
  return false;
}
