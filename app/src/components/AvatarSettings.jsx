import React, { useCallback, useEffect, useState } from "react";
import { createAnimationBaker } from "../lib/animation-baker.js";
import EffectsSection from "./EffectsSection.jsx";

// Tabbed avatar settings.
// Tabs: identity / voice / animations / look / channels / danger
//
// Reads current state via config.get + agents.list + agents.files.get,
// commits with config.patch + agents.files.set. Surfaces destructive
// operations on a separate Danger tab so they're out of the normal flow.
const TABS = [
  { id: "identity", label: "Identity" },
  { id: "voice", label: "Voice" },
  { id: "animations", label: "Animations" },
  { id: "scene", label: "Scene" },
  { id: "post", label: "Post-FX" },
  { id: "ui", label: "UI" },
  { id: "channels", label: "Channels" },
  { id: "danger", label: "Danger", danger: true },
];

export default function AvatarSettings({
  gateway,
  agentId,
  onClose,
  onPreview,
  onAvatarChanged,
  onAvatarDeleted,
  onPairChannel,
}) {
  const [avatar, setAvatar] = useState(null);
  const [soul, setSoul] = useState("");
  const [agentRow, setAgentRow] = useState(null);
  const [bindings, setBindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rebakeStatus, setRebakeStatus] = useState(null);
  const [tab, setTab] = useState("identity");

  useEffect(() => {
    onPreview?.(avatar);
  }, [avatar, onPreview]);

  useEffect(() => {
    if (!agentId || gateway.status !== "connected") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [agentsRes, soulRes, configRes] = await Promise.all([
          gateway.request("agents.list", {}),
          gateway
            .request("agents.files.get", { agentId, name: "SOUL.md" })
            .catch(() => null),
          gateway.request("config.get", {}).catch(() => null),
        ]);
        if (cancelled) return;
        const cfgRoot = configRes?.config ?? configRes ?? {};
        const a =
          cfgRoot?.plugins?.entries?.exuvia?.config?.avatars?.[agentId] ?? null;
        setAvatar(
          a
            ? {
                ...a,
                avatarPath: a.avatarPath ?? a.fbxPath ?? "",
                animations: (a.animations ?? []).map((x) => ({
                  ...x,
                  tags: Array.isArray(x.tags) ? x.tags : [],
                })),
                // Lights are stored without ids (so the openclaw patch
                // merger replaces the array wholesale instead of merging
                // by id — see save() for the full reasoning). Regenerate
                // client-side ids so React keys & scene reconciliation
                // have stable handles.
                lights: Array.isArray(a.lights)
                  ? a.lights.map((l) => ({ id: newLightId(), ...l }))
                  : a.lights,
              }
            : null,
        );
        const list =
          agentsRes?.agents ?? agentsRes?.list ?? agentsRes ?? [];
        setAgentRow(
          (Array.isArray(list) ? list : []).find(
            (r) => (r.id ?? r.agentId ?? r.name) === agentId,
          ) ?? null,
        );
        setSoul(typeof soulRes?.file?.content === "string" ? soulRes.file.content : "");
        const allBindings = cfgRoot?.bindings ?? [];
        setBindings(
          Array.isArray(allBindings)
            ? allBindings.filter((b) => b?.agentId === agentId)
            : [],
        );
      } catch (err) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway.status, agentId]);

  const save = async () => {
    if (!avatar) return;
    setSaving(true);
    setError(null);
    try {
      await gateway.request("agents.files.set", {
        agentId,
        name: "SOUL.md",
        content: soul,
      });
      const sidecarPatch = {
        plugins: {
          entries: {
            exuvia: {
              config: {
                avatars: {
                  [agentId]: {
                    avatarPath: avatar.avatarPath,
                    fbxPath: undefined,
                    fbxScale: avatar.fbxScale,
                    userAddress: avatar.userAddress?.trim() || null,
                    voiceOnChannels: avatar.voiceOnChannels || undefined,
                    voiceLocallyEnabled:
                      avatar.voiceLocallyEnabled === true ? true : undefined,
                    personalityRewrite: avatar.personalityRewrite || undefined,
                    chatColors: avatar.chatColors ?? undefined,
                    ui: avatar.ui ?? undefined,
                    environmentHdriPath: avatar.environmentHdriPath ?? undefined,
                    environmentIntensity:
                      avatar.environmentIntensity != null
                        ? avatar.environmentIntensity
                        : undefined,
                    backgroundIntensity:
                      avatar.backgroundIntensity != null
                        ? avatar.backgroundIntensity
                        : undefined,
                    lightsIntensity:
                      avatar.lightsIntensity != null
                        ? avatar.lightsIntensity
                        : undefined,
                    // openclaw's config patch merges arrays of {id: ...}
                    // entries BY ID instead of replacing them — so removing
                    // lights from the UI never deletes them on disk; the
                    // shorter patch array is just merged onto the longer
                    // stored array. Strip the `id` field before sending so
                    // the merger sees a non-id-keyed array and replaces it
                    // wholesale. Ids are only used client-side as React
                    // keys / scene-reconciliation handles, regenerated on
                    // load — safe to drop on the wire.
                    // `null` deletes the key entirely (used when there are
                    // no custom lights).
                    lights:
                      Array.isArray(avatar.lights) && avatar.lights.length > 0
                        ? avatar.lights.map(({ id, ...rest }) => rest)
                        : null,
                    scenePath: avatar.scenePath ?? undefined,
                    environmentScale:
                      avatar.environmentScale != null
                        ? avatar.environmentScale
                        : undefined,
                    postProcessing: avatar.postProcessing ?? undefined,
                    animations: (avatar.animations ?? []).map((a) => ({
                      name: a.name,
                      description: a.description || undefined,
                      tags: a.tags && a.tags.length > 0 ? a.tags : undefined,
                      loop: a.loop,
                      durationMs: a.durationMs,
                      gifPath: a.gifPath || undefined,
                    })),
                  },
                },
              },
            },
          },
        },
      };
      try {
        await gateway.configPatch(sidecarPatch);
      } catch (err) {
        const msg = String(err?.message ?? err);
        const recoverable =
          /gateway restarting/i.test(msg) ||
          /socket closed/i.test(msg) ||
          /not connected/i.test(msg);
        if (!recoverable) throw err;
        console.warn(`[settings] patch closed socket (${msg}); treating as success`);
      }
      onAvatarChanged?.(agentId);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  const resetSession = async () => {
    setSaving(true);
    setError(null);
    try {
      await gateway.request("sessions.reset", {
        key: `agent:${agentId}:main`,
      });
      setConfirmReset(false);
      onAvatarChanged?.(agentId);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  const rebake = async () => {
    if (!avatar?.avatarPath || !(avatar.animations?.length > 0)) return;
    setSaving(true);
    setError(null);
    setRebakeStatus({ done: 0, total: avatar.animations.length, current: null });
    let baker;
    try {
      const expanded = await window.exuvia.path.expand(avatar.avatarPath);
      const readRes = await window.exuvia.fbx.read(expanded);
      if (!readRes?.ok) throw new Error(`avatar read failed: ${readRes?.error ?? "unknown"}`);
      const fakeFile = {
        arrayBuffer: async () => readRes.bytes.buffer.slice(
          readRes.bytes.byteOffset,
          readRes.bytes.byteOffset + readRes.bytes.byteLength,
        ),
        name: expanded.split(/[\\/]/).pop() || "avatar.fbx",
      };
      baker = await createAnimationBaker(fakeFile, avatar.fbxScale ?? null);
      const fbxDir = expanded.replace(/[\\/]+[^\\/]+$/, "");
      const gifsDir = `${fbxDir}/gifs`;
      const ext = baker.extForMime();
      const next = avatar.animations.slice();
      let done = 0;
      for (let i = 0; i < next.length; i += 1) {
        const a = next[i];
        setRebakeStatus({ done, total: next.length, current: a.name });
        try {
          const blob = await baker.bake({
            name: a.name,
            durationMs: a.durationMs,
            loop: a.loop,
          });
          const buf = await blob.arrayBuffer();
          const safeName = a.name.replace(/[^a-zA-Z0-9_-]+/g, "_");
          const target = `${gifsDir}/${safeName}.${ext}`;
          const writeRes = await window.exuvia.fbx.write({
            targetPath: target,
            bytes: new Uint8Array(buf),
          });
          if (!writeRes?.ok) throw new Error(writeRes?.error ?? "write failed");
          next[i] = { ...a, gifPath: target };
        } catch (err) {
          console.error("[rebake] failed", a.name, err);
          setError(`bake failed for ${a.name}: ${err?.message ?? err}`);
        }
        done += 1;
        setRebakeStatus({ done, total: next.length, current: null });
      }
      setAvatar({ ...avatar, animations: next });
      setRebakeStatus("done");
    } catch (err) {
      setError(err?.message ?? String(err));
      setRebakeStatus(null);
    } finally {
      baker?.dispose?.();
      setSaving(false);
    }
  };

  const deleteAvatar = async () => {
    setSaving(true);
    setError(null);
    try {
      await gateway.configPatch({
        plugins: {
          entries: {
            exuvia: {
              config: { avatars: { [agentId]: null } },
            },
          },
        },
      });
      try {
        await gateway.request("agents.delete", { agentId });
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (!/not found/i.test(msg)) throw err;
        console.warn(`[settings] agents.delete: ${msg} (already deleted)`);
      }
      onAvatarDeleted?.(agentId);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateAvatar = (patch) => setAvatar((prev) => ({ ...prev, ...patch }));

  // Escape key closes the modal — guarantees there's always a way out even
  // when controls fall outside the visible area on small windows.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !saving) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  return (
    <div className="settings-inline">
      <div className="settings-header">
        <button
          onClick={onClose}
          disabled={saving}
          style={{ padding: "4px 10px", fontSize: 11 }}
        >
          ← back
        </button>
        <h2>{agentRow?.name ?? agentId}</h2>
        <span style={{ width: 60 }} />
      </div>

      <div className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab ${t.danger ? "danger" : ""} ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-panel">
        {loading && <span className="muted">loading…</span>}
        {error && <div style={{ color: "#ff7878", fontSize: 11, marginBottom: 8 }}>{error}</div>}

        {!loading && !avatar && (
          <p className="muted">
            No exuvia avatar metadata for <code>{agentId}</code>. This is a
            plain claw agent — settings are read-only.
          </p>
        )}

        {avatar && tab === "identity" && (
          <IdentityTab
            avatar={avatar}
            soul={soul}
            setSoul={setSoul}
            updateAvatar={updateAvatar}
          />
        )}
        {avatar && tab === "voice" && (
          <VoiceTab avatar={avatar} updateAvatar={updateAvatar} gateway={gateway} />
        )}
        {avatar && tab === "animations" && (
          <AnimationsTab
            avatar={avatar}
            updateAvatar={updateAvatar}
            rebake={rebake}
            rebakeStatus={rebakeStatus}
            saving={saving}
          />
        )}
        {avatar && tab === "scene" && (
          <SceneTab avatar={avatar} updateAvatar={updateAvatar} />
        )}
        {avatar && tab === "post" && (
          <PostTab avatar={avatar} updateAvatar={updateAvatar} />
        )}
        {avatar && tab === "ui" && (
          <UiTab avatar={avatar} updateAvatar={updateAvatar} />
        )}
        {avatar && tab === "channels" && (
          <ChannelsTab
            agentId={agentId}
            bindings={bindings}
            onPairChannel={onPairChannel}
            saving={saving}
          />
        )}
        {avatar && tab === "danger" && (
          <DangerTab
            agentId={agentId}
            confirmReset={confirmReset}
            setConfirmReset={setConfirmReset}
            confirmDelete={confirmDelete}
            setConfirmDelete={setConfirmDelete}
            resetSession={resetSession}
            deleteAvatar={deleteAvatar}
            saving={saving}
          />
        )}
      </div>

      <div className="settings-footer">
        <span className="muted" style={{ fontSize: 10, letterSpacing: 0.4 }}>
          {avatar ? `agent: ${agentId}` : ""}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving}>cancel</button>
          <button onClick={save} disabled={saving || !avatar}>
            {saving ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── tabs ──────────────────────────────────────────────────────────────────

function IdentityTab({ avatar, soul, setSoul, updateAvatar }) {
  return (
    <>
      <div className="section-title">Personality</div>
      <div className="field-stacked">
        <label>SOUL.md (voice and tone)</label>
        <textarea
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          rows={6}
          style={{ minHeight: 110, resize: "vertical", fontSize: 11 }}
        />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(avatar.personalityRewrite)}
          onChange={(e) => updateAvatar({ personalityRewrite: e.target.checked })}
        />
        <span>
          <strong>Force-rewrite replies in voice</strong> — every assistant
          message gets a second LLM pass that re-styles it. Doubles latency.
          Skipped on replies with structured data.
        </span>
      </label>

      <div className="field">
        <label>What the avatar calls you</label>
        <input
          type="text"
          value={avatar.userAddress ?? ""}
          placeholder="(optional — e.g. boss, babe, your name)"
          onChange={(e) => updateAvatar({ userAddress: e.target.value })}
        />
      </div>

      <div className="section-title">Model</div>
      <div className="field">
        <label>Avatar path</label>
        <input
          type="text"
          value={avatar.avatarPath ?? ""}
          onChange={(e) => updateAvatar({ avatarPath: e.target.value })}
        />
      </div>
    </>
  );
}

function VoiceTab({ avatar, updateAvatar, gateway }) {
  // TTS is OFF by default. Must be explicitly enabled.
  const voiceLocallyEnabled = avatar.voiceLocallyEnabled === true;
  return (
    <>
      <div className="section-title">Voice delivery</div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={voiceLocallyEnabled}
          onChange={(e) => updateAvatar({ voiceLocallyEnabled: e.target.checked })}
        />
        <span>
          <strong>Speak replies in this app</strong> — when off, replies
          appear as text only. The avatar's lip-sync and animations still
          play; just no audio out of the desktop app.
        </span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(avatar.voiceOnChannels)}
          onChange={(e) => updateAvatar({ voiceOnChannels: e.target.checked })}
        />
        <span>
          <strong>Send voice notes on chat channels</strong> — Telegram,
          WhatsApp, etc. Independent of the in-app voice setting above.
        </span>
      </label>

      <div className="section-title">Voice input (mic → text)</div>
      <VoiceInputSetup gateway={gateway} />

      <div className="section-title">Push-to-talk hotkey</div>
      <PushToTalkBinder />
    </>
  );
}

// Voice-input setup. Lets the user pick a transcription provider and
// paste an API key without leaving the app. Internally:
//   1. persists the key to Electron's encrypted local store (safeStorage)
//      so it survives restarts but never lands in plain-text files
//   2. injects the key as the provider's expected env var (e.g.
//      GROQ_API_KEY) on every openclaw CLI spawn — the gateway-running
//      process can stay un-touched
//   3. writes tools.media.audio.models via gateway.configPatch so the
//      CLI knows which provider/model to use
//   4. re-runs `openclaw capability audio providers --json` so the
//      panel reflects the live config
//
// Defaults to Groq because its free tier is generous enough that this
// app stays free for personal use; user can swap to OpenAI/Deepgram
// later if they want.
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

function VoiceInputSetup({ gateway }) {
  const [providerId, setProviderId] = useState("groq");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState(null); // { provider, configured, selected }[]
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
  const status_ = Array.isArray(status)
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
      // Now write tools.media.audio.models so the CLI knows which
      // provider/model to use for transcription. configPatch may close
      // the WS mid-flight when openclaw hot-reloads; same recoverable-
      // error handling as the wizard / settings save paths.
      try {
        await gateway.configPatch({
          tools: {
            media: {
              audio: {
                models: [provider.model],
              },
            },
          },
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
          const live = Array.isArray(status)
            ? status.find((s) => s?.id === p.id)
            : null;
          const dotColor = live?.selected
            ? "#6ce28b"
            : live?.configured
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
            <label>API key{status_?.configured ? " (already configured)" : ""}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status_?.configured ? "(leave blank to keep current)" : provider.keyHint}
            />
          </div>

          <div className="row">
            <button
              type="button"
              onClick={save}
              disabled={busy || !apiKey.trim()}
            >
              {busy ? "saving…" : status_?.selected ? "update key" : "save & select"}
            </button>
            {status_?.selected && (
              <span className="muted" style={{ fontSize: 11 }}>
                ✓ configured and selected
              </span>
            )}
            {status_?.configured && !status_?.selected && (
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

// Push-to-talk hotkey binder. Reads the current binding from the Electron
// settings store, lets the user click "rebind" → press any key → save,
// and broadcasts the change through a window event so ChatView's PTT
// listener updates without a reload. Empty string disables PTT.
function PushToTalkBinder() {
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
      // Broadcast so any open ChatView updates without remount.
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
      // Esc cancels without saving; we treat it as a normal key
      // because some users may legitimately want Esc bound.
      // Empty string isn't a valid e.code so use a special button to
      // disable instead.
      setBinding(false);
      persist(e.code);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [binding, persist]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        Hold this key to record while it's pressed; release to send. Disabled
        when typing into a text field. Esc cancels mid-record.
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

function AnimationsTab({ avatar, updateAvatar, rebake, rebakeStatus, saving }) {
  const animations = avatar.animations ?? [];
  return (
    <>
      <div className="section-title">Animations</div>
      <div className="row">
        <button
          onClick={rebake}
          disabled={saving || !avatar.avatarPath || animations.length === 0}
        >
          re-bake all clips
        </button>
        {rebakeStatus && rebakeStatus !== "done" && (
          <span className="muted" style={{ fontSize: 11 }}>
            baking {rebakeStatus.done + 1}/{rebakeStatus.total}
            {rebakeStatus.current ? ` — ${rebakeStatus.current}` : ""}…
          </span>
        )}
        {rebakeStatus === "done" && (
          <span className="muted" style={{ fontSize: 11 }}>✓ baked. save to persist.</span>
        )}
      </div>
      {animations.length === 0 && (
        <span className="muted" style={{ fontSize: 11 }}>no animations registered</span>
      )}
      {animations.map((a, i) => (
        <div key={`${a.name}-${i}`} className="anim-card">
          <div className="anim-card-head">
            <strong>{a.name}</strong>
            <span className="muted">
              {((a.durationMs ?? 0) / 1000).toFixed(2)}s · {a.loop ? "loop" : "once"}
            </span>
          </div>
          <input
            type="text"
            value={(a.tags ?? []).join(", ")}
            placeholder="tags (comma-separated)"
            onChange={(e) => {
              const next = animations.slice();
              next[i] = {
                ...a,
                tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
              };
              updateAvatar({ animations: next });
            }}
          />
          <input
            type="text"
            value={a.description ?? ""}
            placeholder="description"
            onChange={(e) => {
              const next = animations.slice();
              next[i] = { ...a, description: e.target.value };
              updateAvatar({ animations: next });
            }}
          />
        </div>
      ))}
    </>
  );
}

function SceneTab({ avatar, updateAvatar }) {
  return (
    <>
      <div className="section-title">Model</div>
      <IntensitySlider
        label="Avatar scale"
        value={avatar.fbxScale ?? 0.01}
        min={0.001}
        max={2}
        step={0.001}
        onChange={(v) => updateAvatar({ fbxScale: v })}
        hint="multiplier on the imported avatar mesh. FBX defaults to 0.01 (cm→m), GLB to 1.0."
      />

      <div className="section-title">Lighting</div>
      <div className="field">
        <label>HDRI</label>
        <input
          type="text"
          value={avatar.environmentHdriPath ?? ""}
          placeholder="/assets/hdri/scifi.exr"
          onChange={(e) => updateAvatar({ environmentHdriPath: e.target.value })}
        />
      </div>
      <IntensitySlider
        label="HDRI lighting"
        value={avatar.environmentIntensity ?? 1.0}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => updateAvatar({ environmentIntensity: v })}
        hint="how strongly the HDRI lights and reflects on the avatar"
      />
      <IntensitySlider
        label="HDRI background"
        value={avatar.backgroundIntensity ?? 0.3}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => updateAvatar({ backgroundIntensity: v })}
        hint="visible sky brightness behind the avatar"
      />
      <IntensitySlider
        label="Lights master"
        value={avatar.lightsIntensity ?? 1.0}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => updateAvatar({ lightsIntensity: v })}
        hint="multiplier on every light below. Set to 0 to rely on HDRI alone."
      />

      <div className="section-title">Lights</div>
      <LightsEditor
        lights={avatar.lights}
        onChange={(next) => updateAvatar({ lights: next })}
      />

      <div className="section-title">Set</div>
      <div className="field">
        <label>3D scene</label>
        <input
          type="text"
          value={avatar.scenePath ?? ""}
          placeholder="/assets/environment/env.glb"
          onChange={(e) => updateAvatar({ scenePath: e.target.value })}
        />
      </div>
      <IntensitySlider
        label="Environment scale"
        value={avatar.environmentScale ?? 1.0}
        min={0.001}
        max={5}
        step={0.01}
        onChange={(v) => updateAvatar({ environmentScale: v })}
        hint="multiplier on the environment GLB's root scale. Tweak if the set imports too small or too large."
      />
    </>
  );
}

function PostTab({ avatar, updateAvatar }) {
  return (
    <EffectsSection
      value={avatar.postProcessing}
      onChange={(next) => updateAvatar({ postProcessing: next })}
    />
  );
}

function UiTab({ avatar, updateAvatar }) {
  const ui = avatar.ui ?? {};
  const updateUi = (patch) => updateAvatar({ ui: { ...ui, ...patch } });

  // Local CSS-variable scope so the preview reflects every UI knob the
  // user drags, without depending on the live scene chat (which may be
  // hidden while settings is open). Mirrors what App.jsx does to the
  // root .app-shell — kept in sync field-for-field.
  const previewStyle = {};
  const cc = avatar.chatColors;
  if (cc?.assistant) {
    previewStyle["--ai-tint"] = cc.assistant;
    previewStyle["--ai-tint-border"] = cc.assistantBorder ?? cc.assistant;
  }
  if (cc?.user) {
    previewStyle["--user-tint"] = cc.user;
    previewStyle["--user-tint-border"] = cc.userBorder ?? cc.user;
  }
  if (typeof ui.bubbleRadius === "number") {
    previewStyle["--bubble-radius"] = `${ui.bubbleRadius}px`;
  }
  if (typeof ui.bubblePadding === "number") {
    previewStyle["--bubble-padding"] = `${ui.bubblePadding}px ${ui.bubblePadding + 4}px`;
  }
  if (typeof ui.bubbleFontSize === "number") {
    previewStyle["--bubble-font-size"] = `${ui.bubbleFontSize}px`;
  }

  return (
    <>
      <div className="section-title">Preview</div>
      <div className="ui-preview" style={previewStyle}>
        <div className="ui-preview-msg assistant">
          Hey — how can I help you today?
        </div>
        <div className="ui-preview-msg user">
          Show me what these bubbles look like.
        </div>
        <div className="ui-preview-msg assistant">
          Drag the sliders below — colors, roundness, padding, and size
          all update in real time.
        </div>
      </div>

      <div className="section-title">Chat bubble colors</div>
      <ChatColorRow
        label="Assistant"
        value={avatar.chatColors?.assistant ?? ""}
        onChange={(v) =>
          updateAvatar({
            chatColors: { ...(avatar.chatColors ?? {}), assistant: v || undefined },
          })
        }
      />
      <ChatColorRow
        label="User"
        value={avatar.chatColors?.user ?? ""}
        onChange={(v) =>
          updateAvatar({
            chatColors: { ...(avatar.chatColors ?? {}), user: v || undefined },
          })
        }
      />

      <div className="section-title">Chat bar</div>
      <SliderField
        label="Width"
        value={ui.chatWidth ?? 820}
        min={420}
        max={1200}
        step={10}
        unit="px"
        onChange={(v) => updateUi({ chatWidth: v })}
      />
      <SliderField
        label="Bubble roundness"
        value={ui.bubbleRadius ?? 2}
        min={0}
        max={24}
        step={1}
        unit="px"
        onChange={(v) => updateUi({ bubbleRadius: v })}
      />
      <SliderField
        label="Bubble padding"
        value={ui.bubblePadding ?? 8}
        min={4}
        max={20}
        step={1}
        unit="px"
        onChange={(v) => updateUi({ bubblePadding: v })}
      />
      <SliderField
        label="Bubble font size"
        value={ui.bubbleFontSize ?? 12}
        min={10}
        max={18}
        step={1}
        unit="px"
        onChange={(v) => updateUi({ bubbleFontSize: v })}
      />

      <div className="section-title">Buttons</div>
      <SliderField
        label="Roundness"
        value={ui.buttonRadius ?? 2}
        min={0}
        max={20}
        step={1}
        unit="px"
        onChange={(v) => updateUi({ buttonRadius: v })}
      />
      <ColorField
        label="Accent"
        value={ui.accentColor ?? ""}
        onChange={(v) => updateUi({ accentColor: v || undefined })}
      />
    </>
  );
}

// Compact slider with a label, range input, and the current value shown
// to the right. Used by UiTab. Live-updates on every drag tick so the
// scene preview tracks the slider without a save round-trip.
function SliderField({ label, value, min, max, step, unit, onChange }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span className="muted" style={{ fontSize: 10, minWidth: 44, textAlign: "right" }}>
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}

// Compact color picker + clear button. Empty string = "use theme default".
function ColorField({ label, value, onChange }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#8282ff";
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          style={{ padding: 0, width: 30, height: 22, cursor: "pointer", border: "1px solid var(--border-glass)" }}
        />
        <button
          type="button"
          onClick={() => onChange("")}
          style={{ padding: "2px 8px", fontSize: 10 }}
          title="reset to theme default"
        >
          reset
        </button>
      </div>
    </div>
  );
}

function ChannelsTab({ agentId, bindings, onPairChannel, saving }) {
  return (
    <>
      <div className="section-title">Bound channels</div>
      {bindings.length === 0 && (
        <span className="muted" style={{ fontSize: 11 }}>
          no channel bindings — this avatar only appears in the desktop app.
        </span>
      )}
      {bindings.map((b, i) => (
        <div key={i} className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          {JSON.stringify(b.match ?? {})}
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <button onClick={() => onPairChannel?.(agentId)} disabled={saving}>
          add channel binding…
        </button>
      </div>
    </>
  );
}

function DangerTab({
  agentId,
  confirmReset,
  setConfirmReset,
  confirmDelete,
  setConfirmDelete,
  resetSession,
  deleteAvatar,
  saving,
}) {
  return (
    <>
      <div className="section-title" style={{ color: "rgba(255,154,154,0.7)" }}>
        Destructive actions
      </div>

      <div className="danger-row">
        <strong>Reset chat history</strong>
        <span className="muted" style={{ fontSize: 11 }}>
          Wipes all conversation transcripts with this avatar. The avatar
          itself, its workspace files, and config stay.
        </span>
        {!confirmReset ? (
          <button onClick={() => setConfirmReset(true)} disabled={saving}>
            reset history…
          </button>
        ) : (
          <div className="row">
            <button onClick={resetSession} disabled={saving}>yes, reset</button>
            <button onClick={() => setConfirmReset(false)} disabled={saving}>cancel</button>
          </div>
        )}
      </div>

      <div className="danger-row">
        <strong>Delete avatar</strong>
        <span className="muted" style={{ fontSize: 11 }}>
          Removes the agent <code>{agentId}</code>, its workspace, sessions,
          and the exuvia avatar metadata. Cannot be undone.
        </span>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} disabled={saving}>
            delete avatar…
          </button>
        ) : (
          <div className="row">
            <button onClick={deleteAvatar} disabled={saving}>yes, delete</button>
            <button onClick={() => setConfirmDelete(false)} disabled={saving}>cancel</button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

// Cinematic defaults so a freshly-added light isn't sitting at the origin.
const LIGHT_DEFAULTS = {
  directional: {
    type: "directional",
    enabled: true,
    color: "#ffffff",
    intensity: 0.9,
    position: [2, 4, 2],
  },
  point: {
    type: "point",
    enabled: true,
    color: "#ffffff",
    intensity: 1.0,
    position: [0, 2, 1],
  },
  ambient: {
    type: "ambient",
    enabled: true,
    color: "#ffffff",
    intensity: 0.4,
  },
};

function newLightId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `light-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function LightsEditor({ lights, onChange }) {
  const list = Array.isArray(lights) ? lights : [];

  const add = (type) => {
    const next = [
      ...list,
      { id: newLightId(), ...LIGHT_DEFAULTS[type] },
    ];
    onChange(next);
  };

  const update = (id, patch) => {
    onChange(list.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const remove = (id) => {
    onChange(list.filter((l) => l.id !== id));
  };

  const seedDefaults = () => {
    onChange([
      { id: newLightId(), name: "key",  ...LIGHT_DEFAULTS.directional, color: "#ffffff", intensity: 0.9, position: [2, 4, 2] },
      { id: newLightId(), name: "fill", ...LIGHT_DEFAULTS.directional, color: "#b0c4ff", intensity: 0.4, position: [-2, 2, 1] },
      { id: newLightId(), name: "rim",  ...LIGHT_DEFAULTS.directional, color: "#ffaa88", intensity: 0.6, position: [-1, 2, -2] },
      { id: newLightId(), name: "ambient", ...LIGHT_DEFAULTS.ambient },
    ]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {list.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.45)",
            padding: "8px 0",
          }}
        >
          using default lighting (ambient + key + fill). Add a custom light
          below to override, or seed a 3-point setup to get started.
        </div>
      )}

      {list.map((light) => (
        <LightRow
          key={light.id}
          light={light}
          onChange={(patch) => update(light.id, patch)}
          onRemove={() => remove(light.id)}
        />
      ))}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {list.length === 0 && (
          <button onClick={seedDefaults} type="button" style={{ fontSize: 10 }}>
            + 3-point preset
          </button>
        )}
        <button onClick={() => add("directional")} type="button" style={{ fontSize: 10 }}>
          + directional
        </button>
        <button onClick={() => add("point")} type="button" style={{ fontSize: 10 }}>
          + point
        </button>
        <button onClick={() => add("ambient")} type="button" style={{ fontSize: 10 }}>
          + ambient
        </button>
        {list.length > 0 && (
          <button
            onClick={() => onChange(undefined)}
            type="button"
            style={{ fontSize: 10, marginLeft: "auto" }}
            title="reset to default ambient + key + fill"
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}

function LightRow({ light, onChange, onRemove }) {
  const [open, setOpen] = useState(false);
  const labelText =
    light.name ?? `${light.type} ${light.id.slice(-4)}`;
  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 2,
        padding: "6px 8px",
        background: "rgba(255,255,255,0.02)",
        opacity: light.enabled === false ? 0.5 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
        }}
      >
        <input
          type="checkbox"
          checked={light.enabled !== false}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          title="enable"
        />
        <input
          type="color"
          value={light.color ?? "#ffffff"}
          onChange={(e) => onChange({ color: e.target.value })}
          style={{ width: 22, height: 18, padding: 0, border: "1px solid var(--border-glass)" }}
          title="color"
        />
        <input
          type="text"
          value={light.name ?? ""}
          placeholder={light.type}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
          style={{ flex: 1, padding: "2px 6px", fontSize: 11 }}
        />
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            color: "rgba(255,255,255,0.5)",
            minWidth: 28,
            textAlign: "right",
          }}
        >
          {Number(light.intensity ?? 1).toFixed(2)}
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          type="button"
          style={{ padding: "1px 6px", fontSize: 10 }}
          title={open ? "collapse" : "expand"}
        >
          {open ? "−" : "+"}
        </button>
        <button
          onClick={onRemove}
          type="button"
          style={{ padding: "1px 6px", fontSize: 10, color: "rgba(255,154,154,0.8)" }}
          title="remove"
        >
          ×
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <span style={{ fontSize: 9, letterSpacing: "0.5px", textTransform: "uppercase", color: "rgba(255,255,255,0.4)" }}>
            type: {light.type}
          </span>
          <IntensitySliderInline
            label="intensity"
            value={light.intensity ?? 1}
            min={0}
            max={5}
            step={0.05}
            onChange={(v) => onChange({ intensity: v })}
          />
          {light.type !== "ambient" && (
            <>
              <Vec3Input
                label="position"
                value={light.position ?? [0, 2, 0]}
                onChange={(v) => onChange({ position: v })}
              />
              {light.type === "directional" && (
                <Vec3Input
                  label="target"
                  value={light.target ?? [0, 1.4, 0]}
                  onChange={(v) => onChange({ target: v })}
                  hint="point the light is aimed at (avatar's head ≈ 1.4)"
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IntensitySliderInline({ label, value, min, max, step, onChange }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Vec3Input({ label, value, onChange, hint }) {
  const v = Array.isArray(value) ? value : [0, 0, 0];
  const set = (i, n) => {
    const next = [...v];
    next[i] = Number.isFinite(n) ? n : 0;
    onChange(next);
  };
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label} (x y z)
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            type="number"
            step="0.1"
            value={v[i] ?? 0}
            onChange={(e) => set(i, Number(e.target.value))}
            style={{ padding: "2px 4px", fontSize: 10 }}
          />
        ))}
      </div>
      {hint && (
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{hint}</span>
      )}
    </label>
  );
}

function IntensitySlider({ label, value, min, max, step, onChange, hint }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 10,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        <span>{label}</span>
        <span
          style={{
            fontFamily:
              'ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace',
            fontSize: 10,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          {Number(value).toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && (
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}


// Defaults match the CSS variables in styles.css — when the picker shows
// no value, it shows what's actually rendering on screen. Was previously
// a different blue, which is why the picker's preview didn't match the
// real bubble until the user nudged it.
const DEFAULTS = {
  Assistant: { hex: "#8282ff", alpha: 0.08 }, // rgba(130, 130, 255, 0.08)
  User:      { hex: "#ffb482", alpha: 0.10 }, // rgba(255, 180, 130, 0.10)
};

function rgbaToParts(value, label) {
  if (!value) {
    return DEFAULTS[label] ?? { hex: "#8282ff", alpha: 0.08 };
  }
  const m = String(value).match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/i,
  );
  if (m) {
    const [, r, g, b, a] = m;
    const hex =
      "#" +
      [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    return { hex, alpha: a == null ? 1 : Number(a) };
  }
  return { hex: value, alpha: 1 };
}
function partsToRgba(hex, alpha) {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

function ChatColorRow({ label, value, onChange }) {
  const { hex, alpha } = rgbaToParts(value, label);
  const setHex = (h) => {
    const next = partsToRgba(h, alpha);
    if (next) onChange(next);
  };
  const setAlpha = (a) => {
    const next = partsToRgba(hex, a);
    if (next) onChange(next);
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "70px 30px 90px auto",
        gap: 8,
        alignItems: "center",
        marginBottom: 6,
        fontSize: 11,
      }}
    >
      <span className="muted">{label}</span>
      <input
        type="color"
        value={hex}
        onChange={(e) => setHex(e.target.value)}
        style={{ padding: 0, width: 30, height: 22, cursor: "pointer", border: "1px solid var(--border-glass)" }}
        title="color"
      />
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={alpha}
        onChange={(e) => setAlpha(Number(e.target.value))}
        title={`opacity ${(alpha * 100).toFixed(0)}%`}
      />
      <button
        type="button"
        onClick={() => onChange("")}
        style={{ padding: "2px 8px", fontSize: 10 }}
        title="reset"
      >
        reset
      </button>
    </div>
  );
}
