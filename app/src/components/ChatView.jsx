import React, { useEffect, useRef, useState } from "react";
import { useSession } from "../hooks/useSession.js";

export default function ChatView({ gateway, agentId, onToolCall, onMessages }) {
  const sessionKey = agentId ? `agent:${agentId}:main` : null;
  const { messages, loading, error, send } = useSession(
    gateway,
    sessionKey,
    onToolCall,
  );

  useEffect(() => {
    onMessages?.(messages);
  }, [messages, onMessages]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  if (!agentId) {
    return (
      <div className="chat">
        <div className="messages">
          <span className="muted">Pick an avatar to start chatting.</span>
        </div>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await send(text);
    } catch (err) {
      console.error("send failed", err);
    }
  };

  // Display-time dedupe. The gateway emits the same logical message
  // multiple times across event families (session.message + chat) and
  // streaming chunks for one assistant turn arrive as separate rows.
  // Collapsing here is bulletproof: regardless of how messy the
  // upstream merge is, the rendered chat only shows one bubble per
  // unique (role, displayed-text) within a contiguous run.
  const displayed = [];
  for (const m of messages) {
    const rawRole = m.role ?? "assistant";
    const role = ["user", "assistant", "tool", "system"].includes(rawRole)
      ? rawRole
      : "unknown";
    const rawText = pickText(m);
    const text = rawText ? scrubAssistantText(rawText) : "";
    if (!text) continue;
    const prev = displayed[displayed.length - 1];
    if (prev && prev.role === role) {
      // Same role as the previous displayed bubble. If the new text
      // is identical OR the new is a strict prefix-extension of the
      // previous, replace the previous (keep the longer copy). If the
      // previous is a prefix of the new, also replace.
      if (text === prev.text) continue;
      if (text.startsWith(prev.text)) {
        prev.text = text;
        prev.key = m.id ?? m.messageId ?? prev.key;
        continue;
      }
      if (prev.text.startsWith(text)) {
        // new is a shortened earlier emission of the same growing
        // message — drop it.
        continue;
      }
    }
    displayed.push({
      role,
      text,
      key: m.id ?? m.messageId ?? `i:${displayed.length}`,
    });
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {loading && <span className="muted">loading history…</span>}
        {error && <span className="muted">history error: {error}</span>}
        {displayed.map((m) => (
          <div key={m.key} className={`msg ${m.role}`}>
            {renderInlineMarkdown(m.text)}
          </div>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${agentId}…`}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function pickText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  if (typeof m.text === "string") return m.text;
  return JSON.stringify(m);
}

// Patterns that small/mid local models emit alongside the actual reply
// and that the user should never see in chat. Kept centralized so chat
// rendering, TTS, and animation parsing all strip the same way.
//
// Coverage:
//  - `[Thinking] ... <channel|>` — gemma's chain-of-thought leak
//  - `Plan:\n1. ... <channel|>` — same family, plan-flavored
//  - any leading text up to and including `<channel|>` — separator the
//    model uses between reasoning and reply
//  - `<think>...</think>` and `<tool_call>...</tool_call>` — older shapes
//  - `[play_animation: name]` — when the model writes the call as text
//    instead of emitting a structured tool call
//  - `[[reply_to_current]]`, `[[audio_as_voice]]` — internal directive
//    tokens that leak when the rewrite hook misses them
//  - parenthetical stage directions like "(Looks down...)" — the model
//    role-plays in third person; only strip when the parenthetical
//    starts with a clearly-stage-direction verb so we don't mangle real
//    parentheticals the user wrote
const SCRUB_PATTERNS = [
  // Cut everything from the start of the message up to and including the
  // first <channel|>. This handles [Thinking]/Plan blocks, raw chain-of-
  // thought, and reasoning preambles uniformly.
  /^[\s\S]*?<channel\|>\s*/i,
  /<think>[\s\S]*?<\/think>/gi,
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<function_call>[\s\S]*?<\/function_call>/gi,
  /\[play_animation:\s*[a-zA-Z0-9_-]+\s*\]/gi,
  /\[\[(?:reply_to_current|reply_to[^\]]*|audio_as_voice|[a-z_]+)\]\]/gi,
  // Stage directions, two flavors:
  //   (a) parenthetical that opens with a common acting verb
  //       — "(Stops posturing...)", "(Looks down...)"
  //   (b) parenthetical that mentions "the avatar" or "the character"
  //       anywhere inside — "(The avatar maintains a cool gaze...)".
  //       Real users never refer to the speaker that way, so this is
  //       safe to strip aggressively.
  // Conservative on (a) because real users do write parentheticals;
  // anything outside these two shapes survives.
  /\((?:looks?|stops?|stares?|straightens?|smirks?|scoffs?|rolls?|glances?|nods?|sighs?|shrugs?|leans?|tilts?|grins?|frowns?|narrows?|crosses?|gestures?|points?|maintains?|raises?|lowers?|turns?|steps?|paces?|cracks?|exhales?|inhales?|breathes?)\b[^)]*\)/gi,
  /\([^)]*\b(?:the avatar|the character)\b[^)]*\)/gi,
];

export function scrubAssistantText(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  let text = raw;
  for (const re of SCRUB_PATTERNS) {
    text = text.replace(re, "");
  }
  // Collapse runs of whitespace produced by the strips.
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Lightweight inline markdown renderer. Handles the formatting models
// actually use in chat — bold, italic, strikethrough, inline code —
// without pulling in a full markdown library. Walks the input one
// pattern at a time, splitting around the first match and recursing
// into the inner span so combinations like `**bold *italic***` work.
//
// Order matters: `**bold**` must be matched before `*italic*`, and
// `~~strike~~` before any `~` interpretation. Backticks short-circuit
// so the inside of a code span is rendered literal.
const MD_PATTERNS = [
  { re: /`([^`\n]+)`/, tag: "code" },
  { re: /\*\*([^*\n]+)\*\*/, tag: "strong" },
  { re: /__([^_\n]+)__/, tag: "strong" },
  { re: /~~([^~\n]+)~~/, tag: "del" },
  { re: /\*([^*\n]+)\*/, tag: "em" },
  { re: /(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/, tag: "em" },
];

function renderInlineMarkdown(text, keyBase = "md") {
  if (typeof text !== "string" || text.length === 0) return text;

  // Find the earliest match across all patterns.
  let earliest = null;
  for (const { re, tag } of MD_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (earliest === null || m.index < earliest.match.index) {
      earliest = { match: m, tag };
    }
  }
  if (!earliest) return text;

  const { match, tag } = earliest;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const inner = match[1];

  // For code spans we render the inside as literal — no further markdown
  // parsing inside backticks (matches CommonMark behavior).
  const innerNode =
    tag === "code" ? inner : renderInlineMarkdown(inner, `${keyBase}-i`);

  return [
    before,
    React.createElement(tag, { key: `${keyBase}-${match.index}` }, innerNode),
    renderInlineMarkdown(after, `${keyBase}-${match.index}-r`),
  ];
}
