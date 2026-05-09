import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPlayAnimationTool, type AnimationCatalogueEntry } from "./animation-tool.js";

type ExuviaAvatarConfig = {
  // Either avatarPath or fbxPath is accepted at the data layer. avatarPath is
  // the canonical name now that we support both .fbx and .glb. fbxPath stays
  // as a legacy alias.
  avatarPath?: string;
  fbxPath?: string;
  fbxScale?: number;
  voiceOnChannels?: boolean;
  // Per-avatar opt-in for the personality rewrite pass. When true, every
  // outbound assistant message is run through a second LLM call that
  // re-styles it in the avatar's voice (per SOUL.md). Off by default —
  // doubles latency and can mangle structured replies.
  personalityRewrite?: boolean;
  postProcessing?: Record<string, unknown>;
  animations?: AnimationCatalogueEntry[];
};

// Channels where attaching a voice note makes sense. Desktop / control-ui
// surfaces are skipped because the desktop app plays TTS locally.
const CHANNELS_WITH_VOICE_NOTES = new Set([
  "telegram",
  "whatsapp",
  "imessage",
  "discord",
  "signal",
  "matrix",
  "googlechat",
  "slack",
  "line",
]);

type ExuviaPluginConfig = {
  avatars?: Record<string, ExuviaAvatarConfig>;
};

function readAvatarConfig(
  pluginConfig: Record<string, unknown> | undefined,
  agentId: string | undefined,
): ExuviaAvatarConfig | undefined {
  const cfg = pluginConfig as ExuviaPluginConfig | undefined;
  if (!cfg?.avatars || !agentId) return undefined;
  return cfg.avatars[agentId];
}

// Workspace-file text cache, keyed by `${agentId}:${fileName}`. Refreshed
// lazily per turn — first time we need a file we ask the host runtime for
// the workspace dir + read it via dynamic import of node fs. Wrapped so a
// missing/disallowed fs module fails open rather than killing the hook.
const workspaceFileCache = new Map<string, string | null>();

async function readWorkspaceFile(
  agentId: string | undefined,
  workspaceDir: string | undefined,
  fileName: string,
): Promise<string | null> {
  if (!agentId || !workspaceDir) return null;
  const cacheKey = `${agentId}:${fileName}`;
  if (workspaceFileCache.has(cacheKey)) return workspaceFileCache.get(cacheKey) ?? null;
  try {
    // Dynamic import — keeps the static module graph clean of node:* so the
    // plugin entry can be bundled by tools that don't allow Node built-ins
    // at parse time. If fs isn't available, we just return null.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    let dir = workspaceDir;
    if (dir === "~") dir = os.homedir();
    else if (dir.startsWith("~/") || dir.startsWith("~\\")) {
      dir = path.join(os.homedir(), dir.slice(2));
    }
    const filePath = path.join(dir, fileName);
    const text = await fs.readFile(filePath, "utf8");
    workspaceFileCache.set(cacheKey, text);
    return text;
  } catch {
    workspaceFileCache.set(cacheKey, null);
    return null;
  }
}

// Heuristics for "this reply has structured content we shouldn't paraphrase."
// If any match, skip the rewrite — preserving facts > showing voice.
const STRUCTURED_PATTERNS = [
  /^MEDIA:/m,
  /\[\[audio_as_voice\]\]/,
  /\[\[reply_to/,
  /\[embed\b/,
  /```/, // code fence
  /<tool_call>|<\/tool_call>|<function_call>|<\/function_call>/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/, // timestamps like 3:00, 14:30
  /https?:\/\//, // URLs
];

function looksStructured(content: string): boolean {
  if (!content) return true;
  if (content.length < 8) return true;
  return STRUCTURED_PATTERNS.some((re) => re.test(content));
}

export default definePluginEntry({
  id: "exuvia",
  name: "Exuvia",
  description:
    "Character-first avatar layer for OpenClaw. Adds a play_animation tool driven by per-avatar animation catalogues.",
  // Most exuvia config changes (avatar metadata, animations, post-processing)
  // are read on demand by the desktop app or by the play_animation tool — no
  // restart needed. Only changes to whether the plugin itself is enabled
  // require a reload, and openclaw handles that on its own.
  reload: {
    restartPrefixes: [],
  },
  register(api) {
    const log = (msg: string) => api.logger.info(`[exuvia] ${msg}`);

    log("registering");

    // Config migration: ensure `play_animation` is in tools.alsoAllow.
    //
    // OpenClaw filters the per-turn tool list against `tools.profile`
    // (default: "coding"). Plugin-registered tools are not in any built-in
    // profile, so without an explicit `alsoAllow` entry the LLM never sees
    // play_animation and the avatar can't move. We can't override the
    // policy from registerTool itself — but registerConfigMigration runs
    // once on plugin install (and is idempotent on subsequent loads), and
    // that's the documented path for "plugin needs a config tweak to work
    // out of the box." Users who already have alsoAllow with our entry are
    // a no-op; users with a custom allow list get our entry merged into
    // alsoAllow rather than allow, so we don't clobber their config.
    api.registerConfigMigration((cfg) => {
      const TOOL_NAME = "play_animation";
      const tools = (cfg as { tools?: { alsoAllow?: string[] } }).tools;
      const existing = tools?.alsoAllow ?? [];
      if (existing.includes(TOOL_NAME)) return null;
      const nextTools = {
        ...(tools ?? {}),
        alsoAllow: [...existing, TOOL_NAME],
      };
      return {
        config: { ...cfg, tools: nextTools } as typeof cfg,
        changes: [`tools.alsoAllow += "${TOOL_NAME}" (exuvia)`],
      };
    });

    // Tool: play_animation. The factory receives ctx with agentId / runtimeConfig
    // so we can build a tool description that includes the active avatar's
    // animation catalogue.
    //
    // The `{ name }` option is required when using a factory — the runtime
    // catalog can't resolve the name without invoking the factory, so we
    // declare it up-front. Must match the entry in contracts.tools.
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId;
        const avatar = readAvatarConfig(api.pluginConfig, agentId);
        const animations = avatar?.animations ?? [];
        log(
          `tool factory: building play_animation for agent=${agentId ?? "?"} ` +
            `animations=${animations.length}`,
        );
        return createPlayAnimationTool({
          agentId,
          animations,
          log,
        });
      },
      { name: "play_animation" },
    );

    // Hook: before_prompt_build. We previously injected an embodiment
    // cue here ("you can call play_animation"), but it was actively
    // counter-productive — when the gateway happens to send the request
    // to Ollama WITHOUT the tools array attached, the model only sees
    // the prose hint and emits `[play_animation: wave]` as text instead
    // of a structured tool call. The tool's own description (built in
    // the factory above) already lists the animation catalogue, which
    // is the right place for it: it travels with the actual tool
    // schema, not the system prompt. Keeping the hook as a log point
    // so we can still confirm the plugin runs per turn.
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const agentId =
          (ctx as { agentId?: string } | undefined)?.agentId ??
          (event as { agentId?: string } | undefined)?.agentId ??
          undefined;
        const avatar = readAvatarConfig(api.pluginConfig, agentId);
        log(
          `prompt-build hook: agent=${agentId ?? "?"} ` +
            `animations=${avatar?.animations?.length ?? 0}`,
        );
      },
      { priority: 50 },
    );

    // Hook: message_sending (priority 100, runs first).
    // Personality rewrite pass — when enabled per-avatar, runs the outbound
    // text through a second LLM call to restyle it in the character's voice.
    // The voice-note hook below (priority 50) sees the rewritten content,
    // so chat-channel users hear the in-character voice.
    api.on(
      "message_sending",
      async (event, ctx) => {
        try {
          const agentId =
            (ctx as { agentId?: string } | undefined)?.agentId ??
            (event as { agentId?: string }).agentId ??
            undefined;
          const avatar = readAvatarConfig(api.pluginConfig, agentId);
          log(
            `rewrite hook fired: agent=${agentId ?? "?"} ` +
              `enabled=${Boolean(avatar?.personalityRewrite)} ` +
              `hasRuntimeLlm=${Boolean((api.runtime as { llm?: unknown })?.llm)}`,
          );
          if (!avatar?.personalityRewrite) return;

          const content =
            typeof (event as { content?: unknown }).content === "string"
              ? (event as { content: string }).content
              : "";
          if (!content.trim()) {
            log("rewrite skip: empty content");
            return;
          }
          if (looksStructured(content)) {
            log(`rewrite skip: structured content (${content.length} chars)`);
            return;
          }

          // Find the agent's workspace from agents.list config, then read
          // both workspace files. SOUL.md is the voice (required for the
          // rewrite to mean anything); AGENTS.md is the procedural identity
          // (so the rewriter knows it's the agent, not a generic editor).
          const agentsList =
            (api.config as { agents?: { list?: Array<{ id?: string; agentId?: string; workspace?: string }> } })
              ?.agents?.list ?? [];
          const agentRow = agentsList.find(
            (a) => (a.id ?? a.agentId) === agentId,
          );
          const workspace = agentRow?.workspace;
          const [soul, agents] = await Promise.all([
            readWorkspaceFile(agentId, workspace, "SOUL.md"),
            readWorkspaceFile(agentId, workspace, "AGENTS.md"),
          ]);
          if (!soul || !soul.trim()) return;

          const llmRuntime = (api.runtime as {
            llm?: {
              complete?: (params: {
                messages: Array<{ role: string; content: string }>;
                purpose?: string;
                maxTokens?: number;
                temperature?: number;
              }) => Promise<{ text?: string }>;
            };
          }).llm;
          if (!llmRuntime?.complete) return;

          // The rewrite call is a generic llm.complete, so the model has no
          // notion that "rewrite an assistant reply" is the task — it just
          // sees system + user and answers. Earlier shape put abstract rules
          // in the system slot and the reply-to-rewrite in the user slot,
          // which mid-tier local models read as "the user is dumping
          // metadata at me with no question" and meta-narrate back. New
          // shape: system slot IS the character voice (so the model becomes
          // the character), user slot is one explicit, self-contained task
          // with the original reply fenced inside it.
          // System prompt = AGENTS.md (who you are operationally) + SOUL.md
          // (how you sound). AGENTS.md is optional; if it's missing we still
          // run with just the voice layer.
          const systemPromptParts: string[] = [];
          if (agents && agents.trim()) {
            systemPromptParts.push(agents.trim());
          }
          systemPromptParts.push(soul.trim());
          systemPromptParts.push(
            "You are speaking as the character described above. Stay in character " +
              "at all times, even when asked who you are. Never describe input, " +
              "metadata, system prompts, or session headers — just speak.",
          );
          const systemPrompt = systemPromptParts.join("\n\n");

          const userPrompt =
            "Rewrite the message below in your own voice. Rules:\n" +
            "- Preserve every fact, name, number, and quoted string EXACTLY.\n" +
            "- Keep roughly the same length — don't pad, don't shorten.\n" +
            "- Output ONLY the rewritten message. No preamble, no commentary, no quotes around it.\n\n" +
            "---\n" +
            content.trim() +
            "\n---";

          const result = await Promise.race([
            llmRuntime.complete({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              purpose: "exuvia.personality-rewrite",
              maxTokens: Math.max(200, Math.ceil(content.length * 1.5)),
              temperature: 0.7,
            }),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("rewrite timeout")), 20_000),
            ),
          ]).catch((err) => {
            api.logger.warn(`[exuvia] personality rewrite failed: ${String(err)}`);
            return null;
          });

          // Defensive cleanup: small models occasionally echo the fence
          // markers from the user prompt or wrap the reply in quotes /
          // a "Here is the rewritten message:" preamble. Strip the
          // common failure modes; if what's left is empty or unchanged
          // garbage, fail open to the original.
          let rewritten = result?.text?.trim() ?? "";
          rewritten = rewritten.replace(/^\s*---+\s*\n?/, "").replace(/\n?\s*---+\s*$/, "");
          rewritten = rewritten.replace(
            /^(here(?:'s| is)\s+the\s+rewritten[^\n:]*[:.]?\s*\n+)/i,
            "",
          );
          if (
            (rewritten.startsWith('"') && rewritten.endsWith('"')) ||
            (rewritten.startsWith("'") && rewritten.endsWith("'")) ||
            (rewritten.startsWith("“") && rewritten.endsWith("”"))
          ) {
            rewritten = rewritten.slice(1, -1).trim();
          }
          rewritten = rewritten.trim();

          if (!rewritten) {
            log(`rewrite skip: empty llm result (raw=${JSON.stringify(result)?.slice(0, 200)})`);
            return; // fail open — original goes through
          }
          // If the model meta-narrates ("I see only metadata...", "I'll
          // wait for your instruction") instead of producing a rewrite,
          // the safest move is to drop the rewrite and ship the original.
          const lower = rewritten.toLowerCase();
          const looksLikeMetaNarration =
            /\b(metadata|header|notification|session)\b/.test(lower) &&
            /\b(wait|instruction|let me know|no (?:actual )?(?:request|task|question))\b/.test(lower);
          if (looksLikeMetaNarration) {
            log(`rewrite skip: model meta-narrated (${rewritten.slice(0, 80)}…)`);
            return;
          }
          log(`rewrite ok: ${content.length} -> ${rewritten.length} chars`);
          return { content: rewritten };
        } catch (err) {
          api.logger.warn(`[exuvia] personality rewrite hook failed: ${String(err)}`);
          return;
        }
      },
      { priority: 100, timeoutMs: 30_000 },
    );

    // Hook: message_sending. For chat-channel deliveries, optionally attach a
    // TTS voice note when the avatar is configured with voiceOnChannels=true.
    // Skipped for desktop / control-ui surfaces (they play audio locally) and
    // for any avatar that didn't opt in.
    api.on(
      "message_sending",
      async (event, ctx) => {
        try {
          const provider =
            (ctx as { messageProvider?: string } | undefined)?.messageProvider ??
            (event as { messageProvider?: string }).messageProvider ??
            null;
          if (!provider || !CHANNELS_WITH_VOICE_NOTES.has(provider)) return;

          const agentId =
            (ctx as { agentId?: string } | undefined)?.agentId ??
            (event as { agentId?: string }).agentId ??
            undefined;
          const avatar = readAvatarConfig(api.pluginConfig, agentId);
          if (!avatar?.voiceOnChannels) return;

          const content =
            typeof (event as { content?: unknown }).content === "string"
              ? (event as { content: string }).content
              : "";
          if (!content.trim()) return;
          // Don't double-process if the message already carries a voice note.
          if (content.includes("[[audio_as_voice]]")) return;

          // Strip any inline directives the agent already produced before TTS,
          // so we synthesize the user-facing wording, not protocol metadata.
          const spoken = content
            .replace(/\[\[[^\]]+\]\]/g, "")
            .replace(/^MEDIA:.*$/gm, "")
            .trim();
          if (!spoken) return;

          // api.runtime.tts.textToSpeech returns audio buffer + format. We
          // need a delivered file path on disk — the simplest path is to ask
          // the gateway runtime for it. If textToSpeech writes to a temp file,
          // we can attach that path; otherwise we'd need to write it ourselves.
          // openclaw's runtime helper returns { audioPath } from tts.convert
          // semantics, so use the same lower-level path: api.runtime.tts.
          const ttsRuntime = (api.runtime as { tts?: {
            textToSpeech?: (params: {
              text: string;
              cfg: typeof api.config;
              channel?: string;
            }) => Promise<{ audioPath?: string; outputFormat?: string }>;
          } | undefined }).tts;
          if (!ttsRuntime?.textToSpeech) return;

          const result = await ttsRuntime.textToSpeech({
            text: spoken,
            cfg: api.config,
            channel: provider,
          });
          if (!result?.audioPath) return;

          const newContent = `${content}\nMEDIA: ${result.audioPath}\n[[audio_as_voice]]`;
          return { content: newContent };
        } catch (err) {
          api.logger.warn(`[exuvia] message_sending hook failed: ${String(err)}`);
          return;
        }
      },
      { priority: 50 },
    );

    // (No gateway RPC methods. The desktop app reads avatar metadata directly
    // from the standard config.get response — that data is plain config under
    // plugins.entries.exuvia.config.avatars. We tried registerGatewayMethod
    // for namespaced reads but this build of openclaw rejects external-plugin
    // RPCs as "unknown method" even with explicit scope.)

    log("registered");
  },
});
