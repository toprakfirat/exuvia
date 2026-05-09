# exuvia-app

Electron + React + Three.js desktop app for exuvia.

## Status — Phase 1

- Connects to a local `openclaw gateway` over WebSocket.
- Shared-secret first-time setup; device token persisted in Electron `safeStorage`.
- Lists agents from `agents.list`.
- Shows live chat for the selected agent (`agent:<id>:main`).
- Tool calls (e.g. `play_animation`) appear in the chat as plain markers.

**Not yet:** GLB rendering, TTS playback, animation playback, avatar creator.
Those are Phase 2+.

## Run

From the repo root:

```bash
pnpm install
pnpm --filter exuvia-app dev:electron
```

That starts Vite at `http://localhost:5173` and opens the Electron window
pointed at it.

For browser-only dev (no Electron, no native token storage):

```bash
pnpm --filter exuvia-app dev
```

## First launch

The app prompts for:

- **Gateway URL** — defaults to `ws://127.0.0.1:18789`.
- **Shared secret** — the `gateway.auth.token` from your
  `~/.openclaw/openclaw.json`.

After the first successful connect, the gateway issues a per-device token. The
app stores it via `safeStorage` and reuses it for subsequent connects.

## Files

```
electron-main.cjs   # main process, IPC, safeStorage
preload.cjs         # bridges window.exuvia.* into renderer
src/
  main.jsx
  App.jsx
  styles.css
  lib/
    gateway-client.js   # protocol v4 client (handshake, request, events)
  hooks/
    useGateway.js       # connection lifecycle hook
    useSession.js       # one-session-per-avatar message stream
  components/
    AgentPicker.jsx
    ChatView.jsx
    SetupModal.jsx
```
