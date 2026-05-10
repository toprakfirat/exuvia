// Avatar bundle format. A single JSON file (`.exuvia`) that contains
// everything needed to recreate an avatar on a different machine:
//   - the avatar config sidecar (animations / post-fx / lights / userAddress)
//   - SOUL.md and AGENTS.md text (avatar's voice and operational identity)
//   - the GLB mesh embedded as base64
//
// JSON keeps the file inspectable and removes the need for a zip lib.
// GLBs are typically 5–30MB; base64 inflation is ~33%, so a 10MB GLB
// becomes a ~13MB JSON file. Acceptable for desktop file sharing.
//
// Shape:
// {
//   exuviaBundle: 1,        // schema version
//   exportedAt: ISO string,
//   exportedFrom: { app, version, platform },
//   identity: { displayName, suggestedAgentId },
//   avatarConfig: { …everything except avatarPath … },
//   files: { "SOUL.md": "...", "AGENTS.md": "..." },
//   mesh: { fileName, mimeType, base64 }
// }

export const BUNDLE_VERSION = 1;

// Build the JSON string. Caller has already loaded SOUL/AGENTS text and
// the GLB bytes (Uint8Array). agentRow gives us displayName / suggestedAgentId
// for the import-side defaults; not required to be present on the wire.
export function buildBundle({
  agentId,
  displayName,
  avatarConfig,
  soul,
  agents,
  meshBytes,
  meshFileName = "avatar.glb",
}) {
  if (!avatarConfig || typeof avatarConfig !== "object") {
    throw new Error("avatarConfig is required");
  }
  if (!meshBytes || meshBytes.byteLength === 0) {
    throw new Error("meshBytes is required");
  }

  // Drop machine-specific fields before exporting. avatarPath points at a
  // workspace dir that won't exist on the recipient's machine — we'll
  // rebuild it on import. gifPath inside animations is similar; the
  // recipient can re-bake from their own copy if they want gifs on chat
  // channels.
  const stripped = { ...avatarConfig };
  delete stripped.avatarPath;
  delete stripped.fbxPath;
  if (Array.isArray(stripped.animations)) {
    stripped.animations = stripped.animations.map((a) => {
      const next = { ...a };
      delete next.gifPath;
      return next;
    });
  }

  const bundle = {
    exuviaBundle: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      app: "exuvia",
      version: "0.0.0",
      platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    },
    identity: {
      displayName: displayName ?? agentId ?? "Avatar",
      suggestedAgentId: agentId ?? "",
    },
    avatarConfig: stripped,
    files: {
      "SOUL.md": typeof soul === "string" ? soul : "",
      "AGENTS.md": typeof agents === "string" ? agents : "",
    },
    mesh: {
      fileName: meshFileName,
      mimeType: meshFileName.toLowerCase().endsWith(".glb")
        ? "model/gltf-binary"
        : "application/octet-stream",
      base64: bytesToBase64(meshBytes),
    },
  };

  return JSON.stringify(bundle, null, 2);
}

// Parse and validate a bundle JSON. Throws with a clear message on
// version/shape errors so the import UI can surface them to the user.
export function parseBundle(json) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch (err) {
    throw new Error(`not a valid JSON file: ${String(err?.message ?? err)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("bundle is not an object");
  }
  if (parsed.exuviaBundle !== BUNDLE_VERSION) {
    throw new Error(
      `unsupported bundle version: ${parsed.exuviaBundle ?? "(missing)"} (expected ${BUNDLE_VERSION})`,
    );
  }
  if (!parsed.avatarConfig || typeof parsed.avatarConfig !== "object") {
    throw new Error("bundle.avatarConfig missing or invalid");
  }
  if (!parsed.mesh || typeof parsed.mesh.base64 !== "string") {
    throw new Error("bundle.mesh.base64 missing");
  }
  return {
    identity: parsed.identity ?? {},
    avatarConfig: parsed.avatarConfig,
    files: parsed.files ?? {},
    mesh: {
      fileName: parsed.mesh.fileName ?? "avatar.glb",
      mimeType: parsed.mesh.mimeType ?? "model/gltf-binary",
      bytes: base64ToBytes(parsed.mesh.base64),
    },
  };
}

// btoa/atob would handle this on the renderer, but the bytes can be
// large (10MB+) and the string-conversion path through `String.fromCharCode`
// blows the stack on big inputs. Walk the array in 32k chunks instead.
function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    const slice = u8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
