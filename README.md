# exuvia

A character-first AI assistant. Pick an avatar — 3D model, personality, voice,
animations — and talk to it on the desktop. The same character is reachable on
messaging channels (Telegram, WhatsApp, etc.) via the standard openclaw
multi-channel routing.

The brain is [openclaw](https://docs.openclaw.ai). exuvia adds:

- **`plugin/`** — openclaw plugin: avatar `play_animation` tool, per-avatar
  config sidecar, gateway RPC methods.
- **`app/`** — Electron + React + Three.js desktop app. One window per active
  avatar.

See [`PLAN.md`](./PLAN.md) for the full architecture and build phases.

## Status

Phase 1 scaffold. Plugin loads, tool registers, the desktop app connects to the
gateway and shows chat. No GLB rendering, TTS playback, or avatar creator yet —
those are Phase 2+.

## Prereqs

- Node 22.16+
- pnpm
- A running `openclaw gateway` (see [openclaw onboard](https://docs.openclaw.ai/start/getting-started))

## Install

```bash
# 1. Clone
git clone https://github.com/<yourname>/exuvia
cd exuvia

# 2. Install deps for both packages
pnpm install

# 3. Install the plugin into your gateway
openclaw plugins install --link ./plugin
openclaw gateway restart

# 4. Run the desktop app
pnpm --filter exuvia-app dev:electron
```

On first launch, the app asks for your gateway's shared-secret token (from
`~/.openclaw/openclaw.json`). After that it stores a per-device token and
won't ask again.

## Layout

```
exuvia/
  PLAN.md              architecture + phased build order
  plugin/              openclaw plugin (TypeScript)
  app/                 Electron + React + Three.js desktop app
```

## Distribution

This repo IS the distribution. Users install by cloning and running
`openclaw plugins install --link ./plugin`. There's no npm package required for
the plugin to work — openclaw natively supports git and local-directory
installs. If you ever want one-command install for friends:

```bash
openclaw plugins install git:github.com/<yourname>/exuvia#main
```

works too — openclaw handles fetch + build automatically.
