import React, { useState } from "react";
import { testGatewayConnection } from "../lib/test-connection.js";

// First-run + edit-anytime gateway connection panel. Two changes vs.
// the original:
//   1. "Test connection" button runs a one-shot probe and reports
//      success/failure inline. Connect is gated on a passing test.
//   2. `mode` prop: "setup" (first run, can't dismiss) vs "edit" (open
//      from settings, has a cancel button).
export default function SetupModal({ initial, onSave, onClose, mode = "setup" }) {
  const [gatewayUrl, setGatewayUrl] = useState(
    initial?.gatewayUrl ?? "ws://127.0.0.1:18789",
  );
  const [sharedSecret, setSharedSecret] = useState(initial?.sharedSecret ?? "");
  const [busy, setBusy] = useState(false);
  // Last test result: null (untested), { ok: true }, or { ok: false, error, kind }.
  const [testResult, setTestResult] = useState(null);
  // Whether the current url/secret has been changed since the last test.
  // We invalidate the test result on edit so users can't pass with one
  // value and save with another.
  const onFieldChange = () => setTestResult(null);

  const runTest = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      // Before the first probe, make sure openclaw's controlUi will
      // accept our origin. The IPC is a no-op if the config is
      // already correct; if it patches anything, the user has to
      // restart the gateway for the change to take effect — which
      // we surface in the failure message below.
      let patchedThisRun = false;
      try {
        const r = await window.exuvia?.openclaw?.ensureAcceptsApp?.();
        patchedThisRun = Boolean(r?.patched);
      } catch {
        /* non-fatal */
      }
      const result = await testGatewayConnection({
        url: gatewayUrl.trim(),
        sharedSecret: sharedSecret.trim(),
      });
      // If the connection was rejected with an origin error AND we
      // just patched the config, we know the gateway hasn't reloaded
      // yet — annotate the result so humanError can suggest a
      // gateway restart.
      if (
        !result.ok &&
        /origin not allowed/i.test(result.error ?? "") &&
        patchedThisRun
      ) {
        result.kind = "origin-needs-restart";
      }
      setTestResult(result);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!testResult?.ok) {
      // Test first if untested. If it passes, we save automatically;
      // if it fails the user can read the error and adjust.
      await runTest();
      return;
    }
    setBusy(true);
    try {
      await onSave({
        gatewayUrl: gatewayUrl.trim(),
        sharedSecret: sharedSecret.trim(),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={mode === "edit" ? onClose : undefined}
    >
      <form
        className="modal"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{mode === "edit" ? "Gateway connection" : "Connect to OpenClaw"}</h2>
        <p className="muted">
          {mode === "edit"
            ? "Update the gateway URL or shared-secret token. The current device token is preserved unless the secret changes."
            : <>Enter the gateway URL and the shared-secret token from your <code>~/.openclaw/openclaw.json</code>. After the first connect, exuvia stores a per-device token and you won't be asked again.</>}
        </p>
        <label>
          <div className="muted">Gateway URL</div>
          <input
            value={gatewayUrl}
            onChange={(e) => {
              setGatewayUrl(e.target.value);
              onFieldChange();
            }}
            placeholder="ws://127.0.0.1:18789"
          />
        </label>
        <label>
          <div className="muted">Shared secret token</div>
          <input
            value={sharedSecret}
            onChange={(e) => {
              setSharedSecret(e.target.value);
              onFieldChange();
            }}
            placeholder="(the gateway.auth token)"
            type="password"
          />
        </label>

        {testResult?.ok && (
          <div className="conn-result conn-result-ok">
            ✓ connection ok — handshake succeeded
          </div>
        )}
        {testResult && !testResult.ok && (
          <div className="conn-result conn-result-err">
            <strong>connection failed:</strong> {humanError(testResult)}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          {mode === "edit" ? (
            <button type="button" onClick={onClose} disabled={busy}>
              cancel
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={runTest}
              disabled={busy || !sharedSecret.trim() || !gatewayUrl.trim()}
            >
              {busy && testResult === null ? "testing…" : "test connection"}
            </button>
            <button
              type="submit"
              disabled={busy || !sharedSecret.trim() || !gatewayUrl.trim()}
              title={
                testResult?.ok
                  ? "save and connect"
                  : "runs a test first; save once it passes"
              }
            >
              {testResult?.ok ? "save & connect" : "test & save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Friendlier error text per failure kind so the user knows what to fix.
function humanError(result) {
  switch (result.kind) {
    case "unreachable":
      return `couldn't reach the gateway. Is openclaw running? (${result.error})`;
    case "rejected":
      return `the gateway rejected the token. Check your shared secret. (${result.error})`;
    case "timeout":
      return "no response from the gateway after 6 seconds.";
    case "origin-needs-restart":
      return "exuvia just updated your openclaw.json so the gateway accepts this app, but the running gateway hasn't picked it up yet. Stop and restart the gateway (run `openclaw gateway` in your terminal), then try again.";
    default:
      // If the raw error mentions origin and we didn't patch this run,
      // the user's config is missing the entries — surface a short
      // hint pointing at the troubleshooting section.
      if (/origin not allowed/i.test(result.error ?? "")) {
        return `${result.error} — restart the openclaw gateway to pick up the latest config.`;
      }
      return result.error || "unknown error";
  }
}
