<p align="center">
  <img src="./docs/logo.png" alt="exuvia" width="180" />
</p>

<h1 align="center">exuvia</h1>

<p align="center">
  <em>A character-first AI assistant.</em><br />
  Drop in a 3D avatar, give it a voice and a soul, and talk to it.
</p>

<p align="center">
  <a href="https://github.com/<you>/exuvia/releases"><img alt="release" src="https://img.shields.io/github/v/release/<you>/exuvia?label=download&color=ff7a3a" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-blue" /></a>
  <a href="https://docs.openclaw.ai"><img alt="openclaw" src="https://img.shields.io/badge/built%20on-openclaw-6cf" /></a>
</p>

---

Same character lives in your desktop tray and on chat platforms (Telegram,
WhatsApp, Discord) via the standard
[openclaw](https://docs.openclaw.ai) channel bridge.

> *Exuviation* — the act of shedding a shell. Your AI doesn't have to wear
> the same suit on every surface; this is the shell it wears in your head.

---

## What you get

- **Custom 3D avatars.** Drop in a GLB or FBX, the wizard handles scaling,
  animations, lighting, and post-FX. Each avatar has its own personality
  file (`SOUL.md`), its own form of address for you ("boss", "babe", your
  name), and its own per-clip animation catalogue.
- **Cinematic look, fully tunable.** Each avatar has its own scene —
  swap in any HDRI for image-based lighting, drop in a GLB room as the
  set, sculpt the lighting rig (key/fill/rim and as many extra lights as
  you want, each with color, intensity, and position), then layer on
  post-FX: bloom, distance blur, barrel distortion, color grading,
  vignette, film grain. Drag the sliders, watch the scene update live.
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

- **openclaw** running on your machine —
  [install guide](https://docs.openclaw.ai/start/getting-started). exuvia
  uses openclaw as its agent runtime; without it the app can't do
  anything.

### Install (the easy way)

Grab the latest installer from the
[**Releases page**](https://github.com/<you>/exuvia/releases) and run it.

**Windows** — download `exuvia Setup x.y.z.exe`, double-click.
On the first run Windows SmartScreen will warn that the app is unsigned;
click *More info → Run anyway*. Installer adds a desktop shortcut, a
Start Menu entry, and the app starts in your system tray.

**macOS** — download `exuvia-x.y.z-universal.dmg`, open it, drag exuvia
to Applications. The first time you launch, macOS blocks it because the
app isn't notarized: *right-click the icon → Open → Open anyway*. Only
needed once.

**Linux** — download `exuvia-x.y.z.AppImage`, `chmod +x` it, double-click.
No install step needed; the AppImage is the app.

On first launch the app auto-installs its openclaw plugin and asks for
your gateway token (from `~/.openclaw/openclaw.json`). The token is
stored encrypted in your OS keychain — you won't be asked again.

### Install (from source)

If you want to hack on exuvia or run unreleased code:

```bash
git clone https://github.com/<you>/exuvia
cd exuvia
pnpm install

# install the plugin into your openclaw gateway
openclaw plugins install --link ./plugin
openclaw gateway

# start the desktop app in dev mode
pnpm --filter exuvia-app dev:electron
```

To build your own installer instead of running from source:

```bash
pnpm dist          # Windows .exe (requires running on Windows)
pnpm dist:linux    # Linux AppImage (any platform with electron-builder)
pnpm dist:mac      # macOS .dmg (requires running on macOS)
```

Output lands in `app/dist-electron/`.

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

### Customizing the look

Click an avatar's ⚙ icon in the picker to open its settings. Three tabs
matter for the look:

- **Scene** — environment HDRI and how strongly it lights vs. shows as a
  visible sky; the optional 3D set GLB and how big it sits relative to
  the avatar; per-light controls. Add a key/fill/rim setup with the
  3-point preset, or build your own rig: directional, point, or ambient
  lights with color, intensity, position, and aim. Toggle individual
  lights on/off without losing them.
- **Post-FX** — full filmic stack. Bloom (strength, radius, threshold),
  distance blur, barrel distortion + zoom for that lens-feel, color
  grading (contrast, brightness, saturation, temperature, vignette), and
  film grain. Quality preset trades performance for fidelity. Pick a
  preset to start (raw / cinematic / dreamy / etc.) and tweak from
  there. Every knob updates the live preview as you drag.
- **UI** — chat bubble colors (with alpha), bubble roundness, padding,
  font size, chat-bar width, button roundness, accent color. The whole
  app re-themes around the active avatar so different characters can
  feel like different apps.

Everything lives on the avatar, so each character can have its own mood
— a hard-edged sci-fi look for one avatar, soft warm tones for another.

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

Apache License 2.0 — see [LICENSE](./LICENSE).
