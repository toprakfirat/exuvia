// One-shot WS chat probe. Connects to the local gateway, sends a single
// chat.send to agent:untitled:main, waits for the run to complete, prints
// what came back. Disposable diagnostic — pair with proxy-ollama.mjs to
// see what hit the model.
import { randomUUID } from "node:crypto";

const TOKEN = "184f797fc31814fcdceb20148212fb55d7346c4e0c1b2a51";
const URL = "ws://127.0.0.1:18789/ws";
const SESSION_KEY = "agent:untitled:main";
const TEXT = process.argv[2] ?? "test";

const ws = new WebSocket(URL);

const pending = new Map();
function req(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

ws.addEventListener("open", async () => {
  // hello
  ws.send(
    JSON.stringify({
      type: "req",
      id: "hello",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "probe",
          version: "0.0.0",
          platform: "node",
          mode: "cli",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        auth: { token: TOKEN },
      },
    }),
  );
});

let helloOk = false;
let assistantText = "";

ws.addEventListener("message", (ev) => {
  const frame = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
  if (frame.type === "res" && frame.id === "hello") {
    if (!frame.ok) {
      console.error("hello failed:", frame.error);
      ws.close();
      process.exit(1);
    }
    helloOk = true;
    afterHello();
    return;
  }
  if (frame.type === "res" && pending.has(frame.id)) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.payload);
    else p.reject(new Error(JSON.stringify(frame.error)));
    return;
  }
  if (frame.type === "event") {
    const e = frame.event ?? frame.name;
    const payload = frame.payload ?? frame.data;
    if (e === "session.message" || e === "chat") {
      const m = payload?.message ?? payload;
      if (m?.role === "assistant" && typeof m.content === "string") {
        assistantText = m.content;
      }
      const status = m?.status ?? m?.state;
      const phase = payload?.phase ?? payload?.lifecycle;
      if (status === "complete" || status === "completed" || phase === "end") {
        console.log("\n=== assistant reply ===");
        console.log(assistantText);
        ws.close();
        process.exit(0);
      }
    }
    if (e === "agent" && payload?.stream === "lifecycle" && payload?.phase === "end") {
      // also a terminal signal
      setTimeout(() => {
        console.log("\n=== assistant reply (lifecycle end) ===");
        console.log(assistantText);
        ws.close();
        process.exit(0);
      }, 500);
    }
  }
});

async function afterHello() {
  try {
    await req("sessions.messages.subscribe", { key: SESSION_KEY });
    await req("chat.send", {
      sessionKey: SESSION_KEY,
      message: TEXT,
      idempotencyKey: randomUUID(),
    });
    setTimeout(() => {
      console.error("timeout after 60s without terminal event");
      console.log("\n=== last assistant text ===\n" + assistantText);
      ws.close();
      process.exit(2);
    }, 60_000);
  } catch (e) {
    console.error("send failed:", e.message);
    ws.close();
    process.exit(1);
  }
}

ws.addEventListener("error", (e) => {
  console.error("ws error:", e.message ?? e);
});
