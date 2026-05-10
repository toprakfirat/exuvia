# Exuvia

A character-first AI assistant. Drop in a 3D avatar, give it a voice and a
soul, and talk to it. Same character lives in your desktop tray and on chat
platforms (Telegram, WhatsApp, Discord) via the standard
[openclaw](https://docs.openclaw.ai) channel bridge.

> *Exuviation* — the act of shedding a shell. Your AI doesn't have to wear
> the same suit on every surface; this is the shell it wears in your head.

---

## What you get

- **Custom 3D avatars.** Drop in a GLB or FBX, the wizard handles scaling,
  animations, lighting, and post-FX. Each avatar has its own personality
  file (`SOUL.md`), its own form of address for you ("boss", "babe", your
  name), and its own per-clip animation catalogue.
- **Voice in, voice out.** Hold space (or your custom hotkey) to talk;
  transcripts go straight to the avatar. The avatar replies with TTS,
  word-by-word reveal in chat, animation cues on emotional beats.
- **Lives in your tray.** Closing the window hides to the system tray.
  Bind a global hotkey (Ctrl+Shift+E or whatever you like) to summon the
  avatar from anywhere on your system.
- **Same character across every channel.** Configure once, chat from
  Telegram, WhatsApp, Discord, iMessage — the avatar uses the same voice
  and personality everywhere.
- **Sharing.** Export any avatar as a single `.exuvia` file (mesh +
  personality + animations + post-fx). Drag-and-drop the file onto the
  app to import it on another machine.

---

## Quick start

### Prerequisites

- **Node 22+** and **pnpm**
- A running **openclaw gateway** —
  [getting started](https://docs.openclaw.ai/start/getting-started)
- A **GLB or FBX avatar** with at least an idle animation (Mixamo,
  Ready Player Me, or your own)

### Install

```bash
# Clone and install
git clone https://github.com/<you>/exuvia
cd exuvia
pnpm install

# Install the plugin into your gateway
openclaw plugins install --link ./plugin
openclaw gateway

# Run the desktop app
pnpm --filter exuvia-app dev:electron
```

On first launch you'll be asked for your openclaw gateway token (from
`~/.openclaw/openclaw.json`). The app stores it encrypted via the OS
keychain — you won't be asked again.

### Make your first avatar

> Don't have a 3D model handy? There's a sample at
> [`examples/avatar.glb`](./examples/avatar.glb) — drop that into the
> wizard to skip ahead.

1. Click the **+ new avatar** button in the picker
2. Drop in a `.glb` (or `.fbx`)
3. Give it a name and pick what it should call you
4. Paste its personality into `SOUL.md` (anything from "be helpful" to a
   full character sheet — the avatar speaks in this voice)
5. Tag each animation clip so the model knows when to play them
   ("wave" for greetings, "dance" for excitement, etc.)
6. Pick a look — environment HDRI, lighting, optional post-FX preset
7. Commit. The avatar appears in the picker.

Now talk to it.

---

## Daily use

### Talking

- **Type** in the chat bar.
- **Click the mic** or **hold Space** to talk; transcript auto-sends when
  you release.
- **Esc** cancels a recording mid-flight.

The avatar replies with text + TTS audio + (when fitting) a gesture
animation. The model decides whether to gesture each turn based on your
animation tags.

### Hotkeys

Picker (`≡` button) → **HOTKEYS** tab:

- **Push-to-talk** — single key, app-window only (default: Space)
- **Show / hide window** — system-wide combo (default: disabled, suggested:
  Ctrl+Shift+E)
- **Tray icon** — change the icon shown in your system tray

### Sharing avatars

In avatar settings → footer → **export…** writes a `.exuvia` bundle
containing the GLB, personality files, and config — one file, drop it
anywhere.

To import: drag the `.exuvia` file onto the exuvia window (or use the
**↥ import** button in the picker). Avatar appears in the list.

### Voice input setup

The mic button needs a transcription provider. Picker → **VOICE INPUT**
tab, pick one:

- **Groq** — free tier, generous quota (recommended)
- **OpenAI Whisper** — $0.006/min, requires billing
- **Deepgram** — $200 free credits then $0.0043/min

Paste the API key, hit save. Done.

---

## Configuration

Everything lives in `~/.openclaw/openclaw.json` under
`plugins.entries.exuvia.config.avatars.<agentId>`. The wizard and settings
panel write this file for you — you shouldn't need to edit by hand, but
it's plain JSON if you want to.

Per-avatar:

- `avatarPath` — GLB/FBX on disk
- `userAddress` — how the avatar calls you
- `personalityRewrite` — second LLM pass to enforce voice (slower, more
  in-character)
- `voiceLocallyEnabled`, `voiceOnChannels` — where TTS plays
- `animations` — clip catalogue with names, tags, descriptions
- `environmentHdriPath`, `scenePath`, `lights`, `postProcessing` — look
- and a stack of post-FX knobs (bloom, color grading, film grain, etc.)

App-wide (Electron settings.json):

- `toggleHotkey` — global show/hide accelerator
- `voiceHotkey` — push-to-talk key code

---

## Architecture

```
exuvia/
├─ plugin/      openclaw plugin (TypeScript)
│              ├─ play_animation tool
│              ├─ personality-rewrite hook
│              └─ per-avatar config sidecar
└─ app/         Electron + React + Three.js
               ├─ tray + global hotkey
               ├─ 3D avatar renderer
               ├─ voice in (MediaRecorder → openclaw audio.transcribe)
               ├─ TTS out (gateway tts.convert → local audio playback)
               └─ wizard / settings / export / import
```

The plugin runs inside openclaw's gateway. It registers `play_animation`
so the LLM can call it as a structured tool, and a `message_sending`
hook that rewrites assistant text in the avatar's voice. Everything
else — chat, sessions, channels, model providers — is stock openclaw.

The desktop app talks to the gateway over WebSocket (port 18789 by
default). When you switch avatars, the app reads the per-avatar config
from `plugins.entries.exuvia.config.avatars.<id>` and reconfigures the
scene.

See [`PLAN.md`](./PLAN.md) for the full architecture and design notes.

---

## Troubleshooting

**Mic button says "no transcript returned"**
You don't have an audio provider configured. Open the picker → Voice
input tab and set one up.

**Avatar doesn't animate when I expect it to**
Make sure each animation clip has descriptive **tags** (in the avatar's
settings → Animations tab). The model picks clips based on tag matches —
bare names like `dance` work but tags like `["happy", "celebrate"]`
work much better.

**Mic captures but transcript is empty**
Your audio provider is configured but the recording was silent. Check
your default microphone in Windows sound settings. If the recording is
fine, the chosen provider may not accept webm/opus — switch providers in
the Voice input tab.

**Replies start with `[Thinking]` or stage directions like "(rolls eyes)"**
The model is leaking chain-of-thought or roleplay narration. The app
strips most of it client-side, but if you're seeing them: try a stronger
model, or toggle off the **Force-rewrite replies in voice** option in
Identity tab.

**Gateway disconnects when I save settings**
Expected — openclaw hot-reloads the plugin runtime when its config
changes, which closes the WS briefly. The app reconnects automatically.

---

## Distribution

This repo *is* the distribution. To share with someone:

```bash
openclaw plugins install git:github.com/<you>/exuvia#main
```

openclaw handles fetch + build automatically. The desktop app is a
standard pnpm/Electron project; until we ship an installer (next
milestone), users clone and run `pnpm dev:electron`.

---

## License

[insert your license here]
