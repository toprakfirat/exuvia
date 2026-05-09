import React, { useState } from "react";

export default function SetupModal({ initial, onSave }) {
  const [gatewayUrl, setGatewayUrl] = useState(
    initial?.gatewayUrl ?? "ws://127.0.0.1:18789",
  );
  const [sharedSecret, setSharedSecret] = useState(initial?.sharedSecret ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ gatewayUrl, sharedSecret });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>Connect to OpenClaw</h2>
        <p className="muted">
          Enter the gateway URL and the shared-secret token from your{" "}
          <code>~/.openclaw/openclaw.json</code>. After the first connect, exuvia
          stores a per-device token and you won't be asked again.
        </p>
        <label>
          <div className="muted">Gateway URL</div>
          <input
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
            placeholder="ws://127.0.0.1:18789"
          />
        </label>
        <label>
          <div className="muted">Shared secret token</div>
          <input
            value={sharedSecret}
            onChange={(e) => setSharedSecret(e.target.value)}
            placeholder="(the gateway.auth token)"
            type="password"
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="submit" disabled={busy || !sharedSecret}>
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
