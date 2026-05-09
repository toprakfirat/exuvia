import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

const PlayAnimationSchema = Type.Object({
  name: Type.String({
    description: "Animation clip name from this avatar's catalogue.",
  }),
});

export type AnimationCatalogueEntry = {
  name: string;
  description?: string;
  tags?: string[];
  loop?: boolean;
  durationMs?: number;
  gifPath?: string;
};

export function createPlayAnimationTool(opts: {
  agentId?: string;
  animations?: AnimationCatalogueEntry[];
  log: (msg: string) => void;
}): AnyAgentTool {
  const { agentId, animations, log } = opts;
  const catalogueText = (animations ?? [])
    .map((a) => {
      const tags = a.tags?.length ? ` [${a.tags.join(", ")}]` : "";
      const desc = a.description ? ` — ${a.description}` : "";
      return `- ${a.name}${tags}${desc}`;
    })
    .join("\n");

  // Tool description reaches the model as part of the schema. We want it
  // to call this on turns where a clip in the catalogue genuinely fits
  // the message, and skip it otherwise — not call it on every turn, not
  // refuse when a fit exists. The catalogue is included verbatim so the
  // model has explicit candidates to match against.
  const description =
    catalogueText.length > 0
      ? [
          "Play one animation clip on the avatar to physically express the current reply.",
          "",
          "Decision rule: call this tool ONLY when one of the listed clips clearly fits",
          "what the avatar is saying or doing in this turn (e.g. user asks for a wave",
          "and `wave` is available; reply is excited and `dance` is available).",
          "If no listed clip fits, do NOT call the tool — reply with words alone.",
          "Never invent clip names. Use exactly one of the names below, or none.",
          "",
          "Available animations:",
          catalogueText,
        ].join("\n")
      : [
          "Play one animation clip on the avatar.",
          "No clips are configured for this avatar — do NOT call this tool.",
        ].join("\n");

  return {
    label: "Play animation",
    name: "play_animation",
    description,
    parameters: PlayAnimationSchema,
    execute: async (_toolCallId, args) => {
      const params = args as { name?: unknown };
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!name) {
        return {
          content: [{ type: "text" as const, text: "play_animation: name required" }],
          details: { animation: null, agentId, hasMedia: false, error: "name required" },
        };
      }
      log(`play_animation fired: agent=${agentId ?? "?"} name=${name}`);

      // Look up the matching catalogue entry — case-insensitive — to find a
      // pre-rendered gif if the user has baked one. Channel adapters that
      // support media (Telegram, Discord, WhatsApp, iMessage) will deliver it;
      // text-only channels strip media gracefully.
      const entry = (animations ?? []).find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      const text = `(played ${name})`;
      const lines: string[] = [text];
      if (entry?.gifPath) {
        // MEDIA: directive — local absolute or ~/ paths are supported.
        lines.push(`MEDIA: ${entry.gifPath}`);
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { animation: name, agentId, hasMedia: Boolean(entry?.gifPath) },
      };
    },
  };
}
