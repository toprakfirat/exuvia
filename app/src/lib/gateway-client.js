// Minimal browser-side WebSocket client for the OpenClaw gateway protocol v4.
// Handles: connect.challenge → connect → hello-ok handshake, request/response,
// event subscribe/dispatch, simple reconnect with backoff.
//
// We use the shared-secret token path. Loopback connects auto-pair so no device
// signing flow is required for v1. See:
//   docs/gateway/protocol.md
//   docs/gateway/authentication.md
//   src/gateway/client.ts (reference impl in the openclaw repo)

// Matches openclaw 2026.5.7's runtime PROTOCOL_VERSION = 3. The docs I read
// during scaffolding showed v4 (a forward-looking spec); the actual shipped
// build runs v3. Update if/when we upgrade openclaw.
const PROTOCOL_VERSION = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class GatewayClient {
  constructor(opts) {
    this.url = opts.url;
    this.token = opts.token ?? null;
    this.deviceToken = opts.deviceToken ?? null;
    this.role = opts.role ?? "operator";
    this.scopes = opts.scopes ?? ["operator.read", "operator.write"];
    this.onDeviceToken = opts.onDeviceToken ?? null;
    this.onStatus = opts.onStatus ?? null;
    this.onEvent = opts.onEvent ?? null;
    this.onError = opts.onError ?? null;

    this.ws = null;
    this.connected = false;
    this.helloReceived = false;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventListeners = new Map(); // event name -> Set<handler>
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.shouldReconnect = true;
    this.connectChallengeNonce = null;
  }

  setStatus(status, detail) {
    this.onStatus?.(status, detail ?? null);
  }

  on(eventName, handler) {
    let set = this.eventListeners.get(eventName);
    if (!set) {
      set = new Set();
      this.eventListeners.set(eventName, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  connect() {
    this.shouldReconnect = true;
    this.openSocket();
  }

  close() {
    this.shouldReconnect = false;
    if (this.ws) {
      try {
        this.ws.close(1000, "client closing");
      } catch {
        /* ignore */
      }
    }
  }

  openSocket() {
    this.helloReceived = false;
    this.connectChallengeNonce = null;
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.onError?.(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      // Wait for connect.challenge before sending the connect request.
    });

    ws.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch (err) {
        this.onError?.(new Error("non-JSON frame from gateway"));
        return;
      }
      this.handleFrame(frame);
    });

    ws.addEventListener("error", (ev) => {
      this.onError?.(ev?.error ?? new Error("websocket error"));
    });

    ws.addEventListener("close", (ev) => {
      this.connected = false;
      this.helloReceived = false;
      // 1012 = gateway service restart (plugin reload, config apply, etc.).
      // 1001 = going away, 1000 = normal. Treat all three as "reconnect
      // soon, no need to alarm the user."
      const recoverable = ev.code === 1012 || ev.code === 1001 || ev.code === 1000;
      this.setStatus(recoverable ? "reconnecting" : "disconnected", {
        code: ev.code,
        reason: ev.reason,
      });
      this.failPending(
        new Error(
          recoverable
            ? "gateway restarting — try again in a moment"
            : `socket closed (${ev.code})`,
        ),
      );
      if (this.shouldReconnect) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.shouldReconnect) this.openSocket();
    }, delay);
  }

  failPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  handleFrame(frame) {
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        this.connectChallengeNonce = frame.payload?.nonce ?? null;
        this.sendConnect();
        return;
      }
      this.dispatchEvent(frame.event, frame.payload);
      return;
    }
    if (frame.type === "res") {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(this.buildError(frame.error));
      return;
    }
  }

  buildError(err) {
    const e = new Error(err?.message ?? "gateway request failed");
    e.code = err?.code;
    e.details = err?.details;
    return e;
  }

  dispatchEvent(name, payload) {
    // Firehose log so we can see exactly which event names the gateway emits.
    // Strip later once stable.
    if (name !== "tick" && name !== "heartbeat") {
      console.log(`[ws-event] ${name}`, payload);
    }
    this.onEvent?.(name, payload);
    const set = this.eventListeners.get(name);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        this.onError?.(err);
      }
    }
  }

  sendConnect() {
    const id = randomId();
    const auth = {};
    // Prefer device token if we already have one. Fall back to shared secret.
    if (this.deviceToken) auth.token = this.deviceToken;
    else if (this.token) auth.token = this.token;

    // The gateway protocol enforces a closed enum on client.id and client.mode.
    // We identify as openclaw-control-ui / ui — functionally we're a Control
    // UI variant. The renderer is served over http://127.0.0.1:<port> by
    // our embedded static server (electron-main.cjs), so the WS handshake
    // ships a loopback Origin and passes the gateway's origin check.
    // displayName surfaces our actual identity in the gateway's presence list.
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        displayName: "exuvia",
        version: "0.0.0",
        platform: "electron",
        mode: "ui",
      },
      role: this.role,
      scopes: this.scopes,
      auth,
      locale: navigator?.language ?? "en-US",
      userAgent: "exuvia-app/0.0.0",
    };

    const handler = (frame) => {
      if (frame?.type !== "res" || frame?.id !== id) return;
      if (!frame.ok) {
        this.onError?.(this.buildError(frame.error));
        return;
      }
      const helloOk = frame.payload;
      if (helloOk?.type !== "hello-ok") {
        this.onError?.(new Error("unexpected connect response"));
        return;
      }
      this.helloReceived = true;
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      const newDeviceToken = helloOk.auth?.deviceToken;
      if (newDeviceToken && newDeviceToken !== this.deviceToken) {
        this.deviceToken = newDeviceToken;
        this.onDeviceToken?.(newDeviceToken);
      }
      this.setStatus("connected", helloOk);
    };

    // The connect response goes through handleFrame's normal pending pipeline,
    // but we also want to pull out the hello-ok payload. Wire it via a one-shot
    // listener stuffed into `pending` directly.
    this.pending.set(id, {
      resolve: (payload) =>
        handler({ type: "res", id, ok: true, payload }),
      reject: (err) => this.onError?.(err),
      timer: setTimeout(() => {
        this.pending.delete(id);
        this.onError?.(new Error("connect timeout"));
      }, REQUEST_TIMEOUT_MS),
    });

    this.ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
  }

  request(method, params) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
    });
  }

  // Convenience wrapper for config.patch — the gateway expects a `raw` string
  // containing a partial config blob. Callers pass a structured JS object
  // and we serialize it.
  //
  // The gateway enforces optimistic concurrency: it requires `baseHash` (the
  // hash of the config snapshot we're patching from). We do the read-then-
  // patch dance here so callers don't have to.
  async configPatch(partial, opts = {}) {
    const cfg = await this.request("config.get", {});
    const baseHash = cfg?.hash ?? cfg?.config?.hash ?? cfg?.snapshot?.hash;
    return this.request("config.patch", {
      raw: JSON.stringify(partial),
      baseHash,
      ...opts,
    });
  }
}
