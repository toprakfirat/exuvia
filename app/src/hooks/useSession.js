import { useEffect, useRef, useState } from "react";

// Minimal one-session-per-avatar binding.
// sessionKey = `agent:<agentId>:main`. We load history and subscribe to live
// session.message events.
//
// onToolCall(payload) is invoked for every session.tool event the gateway
// emits for this session. The consumer decides what to do with each tool —
// e.g. dispatching `play_animation` to the scene.
export function useSession(gateway, sessionKey, onToolCall) {
  const onToolCallRef = useRef(onToolCall);
  useEffect(() => {
    onToolCallRef.current = onToolCall;
  }, [onToolCall]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (gateway.status !== "connected" || !sessionKey) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    // Field-name conventions (drove me crazy when I first hit them):
    //   chat.* methods       → param is `sessionKey`
    //   sessions.* methods   → param is `key`
    // Same logical id, different protocol namespaces.
    (async () => {
      try {
        const history = await gateway.request("chat.history", { sessionKey });
        if (cancelled) return;
        const rows = history?.messages ?? history?.rows ?? [];
        setMessages(Array.isArray(rows) ? rows : []);
      } catch (err) {
        if (!cancelled) setError(err.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    let unsubMsg;
    let unsubTool;
    (async () => {
      try {
        await gateway.request("sessions.messages.subscribe", { key: sessionKey });
        // sessions.subscribe is a separate registry: it controls whether
        // this connection receives session-scoped events like
        // `session.tool` (tool start/update/end frames). Without it the
        // gateway sends `session.message` only, the play_animation tool
        // call lands silently in the transcript, and the scene never
        // animates. Mirrored unsubscribe lives in the cleanup return.
        await gateway.request("sessions.subscribe", {}).catch((err) => {
          // Don't fail the whole effect if the events channel isn't
          // available — chat still works without animations.
          console.warn("[session] sessions.subscribe failed:", err);
        });
      } catch (err) {
        if (!cancelled) setError(err.message ?? String(err));
      }
      // Two event families carry assistant content:
      //   session.message — transcript stream from the session subscription
      //   chat            — display-shaped chat updates (chat.history-style rows)
      // Real gateways emit both for the same turn. We listen to both and
      // dedupe via mergeMessage's id-or-content comparison.
      const handleMsgEvent = (payload) => {
        const evKey = payload?.sessionKey ?? payload?.key;
        if (evKey && evKey !== sessionKey) return;
        // Some chat events are envelopes — { messages: [...] } or
        // { message: {...} }. Normalize.
        const msg =
          payload?.message ??
          (Array.isArray(payload?.messages) ? payload.messages.at(-1) : null) ??
          payload;
        if (!msg) return;
        setMessages((prev) => mergeMessage(prev, msg));
      };

      unsubMsg = gateway.on("session.message", handleMsgEvent);
      const unsubChat = gateway.on("chat", handleMsgEvent);

      // The gateway emits `session.tool` as a wrapped agent event:
      //   { runId, stream: "tool", sessionKey, data: { phase, name,
      //     toolCallId, args, partialResult?, result? } }
      // Older code expected flat `toolName`/`params` on the payload; we
      // also keep top-level fallbacks so it still works on hosts that
      // emit a flatter shape. Fire onToolCall only on the START phase
      // — end/update repeat the call info and would re-trigger the
      // animation. The transcript-side tool row is appended on END so
      // it shows only once per tool call.
      unsubTool = gateway.on("session.tool", (payload) => {
        const evKey = payload?.sessionKey ?? payload?.key;
        if (evKey && evKey !== sessionKey) return;
        const data = payload?.data ?? payload ?? {};
        const phase = data.phase ?? payload?.phase ?? null;
        const toolName = data.name ?? payload?.toolName ?? payload?.name;
        const toolArgs = data.args ?? payload?.params ?? payload?.args ?? {};
        const toolCallId = data.toolCallId ?? payload?.toolCallId ?? null;

        // Normalize for the consumer so App.handleToolCall can stay simple.
        const normalized = {
          ...payload,
          toolName,
          name: toolName,
          args: toolArgs,
          params: toolArgs,
          toolCallId,
          phase,
        };

        if (phase === "start" || phase == null) {
          try {
            onToolCallRef.current?.(normalized);
          } catch (err) {
            console.error("[session] onToolCall threw", err);
          }
        }
        if (phase === "end") {
          setMessages((prev) => [
            ...prev,
            {
              role: "tool",
              content: `[tool] ${toolName ?? "?"}(${JSON.stringify(toolArgs)})`,
              _toolEvent: payload,
            },
          ]);
        }
      });

      // Combine unsubs: useEffect cleanup will run unsubMsg + unsubTool.
      // unsubChat is wrapped into unsubMsg below so a single ref unhooks both.
      const origUnsubMsg = unsubMsg;
      unsubMsg = () => {
        try { origUnsubMsg?.(); } catch {}
        try { unsubChat?.(); } catch {}
      };
    })();

    return () => {
      cancelled = true;
      unsubMsg?.();
      unsubTool?.();
      gateway
        .request("sessions.messages.unsubscribe", { key: sessionKey })
        .catch(() => {});
      gateway
        .request("sessions.unsubscribe", {})
        .catch(() => {});
    };
  }, [gateway.status, sessionKey]);

  const send = async (text) => {
    if (!sessionKey || !text.trim()) return;
    // chat.send wants { sessionKey, message, idempotencyKey } per the schema.
    // idempotencyKey is required even for fresh sends.
    await gateway.request("chat.send", {
      sessionKey,
      message: text,
      idempotencyKey:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  };

  return { messages, loading, error, send };
}

function pickId(m) {
  return m?.id ?? m?.messageId ?? m?.message?.id ?? m?.message?.messageId ?? null;
}

function pickRole(m) {
  return m?.role ?? m?.message?.role ?? null;
}

function pickContentText(m) {
  const c = m?.content ?? m?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("");
  }
  if (typeof m?.text === "string") return m.text;
  return "";
}

function mergeMessage(prev, msg) {
  if (!msg) return prev;
  const id = pickId(msg);

  // (1) Merge-by-id when we have one AND the same id is already in
  // the list. Streaming chunks for the same logical message often
  // share an id; this merges them without duplicating.
  if (id) {
    const idx = prev.findIndex((m) => pickId(m) === id);
    if (idx >= 0) {
      const next = prev.slice();
      next[idx] = { ...prev[idx], ...msg };
      return next;
    }
  }

  // (2) Streaming continuation: the gateway emits the same logical
  // message twice across two event families (session.message + chat),
  // and earlier emissions may not carry an id while later ones do.
  // Two cases to dedupe:
  //   a. Strict prefix continuation against the IMMEDIATELY-previous
  //      message of the same role (streaming chunks growing).
  //   b. Exact text match against any of the last 3 same-role rows
  //      (the cross-family duplicate emission, which may have a tool
  //      row or other event interleaved between the two copies).
  const role = pickRole(msg);
  const text = pickContentText(msg);
  if (role && text && prev.length > 0) {
    // Case (a) — only checked against the very last row.
    const last = prev[prev.length - 1];
    if (pickRole(last) === role) {
      const lastText = pickContentText(last);
      if (
        lastText &&
        text.length > lastText.length &&
        text.startsWith(lastText)
      ) {
        const next = prev.slice();
        next[prev.length - 1] = { ...last, ...msg };
        return next;
      }
    }
    // Case (b) — exact text match scan over the recent same-role rows.
    const scanFrom = Math.max(0, prev.length - 3);
    for (let i = prev.length - 1; i >= scanFrom; i--) {
      const candidate = prev[i];
      if (pickRole(candidate) !== role) continue;
      if (pickContentText(candidate) === text) {
        const next = prev.slice();
        next[i] = { ...candidate, ...msg };
        return next;
      }
    }
  }
  return [...prev, msg];
}
