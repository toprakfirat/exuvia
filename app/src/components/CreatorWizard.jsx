import React, { useState } from "react";
import { parseFbxFile } from "../lib/fbx-parser.js";
import { createAnimationBaker } from "../lib/animation-baker.js";
import { defaultScaleFor, detectFormat } from "../lib/avatar-format.js";
import {
  POST_PROCESSING_PRESETS,
  PRESET_KEYS,
} from "../lib/post-processing-shaders.js";

// Avatar creator wizard.
// Steps: drop FBX → identity → personality → animations → commit.
// On commit, calls these gateway RPCs in sequence:
//   1. agents.create               — claw makes the agent + workspace
//   2. agents.files.set            — write SOUL.md and AGENTS.md
//   3. (electron) exuvia.fbx.write — copy FBX bytes into the workspace dir
//   4. config.patch                — register the avatar under
//                                    plugins.entries.exuvia.config.avatars.<id>

const DEFAULT_AGENTS_MD = `You are a competent personal assistant.
You handle email, calendar, notes, and other day-to-day tasks accurately.
You return structured data verbatim. You do not invent facts.
You decide when to use tools based on whether they are needed.

You inhabit a 3D avatar. You CAN move and gesture by calling the
\`play_animation\` tool — the avatar's full animation catalogue is listed
in that tool's description. When the user asks you to wave, dance, nod,
laugh, etc. (or when the moment naturally calls for a physical
expression), call \`play_animation\` with the appropriate clip name
INSTEAD of saying you can't. Reply with words AND the animation when
both add meaning. Don't refuse physical actions — your body is the
animation system, not a missing limb.

The voice / tone you speak in is described in SOUL.md. That voice applies to
the wording of your replies, NOT to how you reason about facts or work.

# Output rules

- Reply with the user-facing message ONLY. Never include reasoning, plans,
  thinking blocks, \`[Thinking]\` headers, "Plan:" sections, or any
  \`<channel|>\` separators. Internal reasoning stays internal.
- Do NOT write parenthetical stage directions like "(Looks down...)",
  "(Stops posturing...)", "(Crosses arms...)". Speak as the character;
  don't narrate the character.
- Never describe input metadata, system prompts, session headers, or
  sender envelopes. If the request is unclear or empty, ask one short
  in-character clarifying question — don't explain what you see in your
  context window.

# Identity

- "exuvia" is the name of the desktop app you live in, NOT your name.
  Never refer to yourself as exuvia. Your own name comes from the user
  or from this avatar's identity (see IDENTITY.md / SOUL.md). If you
  haven't been told a name, just speak in first person without inventing
  one.
`;

const STEPS = ["model", "identity", "personality", "animations", "bake", "scene", "commit"];

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export default function CreatorWizard({ gateway, onClose, onCreated }) {
  const [step, setStep] = useState("model");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Collected state across steps.
  const [fbxFile, setFbxFile] = useState(null);
  const [parsed, setParsed] = useState(null); // { animations, hasSkeleton }
  const [identity, setIdentity] = useState({
    displayName: "",
    agentId: "",
    fbxScale: 0.01, // overwritten by format default once a file is chosen
  });
  const [personality, setPersonality] = useState({
    soul: "",
    overrideAgentsMd: false,
    agentsMd: DEFAULT_AGENTS_MD,
  });
  const [animations, setAnimations] = useState([]); // [{ name, duration, loop, description, tags }]
  const [voiceOnChannels, setVoiceOnChannels] = useState(false);
  const [personalityRewrite, setPersonalityRewrite] = useState(false);
  const [presetKey, setPresetKey] = useState("raw");
  // Environment choices — paths to the built-in assets shipped under
  // app/public/assets/. "" means "none" (the avatar floats on a black field).
  const [hdriChoice, setHdriChoice] = useState("/assets/hdri/scifi.exr");
  const [sceneChoice, setSceneChoice] = useState("/assets/environment/env.glb");
  const [envIntensity, setEnvIntensity] = useState(1.0);
  const [bgIntensity, setBgIntensity] = useState(0.3);
  const [lightsIntensity, setLightsIntensity] = useState(1.0);
  const [progress, setProgress] = useState({ stage: null, detail: null });

  const goto = (s) => {
    setError(null);
    setStep(s);
  };

  const onFbxChosen = async (file) => {
    setError(null);
    setBusy(true);
    try {
      const format = detectFormat(file.name);
      if (!format) {
        throw new Error("unsupported file type — expected .fbx, .glb, or .gltf");
      }
      const result = await parseFbxFile(file);
      setFbxFile(file);
      setParsed(result);
      setAnimations(
        result.animations.map((a) => ({
          ...a,
          description: "",
          tags: [],
          // Bake settings; null bakedBytes means "not yet baked".
          skipBake: false,
          bakedBytes: null,
          bakedExt: null,
        })),
      );
      // Default the agentId + scale from the file. Stem strips any of the
      // supported extensions; default scale is per-format.
      const stem = file.name.replace(/\.(fbx|glb|gltf)$/i, "");
      setIdentity((prev) => ({
        ...prev,
        displayName: prev.displayName || stem,
        agentId: prev.agentId || slugify(stem),
        fbxScale: defaultScaleFor(format),
      }));
      goto("identity");
    } catch (err) {
      setError(`avatar parse failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setError(null);
    setBusy(true);
    setProgress({ stage: "create-agent", detail: null });

    const agentId = slugify(identity.agentId || identity.displayName);
    if (!agentId) {
      setError("agentId is required");
      setBusy(false);
      return;
    }

    try {
      // 1. Create the agent. Claw provisions workspace + agentDir + sessions.
      //    AgentsCreateParams requires { name, workspace }; the gateway
      //    derives the agentId from the name slug. We pass our intended
      //    workspace path so it lines up with our slug.
      //
      //    If the agent already exists (e.g. partial wizard run last time),
      //    fall back to looking up the existing one in agents.list. The
      //    rest of the chain (write files, copy avatar, register sidecar)
      //    is idempotent so it's safe to continue.
      const desiredWorkspace = `~/.openclaw/workspace-${agentId}`;
      const desiredName = identity.displayName || agentId;

      let realAgentId = agentId;
      let workspaceRaw = desiredWorkspace;
      try {
        const createRes = await gateway.request("agents.create", {
          name: desiredName,
          workspace: desiredWorkspace,
        });
        realAgentId = createRes?.agentId ?? agentId;
        workspaceRaw = createRes?.workspace ?? desiredWorkspace;
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (!/already exists/i.test(msg)) throw err;
        setProgress({ stage: "reuse-existing-agent", detail: null });
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
          return id === agentId || a.name === desiredName;
        });
        if (!match) {
          throw new Error(
            `agents.create rejected with "already exists" but no matching agent in agents.list — config drift?`,
          );
        }
        realAgentId = match.id ?? match.agentId ?? match.name ?? agentId;
        workspaceRaw = match.workspace ?? match.workspaceDir ?? desiredWorkspace;
      }

      // 2. Write workspace files (SOUL.md is the personality voice; AGENTS.md
      //    is the procedural core, defaulted unless overridden).
      //    AgentsFilesSetParams uses { agentId, name, content } — `name` is
      //    the file name (e.g. "SOUL.md"), not the avatar's display name.
      setProgress({ stage: "write-files", detail: null });
      const files = [];
      if (personality.soul.trim()) {
        files.push({ name: "SOUL.md", content: personality.soul });
      }
      if (personality.overrideAgentsMd) {
        files.push({ name: "AGENTS.md", content: personality.agentsMd });
      } else {
        files.push({ name: "AGENTS.md", content: DEFAULT_AGENTS_MD });
      }
      for (const file of files) {
        await gateway.request("agents.files.set", {
          agentId: realAgentId,
          name: file.name,
          content: file.content,
        });
      }

      // 3. Expand the workspace path so our IPC writer can write into it.
      setProgress({ stage: "resolve-workspace", detail: null });
      const workspace = await window.exuvia.path.expand(workspaceRaw);
      const sourceFormat = detectFormat(fbxFile.name) ?? "fbx";
      const fbxTarget = joinPath(workspace, `avatar.${sourceFormat}`);

      // 4. Copy the FBX bytes into the workspace via Electron IPC.
      setProgress({ stage: "copy-fbx", detail: fbxTarget });
      const buffer = await fbxFile.arrayBuffer();
      const writeResult = await window.exuvia.fbx.write({
        targetPath: fbxTarget,
        bytes: new Uint8Array(buffer),
      });
      if (!writeResult?.ok) {
        throw new Error(`FBX write failed: ${writeResult?.error ?? "unknown"}`);
      }

      // 4b. Write the baked clip videos that the bake step produced. Each
      //     animation either has bakedBytes + bakedExt (the wizard generated
      //     a webm of the clip) or skipBake=true (user opted out).
      const gifPaths = {};
      const gifsDir = joinPath(workspace, "gifs");
      for (const a of animations) {
        if (a.skipBake || !a.bakedBytes) continue;
        setProgress({ stage: "write-baked-clip", detail: a.name });
        const safeName = a.name.replace(/[^a-zA-Z0-9_-]+/g, "_");
        const ext = a.bakedExt || "webm";
        const target = joinPath(gifsDir, `${safeName}.${ext}`);
        const writeRes = await window.exuvia.fbx.write({
          targetPath: target,
          bytes: a.bakedBytes,
        });
        if (!writeRes?.ok) {
          throw new Error(`baked clip write failed for ${a.name}: ${writeRes?.error ?? "unknown"}`);
        }
        gifPaths[a.name] = target;
      }

      // 5. Register the avatar in plugin config.
      // config.patch takes { raw: <stringified partial config> } per the
      // schema — not a structured `patch` object. The gateway parses the
      // string and merges it into the live config.
      //
      // Side patch: ensure `play_animation` is in tools.alsoAllow. The
      // default `coding` profile filters out plugin-registered tools, so
      // without this entry the LLM never sees play_animation and the
      // avatar can't move. We do this here (not at plugin boot) because
      // openclaw's registerConfigMigration only fires on `plugins install`,
      // not on every gateway start — and because openclaw's merge-patch
      // replaces string arrays wholesale, we read the current value first
      // and send the union so we never clobber a user's custom allowlist.
      setProgress({ stage: "register-avatar", detail: null });
      let toolsAlsoAllowPatch;
      try {
        const cfg = await gateway.request("config.get", {});
        const existing =
          cfg?.config?.tools?.alsoAllow ?? cfg?.tools?.alsoAllow ?? [];
        if (!existing.includes("play_animation")) {
          toolsAlsoAllowPatch = {
            alsoAllow: [...existing, "play_animation"],
          };
        }
      } catch (err) {
        // Fail open — avatar registration matters more than the tool gate.
        // The user can re-run the wizard or hand-add the entry if needed.
        console.warn("[wizard] could not read tools.alsoAllow:", err);
      }
      const avatarPatch = {
        ...(toolsAlsoAllowPatch ? { tools: toolsAlsoAllowPatch } : {}),
        plugins: {
          entries: {
            exuvia: {
              config: {
                avatars: {
                  [realAgentId]: {
                    avatarPath: fbxTarget,
                    fbxScale: identity.fbxScale,
                    environmentHdriPath: hdriChoice || undefined,
                    environmentIntensity: envIntensity,
                    backgroundIntensity: bgIntensity,
                    lightsIntensity: lightsIntensity,
                    scenePath: sceneChoice || undefined,
                    voiceOnChannels: voiceOnChannels || undefined,
                    personalityRewrite: personalityRewrite || undefined,
                    postProcessing:
                      presetKey === "raw"
                        ? undefined
                        : POST_PROCESSING_PRESETS[presetKey](),
                    animations: animations.map((a) => ({
                      name: a.name,
                      description: a.description || undefined,
                      tags: a.tags.length > 0 ? a.tags : undefined,
                      loop: a.loop,
                      durationMs: Math.round(a.duration * 1000),
                      gifPath: gifPaths[a.name],
                    })),
                  },
                },
              },
            },
          },
        },
      };
      // The gateway hot-reloads the plugin runtime when plugins.entries.exuvia
      // changes, which closes our WebSocket mid-flight. The patch *did* land
      // server-side — only the response is lost. Treat those specific errors
      // as success.
      try {
        await gateway.configPatch(avatarPatch);
      } catch (err) {
        const msg = String(err?.message ?? err);
        const recoverable =
          /gateway restarting/i.test(msg) ||
          /socket closed/i.test(msg) ||
          /not connected/i.test(msg);
        if (!recoverable) throw err;
        console.warn(
          `[wizard] config.patch closed the socket (${msg}); treating as success`,
        );
      }

      setProgress({ stage: "done", detail: null });
      onCreated?.(realAgentId);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ width: 640, maxWidth: "92vw", maxHeight: "92vh", overflow: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>New avatar</h2>
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <Stepper current={step} />

        {error && <div style={{ color: "#ff7878" }}>error: {error}</div>}

        {step === "model" && (
          <FbxStep
            file={fbxFile}
            parsed={parsed}
            onChoose={onFbxChosen}
            onNext={() => goto("identity")}
            busy={busy}
          />
        )}
        {step === "identity" && (
          <IdentityStep
            value={identity}
            onChange={setIdentity}
            onBack={() => goto("model")}
            onNext={() => goto("personality")}
          />
        )}
        {step === "personality" && (
          <PersonalityStep
            value={personality}
            onChange={setPersonality}
            voiceOnChannels={voiceOnChannels}
            onChangeVoiceOnChannels={setVoiceOnChannels}
            personalityRewrite={personalityRewrite}
            onChangePersonalityRewrite={setPersonalityRewrite}
            onBack={() => goto("identity")}
            onNext={() => goto("animations")}
          />
        )}
        {step === "animations" && (
          <AnimationsStep
            animations={animations}
            onChange={setAnimations}
            onBack={() => goto("personality")}
            onNext={() => goto("bake")}
          />
        )}
        {step === "bake" && (
          <BakeStep
            fbxFile={fbxFile}
            fbxScale={identity.fbxScale}
            animations={animations}
            onChange={setAnimations}
            onBack={() => goto("animations")}
            onNext={() => goto("scene")}
          />
        )}
        {step === "scene" && (
          <SceneStep
            hdriChoice={hdriChoice}
            onHdriChange={setHdriChoice}
            sceneChoice={sceneChoice}
            onSceneChange={setSceneChoice}
            envIntensity={envIntensity}
            onEnvIntensityChange={setEnvIntensity}
            bgIntensity={bgIntensity}
            onBgIntensityChange={setBgIntensity}
            lightsIntensity={lightsIntensity}
            onLightsIntensityChange={setLightsIntensity}
            onBack={() => goto("bake")}
            onNext={() => goto("commit")}
          />
        )}
        {step === "commit" && (
          <CommitStep
            identity={identity}
            personality={personality}
            animations={animations}
            presetKey={presetKey}
            onPresetChange={setPresetKey}
            progress={progress}
            busy={busy}
            onBack={() => goto("scene")}
            onCommit={commit}
          />
        )}
      </div>
    </div>
  );
}

function Stepper({ current }) {
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 12, color: "#8a8a96" }}>
      {STEPS.map((s, i) => (
        <span
          key={s}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: s === current ? "#2a2a3a" : "transparent",
            border: s === current ? "1px solid #4a4a64" : "1px solid transparent",
          }}
        >
          {i + 1}. {s}
        </span>
      ))}
    </div>
  );
}

function FbxStep({ file, parsed, onChoose, onNext, busy }) {
  const inputRef = React.useRef(null);
  const [dragOver, setDragOver] = React.useState(false);

  const acceptFile = (f) => {
    if (!f) return;
    if (!/\.(fbx|glb|gltf)$/i.test(f.name)) return;
    onChoose(f);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>
        Drop an avatar model below — .fbx, .glb, or .gltf. Mixamo, Blender
        exports, and Ready Player Me models all work.
      </p>

      <div
        className={`dropzone ${dragOver ? "is-over" : ""} ${file ? "has-file" : ""}`}
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          acceptFile(e.dataTransfer.files?.[0]);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (busy) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".fbx,.glb,.gltf"
          disabled={busy}
          onChange={(e) => acceptFile(e.target.files?.[0])}
          style={{ display: "none" }}
        />
        {file && parsed ? (
          <div className="dropzone-content">
            <div className="dropzone-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
            </div>
            <div className="dropzone-name">{file.name}</div>
            <div className="dropzone-meta">
              {(file.size / 1024 / 1024).toFixed(1)} MB · {parsed.animations.length} animation
              {parsed.animations.length === 1 ? "" : "s"}
            </div>
            {!parsed.hasSkeleton && (
              <div className="dropzone-warn">
                no skeleton detected — animations may not bind
              </div>
            )}
            <div className="dropzone-replace">click or drop to replace</div>
          </div>
        ) : (
          <div className="dropzone-content">
            <div className="dropzone-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div className="dropzone-headline">
              {dragOver ? "release to add" : "drop model here"}
            </div>
            <div className="dropzone-meta">or click to browse · .fbx · .glb · .gltf</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onNext} disabled={!file || !parsed || busy}>
          Next
        </button>
      </div>
    </div>
  );
}

function IdentityStep({ value, onChange, onBack, onNext }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label>
        <div className="muted" style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 2 }}>
          Display name
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Shown in the avatar list and chat header. Free text, can include
          spaces or emoji.
        </div>
        <input
          value={value.displayName}
          onChange={(e) => onChange({ ...value, displayName: e.target.value })}
          placeholder="Nova"
        />
      </label>
      <label>
        <div className="muted" style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 2 }}>
          Agent id
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          The internal openclaw <code>agentId</code> — used in URLs, file paths
          on disk (<code>~/.openclaw/agents/&lt;id&gt;</code>), and bindings to
          chat channels. Auto-slugified (lowercase, hyphens). Can't be changed
          later without recreating the avatar.
        </div>
        <input
          value={value.agentId}
          onChange={(e) => onChange({ ...value, agentId: slugify(e.target.value) })}
          placeholder="nova"
        />
      </label>
      <label>
        <div className="muted" style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 2 }}>
          Model scale
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Multiplier applied to the imported mesh. Auto-set per format: FBX
          defaults to <code>0.01</code> (centimeters → meters), GLB/GLTF to
          <code>1.0</code>. Tweak only if the avatar lands too small or too
          large in the scene.
        </div>
        <input
          type="number"
          step="0.001"
          value={value.fbxScale}
          onChange={(e) =>
            onChange({ ...value, fbxScale: Number(e.target.value) || 0.01 })
          }
        />
      </label>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button onClick={onBack}>Back</button>
        <button onClick={onNext} disabled={!value.agentId.trim()}>
          Next
        </button>
      </div>
    </div>
  );
}

function PersonalityStep({
  value,
  onChange,
  voiceOnChannels,
  onChangeVoiceOnChannels,
  personalityRewrite,
  onChangePersonalityRewrite,
  onBack,
  onNext,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        className="muted"
        style={{
          fontSize: 11,
          lineHeight: 1.55,
          padding: "10px 12px",
          border: "1px solid var(--border-glass)",
          borderRadius: 4,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        Two markdown files shape how this avatar speaks and behaves. They
        live in the avatar's workspace folder and are sent to the LLM on
        every turn:
        <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
          <li>
            <strong style={{ color: "var(--text-secondary)" }}>SOUL.md</strong>{" "}
            — the <em>voice</em>. Tone, mannerisms, vocabulary, what the
            character notices, how they react. Affects only style — not
            reasoning, tools, or capabilities.
          </li>
          <li style={{ marginTop: 4 }}>
            <strong style={{ color: "var(--text-secondary)" }}>AGENTS.md</strong>{" "}
            — the <em>procedural core</em>. The actual instructions for
            how the agent operates: what tools to use, when, safety rules,
            workflow conventions. A sensible default ships with every new
            avatar — only override if you know what you're doing.
          </li>
        </ul>
      </div>

      <label>
        <div className="muted" style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 2 }}>
          SOUL.md — personality / voice
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Describe how this character speaks. Write in second person
          (&quot;You speak in short, warm sentences&quot;) — the LLM reads it
          as instructions to itself. Keep it focused on style, not facts
          about the world.
        </div>
        <textarea
          value={value.soul}
          onChange={(e) => onChange({ ...value, soul: e.target.value })}
          placeholder={
            "When speaking to the user, your voice is warm and concise. " +
            "You favor short sentences. You acknowledge the user by name when natural."
          }
          rows={8}
          style={{ width: "100%", minHeight: 140, resize: "vertical" }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={value.overrideAgentsMd}
          onChange={(e) => onChange({ ...value, overrideAgentsMd: e.target.checked })}
        />
        <span className="muted" style={{ flex: 1, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-primary)" }}>Customize AGENTS.md</strong>{" "}
          <span style={{ color: "var(--text-muted)" }}>(advanced)</span>
          {" — "}replace the default operating instructions. Leave off
          unless you&apos;re changing tool use or workflow rules.
        </span>
      </label>
      {value.overrideAgentsMd && (
        <label>
          <div className="muted" style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 2 }}>
            AGENTS.md — procedural core
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Full operating instructions for this agent. Replaces the default
            shipped with new avatars. Touch this only if you understand the
            openclaw agent contract.
          </div>
          <textarea
            value={value.agentsMd}
            onChange={(e) => onChange({ ...value, agentsMd: e.target.value })}
            rows={10}
            style={{ width: "100%", minHeight: 180, resize: "vertical" }}
          />
        </label>
      )}

      <label style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={voiceOnChannels}
          onChange={(e) => onChangeVoiceOnChannels(e.target.checked)}
        />
        <span className="muted" style={{ flex: 1, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-primary)" }}>Send voice notes on chat channels</strong>
          {" — "}attach a TTS audio file to every reply on Telegram,
          WhatsApp, etc. The desktop app always plays voice locally; this
          flag only affects third-party channels.
        </span>
      </label>

      <label style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={personalityRewrite}
          onChange={(e) => onChangePersonalityRewrite(e.target.checked)}
        />
        <span className="muted" style={{ flex: 1, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-primary)" }}>Force-rewrite replies in voice</strong>
          {" — "}runs every assistant message through a second LLM pass
          that re-styles it in this character&apos;s voice (per SOUL.md).
          Doubles latency. Skipped on replies with structured data
          (times, links, code, media). Off by default; only worth enabling
          for stylized characters that drop persona without it.
        </span>
      </label>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button onClick={onBack}>Back</button>
        <button onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function AnimationsStep({ animations, onChange, onBack, onNext }) {
  if (animations.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted">
          No animation clips were found in the FBX. The avatar will work, but
          play_animation calls won't have anything to play.
        </p>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button onClick={onBack}>Back</button>
          <button onClick={onNext}>Next</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="muted" style={{ margin: 0 }}>
        Tag and describe each animation. The LLM uses these to pick fitting
        clips during conversation.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {animations.map((a, i) => (
          <AnimationRow
            key={`${a.name}-${i}`}
            value={a}
            onChange={(next) => {
              const arr = animations.slice();
              arr[i] = next;
              onChange(arr);
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button onClick={onBack}>Back</button>
        <button onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function AnimationRow({ value, onChange }) {
  const tagsText = value.tags.join(", ");
  return (
    <div
      style={{
        border: "1px solid #2a2a32",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{value.name}</strong>
        <span className="muted">{value.duration.toFixed(2)}s</span>
      </div>
      <label style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={value.loop}
          onChange={(e) => onChange({ ...value, loop: e.target.checked })}
        />
        <span className="muted">looped (idle, breathing, walk-in-place)</span>
      </label>
      <label>
        <div className="muted">tags (comma separated — e.g. greeting, happy)</div>
        <input
          value={tagsText}
          onChange={(e) =>
            onChange({
              ...value,
              tags: e.target.value
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
          placeholder="greeting, happy"
        />
      </label>
      <label>
        <div className="muted">description</div>
        <input
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          placeholder="Friendly wave with the right hand."
        />
      </label>
      <label style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={value.skipBake ?? false}
          onChange={(e) => onChange({ ...value, skipBake: e.target.checked })}
        />
        <span className="muted">
          skip baking — no chat-channel preview for this clip
        </span>
      </label>
    </div>
  );
}

function BakeStep({ fbxFile, fbxScale, animations, onChange, onBack, onNext }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: null });

  const toBake = animations.filter((a) => !a.skipBake);
  const bakedCount = animations.filter((a) => a.bakedBytes).length;
  const skippedCount = animations.filter((a) => a.skipBake).length;
  const allDone = toBake.every((a) => a.bakedBytes);

  const runBake = async () => {
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: toBake.length, current: null });

    let baker;
    try {
      baker = await createAnimationBaker(fbxFile, fbxScale);
    } catch (err) {
      setError(`baker init failed: ${err?.message ?? err}`);
      setBusy(false);
      return;
    }

    try {
      // Sequential — one canvas, one MediaRecorder. Parallel would race.
      let done = 0;
      const next = animations.slice();
      for (let i = 0; i < next.length; i += 1) {
        const a = next[i];
        if (a.skipBake) continue;
        setProgress({ done, total: toBake.length, current: a.name });
        try {
          const blob = await baker.bake({
            name: a.name,
            durationMs: a.durationMs ? a.durationMs : a.duration * 1000,
            loop: a.loop,
          });
          const buf = await blob.arrayBuffer();
          next[i] = {
            ...a,
            bakedBytes: new Uint8Array(buf),
            bakedExt: baker.extForMime(),
          };
        } catch (err) {
          console.error("[baker] failed", a.name, err);
          next[i] = { ...a, bakedBytes: null, bakedExt: null };
          setError(`bake failed for ${a.name}: ${err?.message ?? err}`);
        }
        done += 1;
        setProgress({ done, total: toBake.length, current: null });
      }
      onChange(next);
    } finally {
      baker.dispose();
      setBusy(false);
    }
  };

  const skipAll = () => {
    onChange(animations.map((a) => ({ ...a, skipBake: true })));
  };

  if (animations.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted">No animations to bake. Skipping.</p>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button onClick={onBack}>Back</button>
          <button onClick={onNext}>Next</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="muted" style={{ margin: 0 }}>
        Bake each animation to a short webm video. These are attached to chat
        replies on Telegram, Discord, etc. so users on those channels see the
        avatar perform — instead of just text. Loops are clipped to ~2s; one-shots
        use the clip's natural duration.
      </p>
      <div className="muted">
        {animations.length} clips total · {skippedCount} skipped · {bakedCount} baked
      </div>
      {busy && (
        <div className="muted">
          baking {progress.done + 1}/{progress.total}
          {progress.current ? ` — ${progress.current}` : ""}…
        </div>
      )}
      {!busy && progress.total > 0 && progress.done === progress.total && (
        <div className="muted">✓ baked {bakedCount} of {progress.total}</div>
      )}
      {error && <div style={{ color: "#ffb070" }}>warning: {error}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {animations.map((a, i) => (
          <div
            key={`${a.name}-${i}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "6px 8px",
              border: "1px solid #2a2a32",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <span>{a.name}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              {a.skipBake
                ? "skip"
                : a.bakedBytes
                  ? `✓ ${(a.bakedBytes.length / 1024).toFixed(0)} KB`
                  : "pending"}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={runBake} disabled={busy || toBake.length === 0}>
          {bakedCount > 0 ? "Re-bake all" : "Bake clips"}
        </button>
        <button onClick={skipAll} disabled={busy}>
          Skip all
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button onClick={onBack} disabled={busy}>Back</button>
        <button onClick={onNext} disabled={busy || (!allDone && skippedCount !== animations.length)}>
          Next
        </button>
      </div>
    </div>
  );
}

function CommitStep({
  identity,
  personality,
  animations,
  presetKey,
  onPresetChange,
  progress,
  busy,
  onBack,
  onCommit,
}) {
  const baked = animations.filter((a) => a.bakedBytes).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="muted">Look (post-processing preset)</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PRESET_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onPresetChange(key)}
              style={{
                padding: "4px 10px",
                background: presetKey === key ? "#2a2a3a" : "#1c1c22",
                borderColor: presetKey === key ? "#4a4a64" : "#2a2a32",
              }}
            >
              {key}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>
          You can fine-tune effects later in avatar settings.
        </span>
      </div>

      <p className="muted" style={{ margin: 0 }}>Ready to create:</p>
      <ul className="muted" style={{ margin: 0, paddingLeft: 20 }}>
        <li>agentId: <code>{identity.agentId}</code></li>
        <li>display name: {identity.displayName}</li>
        <li>SOUL.md: {personality.soul.trim() ? "✓" : "(empty)"}</li>
        <li>AGENTS.md: {personality.overrideAgentsMd ? "custom" : "default"}</li>
        <li>animations: {animations.length} ({baked} with baked clip)</li>
        <li>look: {presetKey}</li>
      </ul>
      {progress.stage && (
        <div className="muted">
          stage: <strong style={{ color: "#e7e7ea" }}>{progress.stage}</strong>
          {progress.detail ? ` — ${progress.detail}` : ""}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button onClick={onBack} disabled={busy}>Back</button>
        <button onClick={onCommit} disabled={busy}>
          {busy ? "Creating…" : "Create avatar"}
        </button>
      </div>
    </div>
  );
}

function SceneStep({
  hdriChoice,
  onHdriChange,
  sceneChoice,
  onSceneChange,
  envIntensity,
  onEnvIntensityChange,
  bgIntensity,
  onBgIntensityChange,
  lightsIntensity,
  onLightsIntensityChange,
  onBack,
  onNext,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 11 }}>
        Lighting and the world your avatar lives in. You can tune these later
        in settings — they update live in the scene as you change them.
      </p>

      <EnvChooser
        title="Lighting (HDRI)"
        hint="Image-based lighting + sky background. Scifi = cool reflections; clouds = soft daylight."
        choices={[
          { label: "scifi", value: "/assets/hdri/scifi.exr" },
          { label: "clouds", value: "/assets/hdri/clouds.exr" },
          { label: "none", value: "" },
        ]}
        current={hdriChoice}
        onChange={onHdriChange}
        fileFilters={[
          { name: "HDRI", extensions: ["exr", "hdr"] },
          { name: "All files", extensions: ["*"] },
        ]}
      />

      <WizardSlider
        label="HDRI lighting"
        value={envIntensity}
        min={0}
        max={3}
        step={0.05}
        onChange={onEnvIntensityChange}
      />
      <WizardSlider
        label="HDRI background"
        value={bgIntensity}
        min={0}
        max={2}
        step={0.05}
        onChange={onBgIntensityChange}
      />
      <WizardSlider
        label="Studio lights"
        value={lightsIntensity}
        min={0}
        max={2}
        step={0.05}
        onChange={onLightsIntensityChange}
      />

      <EnvChooser
        title="Scene"
        hint="A 3D set placed around the avatar. Optional."
        choices={[
          { label: "default room", value: "/assets/environment/env.glb" },
          { label: "none", value: "" },
        ]}
        current={sceneChoice}
        onChange={onSceneChange}
        fileFilters={[
          { name: "3D scene", extensions: ["glb", "gltf"] },
          { name: "All files", extensions: ["*"] },
        ]}
      />

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <button onClick={onBack}>Back</button>
        <button onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

function WizardSlider({ label, value, min, max, step, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        <span>{label}</span>
        <span style={{ fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.7)" }}>
          {Number(value).toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </label>
  );
}

function EnvChooser({ title, hint, choices, current, onChange, fileFilters }) {
  // If `current` doesn't match any built-in choice, treat it as a custom path.
  const known = choices.some((c) => c.value === current);

  const browse = async () => {
    if (!window.exuvia?.dialog?.openFile) {
      console.warn("[wizard] dialog API unavailable — running outside Electron?");
      return;
    }
    const picked = await window.exuvia.dialog.openFile({
      title: `Pick ${title.toLowerCase()}`,
      filters: fileFilters,
    });
    if (picked) onChange(picked);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted">{title}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => onChange(c.value)}
            style={{
              padding: "4px 10px",
              background: current === c.value ? "#2a2a3a" : "#1c1c22",
              borderColor: current === c.value ? "#4a4a64" : "#2a2a32",
            }}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={browse}
          style={{
            padding: "4px 10px",
            background: !known && current ? "#2a2a3a" : "#1c1c22",
            borderColor: !known && current ? "#4a4a64" : "#2a2a32",
          }}
        >
          browse…
        </button>
      </div>
      {!known && current && (
        <span className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>
          custom: <code>{current}</code>
        </span>
      )}
      <span className="muted" style={{ fontSize: 11 }}>{hint}</span>
    </div>
  );
}

function pickAgentRow(list, agentId) {
  const arr = Array.isArray(list?.agents)
    ? list.agents
    : Array.isArray(list?.list)
      ? list.list
      : Array.isArray(list)
        ? list
        : [];
  return arr.find((a) => (a.id ?? a.agentId ?? a.name) === agentId);
}

function joinPath(a, b) {
  if (!a) return b;
  if (a.endsWith("/") || a.endsWith("\\")) return a + b;
  // Pick the separator already in use; default to forward slash for portability.
  if (a.includes("\\") && !a.includes("/")) return `${a}\\${b}`;
  return `${a}/${b}`;
}
