import React, { useCallback, useEffect, useRef, useState } from "react";
import { useGateway } from "./hooks/useGateway.js";
import { useAvatarConfig } from "./hooks/useAvatarConfig.js";
import { useTTS } from "./hooks/useTTS.js";
import AvatarScene from "./components/AvatarScene.jsx";
import SetupModal from "./components/SetupModal.jsx";
import AgentPicker, { LockIcon } from "./components/AgentPicker.jsx";
import ChatView, { scrubAssistantText } from "./components/ChatView.jsx";
import CreatorWizard from "./components/CreatorWizard.jsx";
import AvatarSettings from "./components/AvatarSettings.jsx";
import ChannelPairing from "./components/ChannelPairing.jsx";
import { importAvatarBundle } from "./lib/avatar-import.js";

export default function App() {
  const gateway = useGateway();
  // Remember the last selected avatar across app restarts. We read the
  // saved id synchronously on first render so the avatar appears without
  // a "no avatar selected" flash. agents.list resolution happens later
  // (in the picker / useAvatarConfig) — if the saved id no longer exists
  // those will handle the empty case naturally.
  const [activeAgentId, setActiveAgentId] = useState(() => {
    try {
      const saved = localStorage.getItem("exuvia.activeAgentId");
      return saved && saved.trim() ? saved : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (activeAgentId) {
        localStorage.setItem("exuvia.activeAgentId", activeAgentId);
      } else {
        localStorage.removeItem("exuvia.activeAgentId");
      }
    } catch {
      /* localStorage may be unavailable in some Electron contexts */
    }
  }, [activeAgentId]);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState(null);
  const [pairingAgentId, setPairingAgentId] = useState(null);
  const [pickerRefreshKey, setPickerRefreshKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Camera lock — locked = chat in front, controls off. Unlocked = chat
  // hidden, orbit controls live so user can frame the avatar.
  const [cameraLocked, setCameraLocked] = useState(true);
  // Currently-playing non-idle animation, surfaced as an on-canvas badge.
  // Null when nothing or only an idle is playing.
  const [activeGesture, setActiveGesture] = useState(null);
  // Drag-and-drop import state. `dragHover` shows the overlay while a
  // .exuvia file is over the window. `dropStatus` carries progress/error
  // text shown briefly after drop.
  const [dragHover, setDragHover] = useState(false);
  const [dropStatus, setDropStatus] = useState(null);
  const dragCounterRef = useRef(0);
  // Unsaved settings-panel edits that the scene should preview live. Cleared
  // when the panel closes or saves.
  const [previewAvatar, setPreviewAvatar] = useState(null);
  const sceneRef = useRef(null);
  const lastSpokenRef = useRef(new Set());
  const lastAnimatedRef = useRef(new Set());
  // Track which message ids existed at mount time for the current avatar.
  // Only messages NOT in this set are eligible for TTS / animation. Reset
  // on avatar switch.
  const historyIdsRef = useRef(new Set());
  const seededRef = useRef(false);

  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0);
  const { avatar: savedAvatar } = useAvatarConfig(
    gateway,
    activeAgentId,
    avatarRefreshKey,
  );
  // Use the preview only when it's for the avatar we're currently displaying.
  const avatar =
    previewAvatar && settingsAgentId === activeAgentId
      ? previewAvatar
      : savedAvatar;
  const tts = useTTS(gateway);

  // Track the live avatar config in a ref so `handleMessages` can read
  // current settings (e.g. voiceLocallyEnabled) without rebuilding the
  // callback every render — that would reset its dedupe Sets and double-
  // fire animations / TTS on streaming chunks.
  const avatarRef = useRef(null);
  avatarRef.current = avatar;

  const needsSetup =
    gateway.status === "needs-setup" ||
    (gateway.status === "disconnected" &&
      !gateway.settings?.sharedSecret &&
      !gateway.settings?.deviceToken);

  // Reset scene-bound state when the active avatar changes.
  // Depend on tts.skip (a useCallback'd stable identity) rather than the tts
  // object itself — the object literal is fresh each render and would loop.
  const ttsSkip = tts.skip;
  useEffect(() => {
    lastSpokenRef.current = new Set();
    lastAnimatedRef.current = new Set();
    historyIdsRef.current = new Set();
    seededRef.current = false;
    ttsSkip();
    sceneRef.current?.stop?.();
  }, [activeAgentId, ttsSkip]);

  // Same-clip cooldown enforced both gateway-side (in animation-tool.ts) and
  // here so what the user sees matches what the tool actually executes. Keep
  // the same window length on both sides.
  const ANIMATION_COOLDOWN_MS = 8_000;
  const lastPlayedRef = useRef(new Map());

  // When the agent emits a tool call, route play_animation to the scene.
  const handleToolCall = useCallback((payload) => {
    const name = payload?.toolName ?? payload?.name;
    if (name !== "play_animation") return;
    const args = payload?.params ?? payload?.args ?? {};
    const target = typeof args.name === "string" ? args.name : null;
    if (!target) return;
    const cooldownKey = `${activeAgentId ?? "?"}:${target.toLowerCase()}`;
    const now = Date.now();
    const last = lastPlayedRef.current.get(cooldownKey) ?? 0;
    if (now - last < ANIMATION_COOLDOWN_MS) {
      // Suppressed locally to match the gateway-side cooldown.
      return;
    }
    lastPlayedRef.current.set(cooldownKey, now);
    sceneRef.current?.playAnimation?.(target);
  }, [activeAgentId]);

  // Speak newly-finished assistant messages. Streaming behavior is best-effort
  // for v1: we wait until a message is marked complete, then speak the whole
  // thing. Phase 3 polish can refine this for streaming.
  // Same stable-identity reasoning as ttsSkip above — depend on tts.speak,
  // not the tts object literal.
  const ttsSpeak = tts.speak;
  const handleMessages = useCallback(
    (messages) => {
      if (!messages || messages.length === 0) return;

      // Seed history once per avatar switch so existing messages are
      // never replayed when switching avatars.
      if (!seededRef.current) {
        const ids = new Set();
        for (const msg of messages) {
          if (!msg) continue;
          const t = pickText(msg);
          const id = msg.id ?? msg.messageId ?? `text:${t.slice(0, 80)}`;
          if (id) ids.add(id);
        }
        historyIdsRef.current = ids;
        seededRef.current = true;
        return;
      }

      const last = messages[messages.length - 1];
      if (last?.role !== "assistant") return;
      const text = pickText(last);
      if (!text || text.trim().length === 0) return;

      const id =
        last.id ?? last.messageId ?? `text:${text.slice(0, 80)}`;
      if (!id || historyIdsRef.current.has(id)) return;

      // Bracket fallback: if the model wrote `[play_animation: <name>]`
      // as text instead of a real tool call (which it does on this
      // ollama path), fire the animation locally. Real `session.tool`
      // events still go through handleToolCall — this is additive.
      // Once per id.
      if (!lastAnimatedRef.current.has(id)) {
        const bracket = text.match(
          /\[play_animation:\s*([a-zA-Z0-9_-]+)\s*\]/i,
        );
        if (bracket) {
          lastAnimatedRef.current.add(id);
          sceneRef.current?.playAnimation?.(bracket[1]);
        }
      }

      const status = last.status ?? last.state ?? null;
      const isComplete =
        !status || status === "complete" || status === "completed" || status === "final";
      if (!isComplete) return;

      const spoken = scrubAssistantText(text);

      // TTS off by default, opt-in per avatar via Voice tab.
      const voiceEnabled = avatarRef.current?.voiceLocallyEnabled === true;
      if (voiceEnabled && !lastSpokenRef.current.has(id) && spoken.length > 0) {
        lastSpokenRef.current.add(id);
        ttsSpeak(spoken, id);
      }
    },
    [ttsSpeak],
  );

  // Build inline CSS-variable overrides from the active avatar's config.
  // Two sub-trees feed in: chatColors (bubble tints) and ui (geometry
  // knobs — width, roundness, padding, font size, accent). Each var has
  // a sensible default in styles.css, so unset fields just fall through.
  const chatStyle = {};
  const cc = avatar?.chatColors;
  if (cc?.assistant) {
    chatStyle["--ai-tint"] = cc.assistant;
    chatStyle["--ai-tint-border"] = cc.assistantBorder ?? cc.assistant;
  }
  if (cc?.user) {
    chatStyle["--user-tint"] = cc.user;
    chatStyle["--user-tint-border"] = cc.userBorder ?? cc.user;
  }
  const ui = avatar?.ui;
  if (ui) {
    if (typeof ui.chatWidth === "number") {
      chatStyle["--chat-width"] = `${ui.chatWidth}px`;
    }
    if (typeof ui.bubbleRadius === "number") {
      chatStyle["--bubble-radius"] = `${ui.bubbleRadius}px`;
    }
    if (typeof ui.bubblePadding === "number") {
      chatStyle["--bubble-padding"] = `${ui.bubblePadding}px ${ui.bubblePadding + 4}px`;
    }
    if (typeof ui.bubbleFontSize === "number") {
      chatStyle["--bubble-font-size"] = `${ui.bubbleFontSize}px`;
    }
    if (typeof ui.buttonRadius === "number") {
      chatStyle["--button-radius"] = `${ui.buttonRadius}px`;
    }
    if (ui.accentColor) {
      chatStyle["--accent"] = ui.accentColor;
    }
  }

  // Drag-and-drop import. Dropping a `.exuvia` (or `.json`) file anywhere
  // on the window runs the same import flow as the picker's import button.
  // dragenter / dragleave fire per child element, so we use a counter to
  // know when the cursor truly leaves the window. dragover is required
  // to prevent default — otherwise the browser navigates to the file.
  useEffect(() => {
    const isAcceptable = (e) => {
      const items = e.dataTransfer?.items;
      if (!items || items.length === 0) return false;
      for (const it of items) {
        if (it.kind !== "file") continue;
        const t = (it.type || "").toLowerCase();
        if (t.includes("json") || t === "" || t === "application/octet-stream") {
          return true;
        }
      }
      return false;
    };
    const onEnter = (e) => {
      if (!isAcceptable(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setDragHover(true);
    };
    const onOver = (e) => {
      if (!isAcceptable(e)) return;
      e.preventDefault();
      // Show "copy" cursor instead of the default "move" — semantically
      // we're importing, not relocating the file.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e) => {
      if (!isAcceptable(e)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragHover(false);
    };
    const onDrop = async (e) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragHover(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const name = (file.name ?? "").toLowerCase();
      if (!name.endsWith(".exuvia") && !name.endsWith(".json")) {
        setDropStatus(`unsupported file: ${file.name} — expected .exuvia`);
        setTimeout(() => setDropStatus(null), 4000);
        return;
      }
      try {
        setDropStatus("reading…");
        const text = await file.text();
        setDropStatus("importing…");
        const result = await importAvatarBundle(gateway, text, {
          onProgress: (p) =>
            setDropStatus(`${p.stage}${p.detail ? ` — ${p.detail}` : ""}`),
        });
        setDropStatus(`imported ✓`);
        setPickerRefreshKey((n) => n + 1);
        if (result?.agentId) setActiveAgentId(result.agentId);
      } catch (err) {
        setDropStatus(`import failed: ${err?.message ?? err}`);
      } finally {
        setTimeout(() => setDropStatus(null), 4000);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [gateway]);

  return (
    <div className="app-shell" style={chatStyle}>
      <AgentPicker
        gateway={gateway}
        activeAgentId={activeAgentId}
        onSelect={(id) => {
          setActiveAgentId(id);
          setPickerOpen(false);
        }}
        onCreateRequested={() => {
          setCreatorOpen(true);
          setPickerOpen(false);
        }}
        onSettingsRequested={(id) => {
          setSettingsAgentId(id);
          setPickerOpen(true);
        }}
        refreshKey={pickerRefreshKey}
        open={pickerOpen || !!settingsAgentId}
        settingsView={
          settingsAgentId && !pairingAgentId ? (
            <AvatarSettings
              gateway={gateway}
              agentId={settingsAgentId}
              onClose={() => {
                setSettingsAgentId(null);
                setPreviewAvatar(null);
              }}
              onPreview={setPreviewAvatar}
              onAvatarChanged={() => {
                setAvatarRefreshKey((n) => n + 1);
                setPickerRefreshKey((n) => n + 1);
                setTimeout(() => setPreviewAvatar(null), 1500);
              }}
              onAvatarDeleted={(id) => {
                setPreviewAvatar(null);
                setSettingsAgentId(null);
                setPickerRefreshKey((n) => n + 1);
                if (id === activeAgentId) setActiveAgentId(null);
              }}
              onPairChannel={(id) => setPairingAgentId(id)}
            />
          ) : null
        }
      />
      <div className="scene">
        {avatar?.avatarPath ? (
          <>
            <AvatarScene
              ref={sceneRef}
              avatarPath={avatar.avatarPath}
              // Force re-run of the avatar load effect without remounting
              // the scene's WebGL context. Bumped after wizard commit so a
              // delete+recreate at the same path still reloads the mesh.
              reloadToken={avatarRefreshKey}
              scale={avatar.fbxScale}
              environmentHdriPath={avatar.environmentHdriPath ?? null}
              environmentIntensity={
                avatar.environmentIntensity != null ? avatar.environmentIntensity : 1.0
              }
              backgroundIntensity={
                avatar.backgroundIntensity != null ? avatar.backgroundIntensity : 0.3
              }
              lightsIntensity={
                avatar.lightsIntensity != null ? avatar.lightsIntensity : 1.0
              }
              lights={avatar.lights}
              scenePath={avatar.scenePath ?? null}
              environmentScale={
                avatar.environmentScale != null ? avatar.environmentScale : 1.0
              }
              postProcessing={avatar.postProcessing ?? null}
              cameraLocked={cameraLocked}
              onAnimationChange={(info) => {
                setActiveGesture(info && !info.isIdle ? info : null);
              }}
            />
            {activeGesture ? (
              <div className="gesture-indicator" aria-hidden>
                <span className="gesture-dot" />
                {activeGesture.name}
              </div>
            ) : null}
          </>
        ) : (
          <div className="scene-empty">
            {activeAgentId
              ? `no avatar model configured for ${activeAgentId}`
              : "pick an avatar to begin"}
          </div>
        )}
      </div>
      <div className="bottom-bar">
        <div className="composer-controls">
          <button
            type="button"
            className={`composer-icon-btn ${cameraLocked ? "active" : ""}`}
            onClick={() => setCameraLocked((v) => !v)}
            title={
              cameraLocked
                ? "camera locked — click to free-look"
                : "camera free — click to lock"
            }
          >
            <LockIcon locked={cameraLocked} size={14} />
          </button>
          <button
            type="button"
            className={`composer-icon-btn ${pickerOpen || settingsAgentId ? "active" : ""}`}
            onClick={() => {
              if (settingsAgentId) {
                setSettingsAgentId(null);
                setPreviewAvatar(null);
                return;
              }
              setPickerOpen((v) => !v);
            }}
            title={
              settingsAgentId
                ? "close settings"
                : pickerOpen
                  ? "hide panel"
                  : "show panel"
            }
          >
            {settingsAgentId || pickerOpen ? "×" : "☰"}
          </button>
        </div>
        {cameraLocked && !pickerOpen && !settingsAgentId && (
          <ChatView
            gateway={gateway}
            agentId={activeAgentId}
            onToolCall={handleToolCall}
            onMessages={handleMessages}
          />
        )}
      </div>
      <div className="status-strip">
        <span>{gateway.status}</span>
        <span>{gateway.lastError ? `× ${gateway.lastError}` : ""}</span>
      </div>
      {needsSetup && gateway.settings && (
        <SetupModal
          initial={gateway.settings}
          onSave={(patch) => gateway.saveSettings(patch)}
        />
      )}
      {creatorOpen && (
        <CreatorWizard
          gateway={gateway}
          onClose={() => setCreatorOpen(false)}
          onCreated={(agentId) => {
            setCreatorOpen(false);
            setPickerRefreshKey((n) => n + 1);
            // Force a fresh config.get even when the new slug equals the
            // currently-active one (delete-then-recreate with the same
            // default slug is a common case — without this bump,
            // useAvatarConfig sees no dep change and the scene stays on
            // the stale avatar state).
            setAvatarRefreshKey((n) => n + 1);
            // Make sure the chat bar comes back: if the user got here
            // through the settings panel of a now-deleted avatar (or
            // left the picker open from a prior flow), clear those so
            // the bottom-bar's `cameraLocked && !pickerOpen
            // && !settingsAgentId` gate flips to true and ChatView
            // mounts for the freshly-created agent.
            setPickerOpen(false);
            setSettingsAgentId(null);
            setPreviewAvatar(null);
            setActiveAgentId(agentId);
          }}
        />
      )}
      {pairingAgentId && (
        <ChannelPairing
          gateway={gateway}
          agentId={pairingAgentId}
          onClose={() => setPairingAgentId(null)}
          onPaired={() => {
            setPairingAgentId(null);
            setPickerRefreshKey((n) => n + 1);
          }}
        />
      )}
      {dragHover && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">
            <div className="drop-overlay-icon">↥</div>
            <div className="drop-overlay-title">Drop to import avatar</div>
            <div className="drop-overlay-hint">.exuvia bundle</div>
          </div>
        </div>
      )}
      {dropStatus && (
        <div className="drop-status" role="status">
          {dropStatus}
        </div>
      )}
    </div>
  );
}

function pickText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  if (typeof m.text === "string") return m.text;
  return "";
}
