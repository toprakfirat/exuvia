# Exuvia — Plan

A character-first AI assistant. The user picks an avatar (their character), talks to
it on the desktop via a 3D scene with voice, and reaches the same character on
messaging channels (Telegram, WhatsApp, etc.) where it falls back to text plus
optional gif/voice-note attachments.

The "brain" is **openclaw** — its agent loop, model providers, channels, sessions,
and memory are reused as-is. We do not build a backend.

---

## Architecture

Three artifacts. They live in one repo, ship together.

```
exuvia/
├── plugin/                     ← runs inside openclaw's gateway process
├── app/                        ← Electron + React + Three.js desktop app
└── PLAN.md                     ← this file
```

```
                  ┌───────────────────────────────────────┐
                  │            openclaw gateway           │
 user (any        │                                       │
 channel) ────────┤   agent loop                          │
                  │                                       │
                  │   ┌────────────────────────────────┐  │
                  │   │  exuvia plugin                 │  │
                  │   │                                │  │
                  │   │  • before_prompt_build         │  │ ← personality
                  │   │  • registerTool(play_animation)│  │ ← LLM-driven anim
                  │   │  • message_sending             │  │ ← per-channel routing
                  │   │  • runtime.tts.textToSpeech    │  │ ← claw-owned voice
                  │   │  • plugin.* broadcast events   │──┼──► to desktop app
                  │   └────────────────────────────────┘  │
                  └───────────────────────────────────────┘
                                    │  WebSocket (gateway protocol)
                                    ▼
                  ┌───────────────────────────────────────┐
                  │         exuvia desktop app            │
                  │  Electron + React + Three.js          │
                  │                                       │
                  │  • Avatar picker                      │
                  │  • Avatar creator wizard              │
                  │  • 3D scene (FBX + animations)        │
                  │  • Chat UI (one session per avatar)   │
                  └───────────────────────────────────────┘
```

---

## Avatar = openclaw agent

Each avatar maps onto openclaw's existing **multi-agent** model:

| Avatar concept       | Where it lives in openclaw                                 |
|----------------------|------------------------------------------------------------|
| Identity             | `agentId` (e.g. `nova`, `rex`)                             |
| Personality          | `~/.openclaw/workspace-<id>/AGENTS.md` and `SOUL.md`       |
| Chat history         | `~/.openclaw/agents/<id>/sessions/`, key `agent:<id>:main` |
| Per-avatar config    | `agents.list[<id>]` — model, tools, sandbox                |
| Per-avatar channels  | `bindings: [{ agentId: "<id>", match: { ... } }]`          |
| FBX + animation list | `plugins.entries.exuvia.config.avatars.<id>` (sidecar)     |

We do **not** build a separate avatar database. Openclaw is the source of truth.
Our plugin only stores the avatar-specific extras (fbx path, animation
descriptions/tags) under its own config namespace.

---

## Sessions: one per avatar

- Direct chats collapse to `agent:<avatarId>:main`. One ongoing conversation per
  avatar per peer — same model claw uses for messaging channels.
- No multi-thread sidebar, no "new chat" button.
- Switching avatars in the UI = `sessions.messages.unsubscribe` + load new FBX
  + `sessions.messages.subscribe` + `chat.history`.
- Sessions persist on disk. Switching away does not destroy or pause anything;
  the conversation is just not currently displayed.
- "Fresh start" with an avatar = explicit `sessions.reset` button in that
  avatar's settings. Wipes history, keeps the avatar.

---

## Personality strategy

**Layered system prompt, not post-hoc rewrite.**

- `AGENTS.md` (per-avatar workspace file): core agent behavior — competent,
  factual, returns structured data verbatim, picks tools when needed.
- `SOUL.md` (per-avatar workspace file): voice and tone — character description,
  mannerisms, what they care about. Explicitly scoped to user-facing wording,
  not to reasoning or facts.

We add a `before_prompt_build` hook in the plugin only if needed for
per-channel adjustments (e.g. "shorter on Telegram"). For the default desktop
experience, claw's existing workspace-file loading handles personality.

**No second LLM call for stylization.** That path corrupts facts and doubles
latency. Revisit only if a specific character cannot be held by a system prompt.

---

## Animations: FBX-driven

- The user uploads a `.fbx`. We parse animations with `three.js FBXLoader` →
  `fbx.animations` (clip names, durations, looping inferred from suffix
  conventions like `_loop` / `_once`).
- Creator wizard asks for **description** and **tags** per clip.
- Catalogue stored under
  `plugins.entries.exuvia.config.avatars.<id>.animations`. No separate database.

**LLM picks animations via tool calls.** The plugin registers
`play_animation(name)` with `api.registerTool(...)`. The tool's description
contains the avatar's animation list (or a tag-filtered subset). The model
chooses to call it when an animation adds emotional meaning — sparingly, per
the system prompt.

When called:
- Plugin emits a `plugin.exuvia.animation` broadcast event with
  `{ animation, sessionKey, agentId }`.
- Desktop app (subscribed to that session) receives the event, plays the clip
  on the live avatar.
- For chat-channel surfaces, the same hook can attach a pre-rendered gif
  (one-time art-pipeline bake per clip) via openclaw's `MEDIA:` directive.

For v1 we ship desktop-only animation playback. Gif-on-channels comes after.

---

## Voice (TTS)

- Use openclaw's `api.runtime.tts.textToSpeech({ text, cfg })`.
- Whatever TTS provider the operator configured runs — voice-cloning provider
  if they want, sherpa-onnx if they want simple, etc. The plugin does not own
  TTS infrastructure.
- Audio is attached to the outbound message envelope. Desktop app plays it,
  syncs progressive text reveal (port the existing approach from
  `ai-assistant`).

For chat-channel surfaces, we can attach the audio as a voice note via
`[[audio_as_voice]]` — optional, per-avatar setting.

---

## Desktop app shape

```
┌─────────────────────────────────────────────────┐
│  [Nova] [Rex] [Mira] [+ New avatar]   [⚙]       │  avatar picker
├─────────────────────────────────────────────────┤
│                                                 │
│         ┌───────────────────────┐               │
│         │   3D scene            │               │
│         │   (selected avatar)   │               │
│         └───────────────────────┘               │
│                                                 │
├─────────────────────────────────────────────────┤
│  Nova: Welcome back!                            │
│  You: what's on my calendar today               │  chat with selected avatar
│  Nova: You have a 3pm with Alex...              │
│                                                 │
│  [type a message...]                       [↑]  │
└─────────────────────────────────────────────────┘
```

**Connection:** WebSocket to local openclaw gateway. First launch asks for the
shared secret (from `openclaw onboard`); subsequent launches reuse the
device token persisted in Electron's secure storage. Loopback connections
auto-pair, so no manual approval flow is needed.

**Scopes:** `operator.read` + `operator.write`.

**Subscriptions per active avatar:**
- `sessions.messages.subscribe` for `agent:<id>:main`
- `plugin.*` broadcasts (filtered to `plugin.exuvia.*` for the active avatar)

---

## Avatar creator wizard

A flow inside the desktop app, not a separate tool.

1. User drops in a `.fbx`.
2. App parses animations → list of `{ name, duration, loop }`.
3. Form asks for:
   - Name (becomes `agentId`, slugified)
   - Personality description (saved as `SOUL.md`)
   - Optional `AGENTS.md` overrides (default ships a sensible base)
   - Voice provider/voice id (writes per-agent TTS config)
   - Per-animation: short tags + longer description
4. Optional: pair a Telegram/WhatsApp account and add a binding.
5. Wizard commits via gateway RPC:
   - `agents.create` → new agent record + workspace
   - `agents.files.set` → write `AGENTS.md` / `SOUL.md`
   - `config.patch` → add binding(s) and
     `plugins.entries.exuvia.config.avatars.<id>` sidecar
6. Avatar appears in the picker.

---

## What we are NOT building

- A backend / agent loop / model server (claw owns this)
- A chat database (claw owns this)
- A memory system (claw's memory plugins own this)
- A second LLM client (use `api.runtime.llm` if ever needed)
- A TTS server (use `api.runtime.tts`)
- A separate WebSocket transport (use claw's gateway WS + `plugin.*` events)
- A multi-thread chat UI (one session per avatar, full stop)

---

## Verifications resolved

- **Per-agent voice config:** `agents.list[].tts` exists and deep-merges over
  global `messages.tts`. Has a `persona` field too. Per-avatar voice is a
  one-line config write.
- **Plugin → desktop event channel:** no separate broadcast needed. The
  `play_animation` tool's invocation lands in the session transcript as a
  `session.tool` event. The desktop app, already subscribed via
  `sessions.messages.subscribe`, receives it and plays the clip. Tool-call
  events are the event channel.
- **Plugin-owned RPC if needed:** `api.registerGatewayMethod(name, handler)`
  for one-shot calls (e.g. avatar metadata fetch), `api.registerSessionExtension(...)`
  for projected per-session state. Both are documented and used by the
  official Control UI.

---

## Build order

### Phase 1 — Plumbing
- [ ] Resolve open verifications (plugin broadcast + per-agent voice config)
- [ ] Scaffold `plugin/` (`openclaw.plugin.json`, `index.ts`, `package.json`)
- [ ] Plugin registers a no-op `play_animation` tool, logs invocations
- [ ] Plugin reads its config namespace and exposes a small RPC for the desktop
      app to read avatar metadata (or use `config.get` directly)
- [ ] Scaffold `app/` (Electron + Vite + React)
- [ ] Connect to gateway, persist device token, list `agents.list`

### Phase 2 — Single-avatar happy path  ✅ scaffolded
- [x] Hard-code one avatar; load its FBX; render scene
      (`app/src/components/AvatarScene.jsx` — minimal port of `ThreeScene.jsx`,
      no postprocessing yet)
- [x] `chat.history` + `sessions.messages.subscribe` + `chat.send`
      (already in Phase 1 via `useSession`)
- [x] TTS playback synced to text reveal (`app/src/hooks/useTTS.js` —
      gateway `tts.convert` + Electron-IPC audio file read + word-reveal
      cadence)
- [x] Plugin → app animation broadcast end-to-end via `session.tool` events
      (`useSession` invokes `onToolCall`; `App.jsx` routes `play_animation`
      to `sceneRef.playAnimation(name)`)
- [ ] Live verification on real gateway + real FBX (next session)

### Phase 3 — Multi-avatar  ✅ scaffolded
- [x] Avatar picker labels exuvia avatars vs. plain claw agents
      (`AgentPicker.jsx` joins `agents.list` with `plugin.exuvia.listAvatars`)
- [x] Switching avatars: already wired in Phase 2 — picking a different
      pill triggers session unsub/sub + `useAvatarConfig` re-fetch + scene
      reload via `fbxPath` prop change
- [x] Avatar creator wizard end-to-end (`CreatorWizard.jsx`):
      drop FBX → in-browser `parseFbxFile` → identity → personality
      (SOUL.md, optional AGENTS.md override) → per-clip description+tags →
      commit chain `agents.create` → `agents.files.set` (×n) →
      `agents.list` (resolve workspace path) → Electron IPC writes FBX →
      `config.patch` registers avatar
- [ ] Live verification on real gateway (next session)

### Phase 4 — Channel polish  ✅ scaffolded
- [x] Per-animation `gifPath` config; `play_animation` tool result attaches
      `MEDIA: <gifPath>` so chat-channel adapters deliver the gif inline.
      The wizard **bakes the clip in-app** from the FBX (offscreen Three.js
      scene + `MediaRecorder` → webm), no separate gif tooling needed. Files
      land in `<workspace>/gifs/<animation>.webm`.
- [x] `message_sending` plugin hook: per-avatar `voiceOnChannels` flag
      (default off) generates a TTS audio file for outbound chat-channel
      messages and attaches `[[audio_as_voice]]` + `MEDIA:`.
- [x] Channels considered "voice-capable" gated by an explicit allowlist
      (`telegram, whatsapp, imessage, discord, signal, matrix, googlechat,
      slack, line`); desktop / control-ui surfaces skip the hook.

### Phase 6 — Post-processing  ✅ scaffolded
- [x] `lib/post-processing-shaders.js`: Distance blur, barrel distortion,
      color grading (contrast/brightness/saturation/temperature/vignette),
      film grain. Plus four presets (raw, cinematic, anime, dreamy) and
      `defaultPostProcessing()`.
- [x] `AvatarScene` runs an `EffectComposer` chain when at least one effect
      is enabled; falls back to direct render otherwise. Rebuilds when the
      enabled set changes; live-updates uniforms on tunable changes.
      Includes `UnrealBloomPass` from three's stdlib.
- [x] `EffectsSection.jsx`: per-effect toggle + sliders, plus a row of
      preset buttons that replace the avatar's whole `postProcessing`
      object in one click.
- [x] Settings panel includes the section; `postProcessing` is committed in
      the `config.patch` payload alongside other avatar fields.
- [x] **Live preview** — `AvatarSettings` mirrors local edits to App via
      `onPreview`; App passes the preview avatar into the scene so slider
      drags and toggle clicks reflect *immediately* before save. Cleared
      on close, save, or delete.
- [x] **Quality toggle** — `postProcessing.quality: "high"|"low"`. Low halves
      bloom render-target resolution (~4× cheaper on integrated GPUs). Part
      of the chain signature so toggling rebuilds at the new size.
- [x] **Look picker in wizard commit step** — preset selector (raw is the
      default) so new avatars don't start with a blank scene. Saves the
      preset's full `postProcessing` object during avatar creation.
- [ ] Custom GLSL fragment shaders (deferred — built-in chain + presets
      cover most use cases; raw shaders introduce GPU-hang risks and a
      forever-API surface, revisit if there's a concrete need).

### Phase 5 — Settings and quality  ✅ scaffolded
- [x] Per-avatar settings panel (`AvatarSettings.jsx`): edit SOUL.md,
      FBX path/scale, voiceOnChannels, animation tags/descriptions/gifPaths.
      Save commits via `agents.files.set` + `config.patch`.
- [x] `sessions.reset` button per avatar (with confirm) — clears history,
      keeps avatar.
- [x] `agents.delete` button (with confirm) — full removal of agent + its
      sidecar config.
- [x] Inline channel pairing (`ChannelPairing.jsx`): Telegram fully wired
      (BotFather token paste → `config.patch` writes account + binding).
      Other channels show CLI hints because their pairing flows (QR scans,
      OAuth, mobile apps) don't fit a paste form.
- [x] Settings reachable from a `⚙` button on the active avatar's pill in
      the picker.

---

## Decisions on file

- **Wrapper**: Electron (chosen for v1; revisit Tauri if footprint becomes a
  concern post-MVP).
- **Frontend stack**: React + Three.js, ported from `ai-assistant`.
- **Avatar = agent**: each avatar is one openclaw `agentId` with its own
  workspace, sessions, auth, and bindings.
- **Sessions**: one per avatar (`agent:<id>:main`), no multi-thread.
- **Personality**: `AGENTS.md` + `SOUL.md` per workspace; no rewrite pass.
- **Animations**: parsed from FBX at upload; LLM-driven via `registerTool`.
- **Storage**: openclaw owns chat, sessions, memory, agent config. Plugin owns
  only avatar-specific sidecars (fbx path, animation metadata).
- **Provider**: model-agnostic. Whatever provider the user configures in claw.

---

## Glossary

- **Agent (claw)** — a fully scoped persona with workspace, sessions, auth.
  In exuvia, one avatar = one agent.
- **Session** — a stored conversation, keyed by `agent:<id>:<mainKey>`.
- **Plugin** — TypeScript module loaded by claw at startup; can register
  tools, hooks, HTTP routes, broadcasts.
- **Hook** — a typed extension point in claw's agent loop (e.g.
  `before_prompt_build`, `message_sending`).
- **Tool** — a typed function the LLM can call. Registered by the plugin,
  declared in the manifest's `contracts.tools`.
- **Binding** — config rule routing a channel/account/peer to an `agentId`.
- **Canvas** — claw's existing iframe-based plugin surface for rich rendering.
  We are not using it; the avatar lives in our own desktop app, not in the
  Control UI.
