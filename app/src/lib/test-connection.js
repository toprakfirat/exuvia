import { GatewayClient } from "./gateway-client.js";

// One-shot connection probe. Used by SetupModal and the connection-tab
// in the picker to verify the user's gatewayUrl + sharedSecret before
// committing them to settings. Returns { ok, detail } on success, or
// { ok: false, error, kind } on failure where kind is one of:
//   "unreachable"  — couldn't even open the socket (server down, wrong port)
//   "rejected"     — socket opened but handshake failed (wrong token)
//   "timeout"      — connection didn't complete in time
//   "other"        — something else (parse error, etc.)
//
// Caller passes `{ url, sharedSecret }`. We open a fresh GatewayClient
// (no auto-reconnect, no scope state preserved), wait for the
// "connected" or "error" status, then close. Total budget ~6s.
export async function testGatewayConnection({
  url,
  sharedSecret,
  timeoutMs = 6000,
}) {
  if (!url || !sharedSecret) {
    return { ok: false, error: "url and sharedSecret are required", kind: "other" };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: "connection timed out", kind: "timeout" }),
      timeoutMs,
    );

    let lastError = null;
    const client = new GatewayClient({
      url,
      token: sharedSecret,
      deviceToken: null,
      // Just enough scopes to verify the token works. We don't need
      // operator.admin for a connection test.
      scopes: ["operator.read"],
      onStatus: (s, detail) => {
        if (s === "connected") {
          clearTimeout(timer);
          finish({ ok: true, detail });
        }
        if (s === "disconnected" || s === "error") {
          clearTimeout(timer);
          // Map best-guess from the last error string.
          const msg = lastError ?? "connection closed before handshake";
          const lower = msg.toLowerCase();
          let kind = "other";
          if (
            /econnrefused|enotfound|etimedout|net::|failed to fetch|connection (refused|reset)/i.test(
              lower,
            )
          ) {
            kind = "unreachable";
          } else if (
            /unauthorized|invalid token|forbidden|auth(?:enticat)?/i.test(lower)
          ) {
            kind = "rejected";
          }
          finish({ ok: false, error: msg, kind });
        }
      },
      onError: (err) => {
        lastError = err?.message ?? String(err);
      },
    });

    try {
      client.connect();
    } catch (err) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: String(err?.message ?? err),
        kind: "other",
      });
    }

    // Disable auto-reconnect: a test should fail fast, not loop.
    client.shouldReconnect = false;
  });
}
