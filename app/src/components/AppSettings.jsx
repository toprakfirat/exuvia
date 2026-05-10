import React, { useCallback, useEffect, useState } from "react";

// App-wide settings modal. Holds settings that aren't per-avatar:
// transcription provider for voice input, push-to-talk hotkey, and the
// system-wide show/hide window hotkey. Each panel persists on its own
// save (no global save button) so the modal can be closed at any time
// without losing partial edits.
const TABS = [
  { id: "voice-input", label: "Voice input" },
  { id: "hotkeys", label: "Hotkeys" },
];

export default function AppSettings({ gateway, onClose }) {
  const [tab, setTab] = useState("voice-input");

  // Escape key closes the modal — same convention as AvatarSettings.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal app-settings"
        onClick={(e) => e.stopPropagation()}
        style={{ minWidth: 480, maxWidth: 640 }}
      >
        <div className="settings-header">
          <button
            onClick={onClose}
            style={{ padding: "4px 10px", fontSize: 11 }}
          >
            ← close
          </button>
          <h2 style={{ margin: 0 }}>App settings</h2>
          <span style={{ width: 60 }} />
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-panel">
          {tab === "voice-input" && <VoiceInputSetup gateway={gateway} />}
          {tab === "hotkeys" && (
            <>
              <div className="section-title">Push-to-talk</div>
              <PushToTalkBinder />
              <div className="section-title">Show / hide window</div>
              <ToggleWindowBinder />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── voice-input provider ─────────────────────────────────────────────

const VOICE_PROVIDERS = [
  {
    id: "groq",
    label: "Groq Whisper",
    model: "groq/whisper-large-v3-turbo",
    blurb: "free tier covers most personal use",
    keyHint: "gsk_…",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "openai",
    label: "OpenAI Whisper",
    model: "openai/whisper-1",
    blurb: "$0.006/min · needs billing set up",
    keyHint: "sk_…",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepgram",
    label: "Deepgram Nova",
    model: "deepgram/nova-3",
    blurb: "$200 free credits, then $0.0043/min",
    keyHint: "dgkey_…",
    docsUrl: "https://console.deepgram.com",
  },
];

export function VoiceInputSetup({ gateway }) {
  const [providerId, setProviderId] = useState("groq");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.exuvia?.openclaw?.audioProviders?.();
      if (!res?.ok) {
        setError(res?.error ?? "could not query providers");
        setStatus(null);
        return;
      }
      setStatus(res.providers ?? []);
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const provider = VOICE_PROVIDERS.find((p) => p.id === providerId);
  const live = Array.isArray(status)
    ? status.find((s) => s?.id === providerId)
    : null;

  const save = async () => {
    if (!provider || !apiKey.trim()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const authRes = await window.exuvia?.openclaw?.authSet?.({
        provider: provider.id,
        apiKey: apiKey.trim(),
      });
      if (!authRes?.ok) {
        setError(authRes?.error ?? "auth set failed");
        return;
      }
      try {
        await gateway.configPatch({
          tools: { media: { audio: { models: [provider.model] } } },
        });
      } catch (err) {
        const msg = String(err?.message ?? err);
        const recoverable =
          /gateway restarting/i.test(msg) ||
          /socket closed/i.test(msg) ||
          /not connected/i.test(msg);
        if (!recoverable) throw err;
      }
      setApiKey("");
      setSuccess(`saved ${provider.label}`);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        Voice input transcribes mic audio via an external provider.
        Configure one provider here and the mic button in chat will work.
      </span>

      <div className="row" style={{ flexWrap: "wrap" }}>
        {VOICE_PROVIDERS.map((p) => {
          const liveP = Array.isArray(status)
            ? status.find((s) => s?.id === p.id)
            : null;
          const dotColor = liveP?.selected
            ? "#6ce28b"
            : liveP?.configured
              ? "#e2c66c"
              : "rgba(255,255,255,0.25)";
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => setProviderId(p.id)}
              className={providerId === p.id ? "active" : ""}
              style={{
                padding: "6px 10px",
                fontSize: 11,
                background:
                  providerId === p.id ? "rgba(255,255,255,0.12)" : undefined,
                border:
                  providerId === p.id
                    ? "1px solid var(--border-glass-strong)"
                    : "1px solid var(--border-glass)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: dotColor,
                }}
              />
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          style={{ padding: "6px 10px", fontSize: 11, marginLeft: "auto" }}
          title="re-check provider status"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {provider && (
        <>
          <span className="muted" style={{ fontSize: 11 }}>
            {provider.blurb}.{" "}
            <a
              href={provider.docsUrl}
              onClick={(e) => {
                e.preventDefault();
                window.exuvia?.openExternal?.(provider.docsUrl);
              }}
              style={{ color: "rgba(150,180,255,0.85)" }}
            >
              get an API key →
            </a>
          </span>

          <div className="field">
            <label>API key{live?.configured ? " (already configured)" : ""}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={live?.configured ? "(leave blank to keep current)" : provider.keyHint}
            />
          </div>

          <div className="row">
            <button
              type="button"
              onClick={save}
              disabled={busy || !apiKey.trim()}
            >
              {busy ? "saving…" : live?.selected ? "update key" : "save & select"}
            </button>
            {live?.selected && (
              <span className="muted" style={{ fontSize: 11 }}>
                ✓ configured and selected
              </span>
            )}
            {live?.configured && !live?.selected && (
              <span className="muted" style={{ fontSize: 11 }}>
                key set, but not the active model
              </span>
            )}
          </div>

          {error && (
            <span style={{ color: "#ff7878", fontSize: 11 }}>{error}</span>
          )}
          {success && (
            <span style={{ color: "rgba(108,226,139,0.9)", fontSize: 11 }}>
              {success}
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ─── push-to-talk binder ──────────────────────────────────────────────

export function PushToTalkBinder() {
  const [code, setCode] = useState("Space");
  const [binding, setBinding] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.exuvia?.settings?.get?.();
        if (!cancelled && typeof cfg?.voiceHotkey === "string") {
          setCode(cfg.voiceHotkey);
        }
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next) => {
    setSaving(true);
    try {
      await window.exuvia?.settings?.set?.({ voiceHotkey: next });
      setCode(next);
      window.dispatchEvent(new CustomEvent("exuvia:voice-hotkey", { detail: next }));
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (!binding) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setBinding(false);
      persist(e.code);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [binding, persist]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        Hold this key (when no text field is focused) to record while it's
        pressed; release to send. Esc cancels mid-record.
      </span>
      <div className="row" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 11 }}>
          current:{" "}
          <strong style={{ fontFamily: "ui-monospace, monospace" }}>
            {code ? friendlyKeyCode(code) : "(disabled)"}
          </strong>
        </span>
        {!binding ? (
          <button
            type="button"
            onClick={() => setBinding(true)}
            disabled={saving}
            style={{ padding: "4px 10px", fontSize: 11 }}
          >
            rebind
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            press any key…{" "}
            <button
              type="button"
              onClick={() => setBinding(false)}
              style={{ padding: "2px 8px", fontSize: 10 }}
            >
              cancel
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => persist("")}
          disabled={saving || !code}
          style={{ padding: "4px 10px", fontSize: 11, marginLeft: "auto" }}
          title="disable push-to-talk; the mic button still works"
        >
          disable
        </button>
        <button
          type="button"
          onClick={() => persist("Space")}
          disabled={saving || code === "Space"}
          style={{ padding: "4px 10px", fontSize: 11 }}
          title="restore the default Space binding"
        >
          reset
        </button>
      </div>
    </div>
  );
}

function friendlyKeyCode(code) {
  if (!code) return "";
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

// ─── show/hide window binder (global) ─────────────────────────────────

export function ToggleWindowBinder() {
  const [accelerator, setAccelerator] = useState("");
  const [binding, setBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.exuvia?.hotkey?.getToggle?.();
        if (!cancelled) setAccelerator(res?.accelerator ?? "");
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.exuvia?.hotkey?.setToggle?.(next);
      if (res?.ok) {
        setAccelerator(res.accelerator ?? next);
      } else {
        setError(res?.error ?? "could not register hotkey");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!binding) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setBinding(false);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Meta");
      const main = keyToAccelerator(e);
      if (!main) return;
      parts.push(main);
      setBinding(false);
      persist(parts.join("+"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [binding, persist]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        System-wide combo: pressing this from any app shows or hides the
        exuvia window. Pick something with modifiers (Ctrl+Shift+E) so it
        doesn't conflict with normal typing.
      </span>
      <div className="row" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 11 }}>
          current:{" "}
          <strong style={{ fontFamily: "ui-monospace, monospace" }}>
            {accelerator || "(disabled)"}
          </strong>
        </span>
        {!binding ? (
          <button
            type="button"
            onClick={() => setBinding(true)}
            disabled={busy}
            style={{ padding: "4px 10px", fontSize: 11 }}
          >
            rebind
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            press a combo…{" "}
            <button
              type="button"
              onClick={() => setBinding(false)}
              style={{ padding: "2px 8px", fontSize: 10 }}
            >
              cancel
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => persist("")}
          disabled={busy || !accelerator}
          style={{ padding: "4px 10px", fontSize: 11, marginLeft: "auto" }}
          title="disable the global hotkey; tray icon still works"
        >
          disable
        </button>
      </div>
      {error && (
        <span style={{ color: "#ff7878", fontSize: 11 }}>{error}</span>
      )}
    </div>
  );
}

// Tray icon picker. Lets the user override the bundled icon with a
// PNG (or ICO) of their choice. We copy the source bytes into
// userData/tray-icon.png so the user can delete the original file
// safely — the in-app store keeps a copy. Reset removes the override
// and falls back to whatever ships in app/public/tray-icon.png.
export function TrayIconBinder() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.exuvia?.tray?.getIconInfo?.();
      setInfo(res ?? null);
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const choose = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await window.exuvia?.dialog?.openFile?.({
        title: "Pick a tray icon",
        filters: [
          { name: "Images", extensions: ["png", "ico", "jpg", "jpeg", "webp"] },
        ],
      });
      if (!picked) return;
      const res = await window.exuvia?.tray?.setIcon?.(picked);
      if (!res?.ok) {
        setError(res?.error ?? "could not set tray icon");
        return;
      }
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.exuvia?.tray?.resetIcon?.();
      if (!res?.ok) {
        setError(res?.error ?? "could not reset tray icon");
        return;
      }
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        The tray icon shown in your system tray. PNG works best
        (transparent background, 32×32 or 64×64).
      </span>
      <div className="row" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 11 }}>
          source:{" "}
          <strong
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}
            title={info?.resolvedPath ?? ""}
          >
            {info?.isCustom
              ? "(custom)"
              : info?.resolvedPath
                ? "(bundled)"
                : "(placeholder)"}
          </strong>
        </span>
        <button
          type="button"
          onClick={choose}
          disabled={busy}
          style={{ padding: "4px 10px", fontSize: 11 }}
        >
          change…
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || !info?.isCustom}
          style={{ padding: "4px 10px", fontSize: 11, marginLeft: "auto" }}
          title="restore the bundled icon"
        >
          reset
        </button>
      </div>
      {error && (
        <span style={{ color: "#ff7878", fontSize: 11 }}>{error}</span>
      )}
    </div>
  );
}

function keyToAccelerator(e) {
  if (e.code?.startsWith("Key")) return e.code.slice(3);
  if (e.code?.startsWith("Digit")) return e.code.slice(5);
  if (e.code?.startsWith("Numpad")) return `num${e.code.slice(6).toLowerCase()}`;
  if (e.code === "Space") return "Space";
  if (e.code === "Tab") return "Tab";
  if (e.code === "Enter") return "Return";
  if (e.code === "Backspace") return "Backspace";
  if (e.code === "Delete") return "Delete";
  if (e.code === "ArrowUp") return "Up";
  if (e.code === "ArrowDown") return "Down";
  if (e.code === "ArrowLeft") return "Left";
  if (e.code === "ArrowRight") return "Right";
  if (e.code?.startsWith("F") && /^F\d+$/.test(e.code)) return e.code;
  if (e.code === "Comma") return ",";
  if (e.code === "Period") return ".";
  if (e.code === "Slash") return "/";
  if (e.code === "Semicolon") return ";";
  if (e.code === "Quote") return "'";
  if (e.code === "Backquote") return "`";
  if (e.code === "Minus") return "-";
  if (e.code === "Equal") return "=";
  if (e.code === "BracketLeft") return "[";
  if (e.code === "BracketRight") return "]";
  if (e.code === "Backslash") return "\\";
  return null;
}
