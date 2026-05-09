import React, { useCallback, useEffect, useState } from "react";

// SVG icon — Feather-ish lock. Two paths: shackle (bow) on top, body
// underneath. `locked=false` opens the shackle so the same component
// renders both states with one boolean.
export function LockIcon({ locked, size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {locked ? (
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      ) : (
        <path d="M8 11V7a4 4 0 0 1 8 0" />
      )}
    </svg>
  );
}

// Bottom-center drawer. Toggle button beside the chat bar flips it open.
// A thin top bar (camera lock) is always visible across both views.
// Default view: vertical list of agents, each row = pill (select) +
// ⚙ (settings, active only) + × (delete with inline confirm), and a
// +new-avatar action pinned to the bottom.
// When `settingsView` is provided, the drawer renders that below the
// top bar instead of the avatar list.
export default function AgentPicker({
  gateway,
  activeAgentId,
  onSelect,
  onCreateRequested,
  onSettingsRequested,
  refreshKey,
  open,
  settingsView,
}) {
  const [agents, setAgents] = useState([]);
  const [exuviaIds, setExuviaIds] = useState(new Set());
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  // Drawer height — user-resizable via the top-edge drag handle.
  // Persisted across sessions so the chosen height survives reopens.
  const [height, setHeight] = useState(() => {
    try {
      const raw = localStorage.getItem("exuvia.picker.height");
      const n = raw ? Number(raw) : null;
      if (Number.isFinite(n) && n >= 200 && n <= 1200) return n;
    } catch {
      /* ignore */
    }
    return 420;
  });
  useEffect(() => {
    try {
      localStorage.setItem("exuvia.picker.height", String(height));
    } catch {
      /* ignore */
    }
  }, [height]);

  // Drag the top edge to resize. Pulling up grows the drawer (anchored
  // at bottom). Clamped to a usable range so it can't be hidden or
  // grown past the viewport.
  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const next = Math.min(
        Math.max(220, startH - dy),
        window.innerHeight - 100,
      );
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const refresh = useCallback(async () => {
    if (gateway.status !== "connected") return;
    setError(null);
    try {
      const [agentsResult, configResult] = await Promise.all([
        gateway.request("agents.list", {}),
        gateway.request("config.get", {}).catch(() => null),
      ]);
      const list =
        agentsResult?.agents ??
        agentsResult?.list ??
        agentsResult ??
        [];
      console.log("[picker] agents.list ->", list);
      setAgents(Array.isArray(list) ? list : []);
      const root = configResult?.config ?? configResult ?? {};
      const avatarsMap =
        root?.plugins?.entries?.exuvia?.config?.avatars ?? {};
      setExuviaIds(new Set(Object.keys(avatarsMap)));
    } catch (err) {
      setError(err.message ?? String(err));
    }
  }, [gateway]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  // In-flight guard against double-fires from React Strict Mode and from
  // accidental rapid clicks. Each id is processed at most once concurrently.
  const inFlightRef = React.useRef(new Set());

  const deleteAgent = async (id) => {
    if (inFlightRef.current.has(id)) {
      console.warn(`[picker] delete already in flight for ${id}, ignoring duplicate`);
      return;
    }
    inFlightRef.current.add(id);
    setDeletingId(id);
    try {
      // Step 1: clear the sidecar config — only if there's actually something
      // to clear. Avoids hitting the rate limiter on ghost avatars (sidecar
      // missing but picker still showing a stale row) and on agents that
      // never had an exuvia sidecar in the first place.
      let hasSidecar = exuviaIds.has(id);
      if (hasSidecar) {
        try {
          await gateway.configPatch({
            plugins: {
              entries: {
                exuvia: {
                  config: { avatars: { [id]: null } },
                },
              },
            },
          });
        } catch (err) {
          console.warn("[picker] sidecar clear failed", err);
        }
      }
      // Step 2: delete the agent record via the gateway. "not found" is
      // expected for orphaned agents (workspace folder exists on disk but no
      // entry in cfg.agents.list). agents.list discovers agents by walking
      // workspace folders, so the only way to make a stale agent stop
      // reappearing is to remove the workspace directory itself — which we
      // do as Step 3 below.
      let agentWasNotFound = false;
      try {
        await gateway.request("agents.delete", { agentId: id });
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (!/not found/i.test(msg)) throw err;
        agentWasNotFound = true;
        console.warn(`[picker] agents.delete: ${msg} (orphan; will remove workspace dir)`);
      }
      // Step 3: if the agent was an orphan, tear down BOTH on-disk locations
      // claw uses to discover agents:
      //   - workspace dir (~/.openclaw/workspace/<id>) — files, AGENTS.md, etc.
      //   - state dir    (~/.openclaw/agents/<id>)    — sessions, auth profiles
      // agents.list reports an agent as long as either exists, so removing
      // just one isn't enough.
      if (agentWasNotFound && window.exuvia?.dir?.remove) {
        const row = agents.find((a) => (a.id ?? a.agentId ?? a.name) === id);
        const ws = row?.workspace ?? row?.workspaceDir;
        const home = await window.exuvia.path.expand("~");
        const stateDir = `${home}/.openclaw/agents/${id}`.replace(/\\/g, "/");
        const targets = [ws, stateDir].filter(Boolean);
        for (const target of targets) {
          const res = await window.exuvia.dir.remove(target);
          if (!res?.ok) {
            console.warn(`[picker] dir remove failed for ${target}: ${res?.error ?? "?"}`);
          } else {
            console.log(`[picker] removed: ${res.path}`);
          }
        }
      }
      setConfirmDeleteId(null);
      if (id === activeAgentId) onSelect(null);
      refresh();
    } catch (err) {
      console.error("[picker] delete failed", err);
      setError(err?.message ?? String(err));
    } finally {
      inFlightRef.current.delete(id);
      setDeletingId(null);
    }
  };

  const resizeHandle = (
    <div
      className="picker-resize"
      onPointerDown={startResize}
      title="drag to resize"
    />
  );

  if (settingsView) {
    return (
      <aside
        className={`picker ${open ? "open" : ""}`}
        aria-hidden={!open}
        style={{ height: `${height}px` }}
      >
        {resizeHandle}
        <div className="picker-body picker-body-settings">{settingsView}</div>
      </aside>
    );
  }

  return (
    <aside
      className={`picker ${open ? "open" : ""}`}
      aria-hidden={!open}
      style={{ height: `${height}px` }}
    >
      {resizeHandle}
      <div className="picker-body">
      <div className="picker-section-title">avatars</div>

      {error && <div className="muted" style={{ color: "#ff9a9a" }}>{error}</div>}
      {agents.length === 0 && (
        <div className="muted" style={{ padding: "6px 2px" }}>no agents yet</div>
      )}

      {agents.map((a) => {
        const id = a.id ?? a.agentId ?? a.name;
        if (!id) return null;
        const label = a.name ?? a.label ?? id;
        const isExuvia = exuviaIds.has(id);
        const active = id === activeAgentId;
        const confirming = confirmDeleteId === id;
        const deleting = deletingId === id;
        return (
          <div className="picker-row" key={id}>
            <button
              className={`agent-pill ${active ? "active" : ""}`}
              onClick={() => onSelect(id)}
              title={isExuvia ? "exuvia avatar" : "plain claw agent"}
            >
              {isExuvia ? "" : "• "}
              {label}
            </button>
            {active && (
              <button
                className="agent-pill picker-action"
                onClick={() => onSettingsRequested?.(id)}
                title="settings"
              >
                ⚙
              </button>
            )}
            {confirming ? (
              <>
                <button
                  className="agent-pill picker-action"
                  onClick={() => deleteAgent(id)}
                  disabled={deleting}
                  title={`confirm delete ${id}`}
                  style={{ borderColor: "#7a3a3a", color: "#ff9a9a" }}
                >
                  {deleting ? "…" : "✓"}
                </button>
                <button
                  className="agent-pill picker-action"
                  onClick={() => setConfirmDeleteId(null)}
                  disabled={deleting}
                  title="cancel"
                >
                  ⨯
                </button>
              </>
            ) : (
              <button
                className="agent-pill picker-action"
                onClick={() => setConfirmDeleteId(id)}
                title={`delete ${id}`}
                style={{ color: "var(--text-muted)" }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      <button
        className="agent-pill picker-create"
        onClick={onCreateRequested}
        disabled={gateway.status !== "connected"}
      >
        + new avatar
      </button>
      </div>
    </aside>
  );
}
