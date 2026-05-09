import React, { useState } from "react";

// Minimal in-UI channel pairing.
//
// v1 scope: Telegram only is fully wired (BotFather token paste → write
// channels.telegram.accounts.<id>.botToken → add a binding mapping that
// account to the avatar's agentId). Other channels show CLI hints because
// their pairing flows (QR scans, OAuth, mobile apps) don't fit a paste-form.

const CLI_HINTS = {
  whatsapp: "openclaw channels login --channel whatsapp --account <id>",
  discord: "Set channels.discord.accounts.<id>.token in openclaw.json (Discord developer portal token).",
  signal: "openclaw channels login --channel signal --account <id>",
  imessage: "Configure via openclaw onboard (macOS only, requires Messages app pairing).",
  matrix: "openclaw channels login --channel matrix --account <id>",
  slack: "openclaw channels login --channel slack --account <id>",
};

export default function ChannelPairing({ gateway, agentId, onPaired, onClose }) {
  const [channel, setChannel] = useState("telegram");

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ width: 560, maxWidth: "92vw" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Bind a channel to {agentId}</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Each channel binding routes inbound messages on that channel to this
          avatar's agent. One avatar per channel account = clean isolation.
        </p>
        <label>
          <div className="muted">Channel</div>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "#15151a",
              color: "#e7e7ea",
              border: "1px solid #2a2a32",
              borderRadius: 6,
            }}
          >
            <option value="telegram">Telegram</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="discord">Discord</option>
            <option value="signal">Signal</option>
            <option value="imessage">iMessage</option>
            <option value="matrix">Matrix</option>
            <option value="slack">Slack</option>
          </select>
        </label>
        {channel === "telegram" ? (
          <TelegramPairing gateway={gateway} agentId={agentId} onPaired={onPaired} />
        ) : (
          <CliHint cmd={CLI_HINTS[channel]} />
        )}
      </div>
    </div>
  );
}

function CliHint({ cmd }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="muted">
        This channel's pairing flow runs outside the desktop app. From a terminal:
      </p>
      <pre
        style={{
          background: "#0e0e12",
          border: "1px solid #2a2a32",
          padding: 10,
          borderRadius: 6,
          fontSize: 12,
          overflowX: "auto",
        }}
      >
        {cmd}
      </pre>
      <p className="muted">
        After pairing, add a binding manually in <code>~/.openclaw/openclaw.json</code> mapping
        that account's <code>accountId</code> to this avatar's <code>agentId</code>.
      </p>
    </div>
  );
}

function TelegramPairing({ gateway, agentId, onPaired }) {
  const [accountId, setAccountId] = useState(agentId);
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!botToken.trim() || !accountId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Patch in the new Telegram account with its bot token.
      await gateway.configPatch({
        channels: {
          telegram: {
            accounts: {
              [accountId]: { botToken, dmPolicy: "pairing" },
            },
          },
        },
      });

      // 2. Add a binding from this account to our agentId. We have to read
      //    the existing bindings first so we don't clobber them — config.patch
      //    on arrays replaces wholesale.
      const cfgRes = await gateway.request("config.get", {});
      const existing = Array.isArray(cfgRes?.config?.bindings)
        ? cfgRes.config.bindings
        : [];
      const newBinding = {
        agentId,
        match: { channel: "telegram", accountId },
      };
      const alreadyBound = existing.some(
        (b) =>
          b?.agentId === agentId &&
          b?.match?.channel === "telegram" &&
          b?.match?.accountId === accountId,
      );
      const next = alreadyBound ? existing : [...existing, newBinding];
      await gateway.configPatch({ bindings: next });
      setDone(true);
      onPaired?.();
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="muted">
        ✓ paired. Try DM'ing your bot — openclaw will route the message to{" "}
        <code>{agentId}</code>.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="muted" style={{ margin: 0 }}>
        Create a bot with{" "}
        <a
          href="https://t.me/BotFather"
          onClick={(e) => {
            e.preventDefault();
            window.exuvia?.openExternal?.("https://t.me/BotFather");
          }}
        >
          @BotFather
        </a>{" "}
        on Telegram and paste the token below.
      </p>
      <label>
        <div className="muted">Account id (a label, e.g. "personal")</div>
        <input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder={agentId}
        />
      </label>
      <label>
        <div className="muted">Bot token (from BotFather)</div>
        <input
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456:ABC…"
        />
      </label>
      {error && <div style={{ color: "#ff7878" }}>error: {error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={submit} disabled={busy || !botToken.trim() || !accountId.trim()}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </div>
    </div>
  );
}
