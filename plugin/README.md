# exuvia-plugin

OpenClaw plugin for the exuvia character-first assistant.

## What it does

- Registers a `play_animation` tool the LLM can call. The tool's description
  includes the active avatar's animation catalogue (names + tags +
  descriptions). When a clip has a `gifPath` configured, the tool result
  attaches it via the `MEDIA:` directive so chat channels (Telegram, WhatsApp,
  Discord, etc.) deliver the gif inline.
- Registers a `message_sending` hook that — when an avatar opts in via
  `voiceOnChannels: true` — generates a TTS voice note for each outbound
  message on chat channels and attaches it via `[[audio_as_voice]]` + `MEDIA:`.
  Off by default. Desktop voice always plays regardless.
- Registers `plugin.exuvia.getAvatar` and `plugin.exuvia.listAvatars` gateway
  RPC methods so the desktop app can read per-avatar config.
- Registers a `before_prompt_build` hook (no-op today; reserved for per-channel
  tone tweaks later).

Personality is **not** injected from this plugin — it lives in each agent's
workspace `AGENTS.md` / `SOUL.md`, which OpenClaw loads natively.

## Install

The plugin lives inside the [exuvia](https://github.com/) repo. To install
into your gateway:

```bash
# Easiest: tell openclaw to fetch + install from git
openclaw plugins install git:github.com/<yourname>/exuvia#main

# Or clone + install from the local checkout (great for editing)
git clone https://github.com/<yourname>/exuvia
openclaw plugins install --link ./exuvia/plugin

# Then restart the gateway so the new plugin loads
openclaw gateway restart
```

`--link` symlinks the plugin so edits + rebuilds are picked up without
reinstalling.

## Build (only needed for local dev installs)

```bash
pnpm install
pnpm --filter @exuvia/openclaw-plugin build
```

The `prepare` npm script also runs `tsc` automatically, so install paths
that run install scripts (like `openclaw plugins install ./plugin`) build
the `dist/` output for you.

`openclaw` is a devDependency only — it provides the SDK types during local
development. The published plugin loads the SDK from the gateway runtime at
plugin-load time.

## Verify

After install + restart:

```bash
openclaw plugins list --enabled | grep exuvia
openclaw plugins inspect exuvia --runtime --json
openclaw tools list | grep play_animation
```

You should see the plugin listed, the tool registered with
`source=plugin pluginId=exuvia`, and the two `plugin.exuvia.*` gateway methods.

Send a message asking the active agent to call `play_animation` with a name
from its catalogue. The plugin logs `[exuvia] play_animation fired:` and the
tool result `(played <name>)` lands in the transcript.

## Config shape

Under `plugins.entries.exuvia.config` in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      exuvia: {
        config: {
          avatars: {
            "nova": {
              fbxPath: "~/.openclaw/workspace-nova/avatar.fbx",
              fbxScale: 0.01,
              voiceOnChannels: false,
              animations: [
                {
                  name: "wave_once",
                  description: "Friendly greeting wave.",
                  tags: ["greeting"],
                  loop: false,
                  durationMs: 1800,
                  gifPath: "~/.openclaw/workspace-nova/gifs/wave_once.gif"
                },
                {
                  name: "thinking_loop",
                  description: "Hand to chin, looped.",
                  tags: ["thinking"],
                  loop: true,
                  durationMs: 2000
                }
              ]
            }
          }
        }
      }
    }
  }
}
```

The exuvia desktop app's avatar creator wizard writes this section for you;
you don't normally edit it by hand.

## Per-animation clip videos (chat channel delivery)

When the LLM calls `play_animation`, the avatar performs the clip live in the
desktop app. On chat channels (Telegram, Discord, WhatsApp, iMessage, etc.)
there's no 3D scene — so we attach a pre-rendered short video of the same
clip via the `MEDIA:` directive.

The exuvia desktop app **bakes these clips automatically** during the avatar
creator wizard, by rendering the FBX on an offscreen Three.js canvas and
recording with the browser's `MediaRecorder` API into webm. There is no
separate gif tooling — the user only ever uploads the FBX. The settings
panel offers a **Re-bake all clips** button to refresh them later (e.g.
after FBX scale tuning).

Power users can override `animations[].gifPath` in config to point at any
file they like (gif, webp, mp4, webm). Channel adapters that don't support
media (or don't recognize the format) strip the attachment gracefully — the
text reply still goes through.

## Voice notes on channels

Set `voiceOnChannels: true` per-avatar to have the plugin's `message_sending`
hook generate a TTS audio file for every outbound chat-channel reply. The
hook calls `api.runtime.tts.textToSpeech` with the active TTS provider
(configured under `messages.tts` or per-agent at `agents.list[].tts`) and
attaches the result with `[[audio_as_voice]]`.

The desktop app always plays voice locally regardless of this flag — this
toggle is purely about whether messaging surfaces also receive audio.
