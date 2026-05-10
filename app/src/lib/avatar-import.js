import { parseBundle } from "./avatar-bundle.js";

// Run a parsed avatar bundle through the same RPC sequence the wizard
// uses on commit, but without the wizard UI: create the agent, write
// SOUL/AGENTS, copy the GLB into the agent's workspace, register the
// avatar config under plugins.entries.exuvia.config.avatars.<id>, and
// add play_animation to tools.alsoAllow if missing.
//
// Idempotent: if an agent with the same suggested id already exists,
// we look it up in agents.list and keep going. The caller can pass
// `agentIdOverride` to choose a different id (e.g. when importing a
// bundle whose suggested id collides).
//
// Returns { agentId } on success. Throws with a useful message on failure.
export async function importAvatarBundle(gateway, json, opts = {}) {
  const { agentIdOverride, onProgress } = opts;
  const bundle = parseBundle(json);
  const progress = (stage, detail) => onProgress?.({ stage, detail });

  const slugify = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

  const desiredAgentId =
    slugify(agentIdOverride) ||
    slugify(bundle.identity?.suggestedAgentId) ||
    slugify(bundle.identity?.displayName) ||
    "imported-avatar";
  if (!desiredAgentId) throw new Error("could not derive an agent id");

  const desiredName = bundle.identity?.displayName || desiredAgentId;
  const desiredWorkspace = `~/.openclaw/workspace-${desiredAgentId}`;

  // 1. Create or reuse the agent.
  progress("create-agent", desiredAgentId);
  let realAgentId = desiredAgentId;
  let workspaceRaw = desiredWorkspace;
  try {
    const createRes = await gateway.request("agents.create", {
      name: desiredName,
      workspace: desiredWorkspace,
    });
    realAgentId = createRes?.agentId ?? desiredAgentId;
    workspaceRaw = createRes?.workspace ?? desiredWorkspace;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!/already exists/i.test(msg)) throw err;
    progress("reuse-existing-agent", desiredAgentId);
    const list = await gateway.request("agents.list", {});
    const arr = Array.isArray(list?.agents)
      ? list.agents
      : Array.isArray(list?.list)
        ? list.list
        : Array.isArray(list)
          ? list
          : [];
    const match = arr.find((a) => {
      const id = a.id ?? a.agentId ?? a.name;
      return id === desiredAgentId || a.name === desiredName;
    });
    if (!match) {
      throw new Error(
        `agents.create rejected with "already exists" but no matching agent in agents.list — pass a different agentIdOverride.`,
      );
    }
    realAgentId = match.id ?? match.agentId ?? match.name ?? desiredAgentId;
    workspaceRaw = match.workspace ?? match.workspaceDir ?? desiredWorkspace;
  }

  // 2. Write workspace files. Bundle may carry SOUL.md/AGENTS.md or
  //    neither; we only write the ones present.
  progress("write-files", null);
  const files = bundle.files ?? {};
  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== "string" || !content.trim()) continue;
    await gateway.request("agents.files.set", {
      agentId: realAgentId,
      name,
      content,
    });
  }

  // 3. Resolve the workspace path for our IPC writer.
  progress("resolve-workspace", null);
  const workspace = await window.exuvia.path.expand(workspaceRaw);
  const join = (a, b) => (a.endsWith("/") || a.endsWith("\\") ? a + b : `${a}/${b}`);
  const meshFileName = bundle.mesh.fileName || "avatar.glb";
  const meshTarget = join(workspace, meshFileName);

  // 4. Write the GLB bytes from the bundle into the workspace.
  progress("copy-mesh", meshTarget);
  const writeResult = await window.exuvia.fbx.write({
    targetPath: meshTarget,
    bytes: bundle.mesh.bytes,
  });
  if (!writeResult?.ok) {
    throw new Error(`mesh write failed: ${writeResult?.error ?? "unknown"}`);
  }

  // 5. Register the avatar in plugin config + ensure play_animation is
  //    in tools.alsoAllow. Same logic as the wizard's commit step.
  progress("register-avatar", null);
  let toolsAlsoAllowPatch;
  try {
    const cfg = await gateway.request("config.get", {});
    const existing =
      cfg?.config?.tools?.alsoAllow ?? cfg?.tools?.alsoAllow ?? [];
    if (!existing.includes("play_animation")) {
      toolsAlsoAllowPatch = { alsoAllow: [...existing, "play_animation"] };
    }
  } catch {
    /* fail open */
  }

  // The bundle's avatarConfig already lacks avatarPath/fbxPath (export
  // strips them). Fill in our local meshTarget so the desktop renderer
  // can find it. Strip undefined keys defensively.
  const sidecar = { ...bundle.avatarConfig, avatarPath: meshTarget };
  for (const k of Object.keys(sidecar)) {
    if (sidecar[k] === undefined) delete sidecar[k];
  }

  const avatarPatch = {
    ...(toolsAlsoAllowPatch ? { tools: toolsAlsoAllowPatch } : {}),
    plugins: {
      entries: {
        exuvia: {
          config: {
            avatars: {
              [realAgentId]: sidecar,
            },
          },
        },
      },
    },
  };

  try {
    await gateway.configPatch(avatarPatch);
  } catch (err) {
    const msg = String(err?.message ?? err);
    const recoverable =
      /gateway restarting/i.test(msg) ||
      /socket closed/i.test(msg) ||
      /not connected/i.test(msg);
    if (!recoverable) throw err;
  }

  progress("done", null);
  return { agentId: realAgentId };
}
