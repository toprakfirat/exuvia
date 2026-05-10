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

// Cooldown per (agent, animation) so the model can't fire `dance` three turns
// in a row. The factory rebuilds the tool every turn, so this state lives at
// module scope. Keyed by `${agentId}:${name.toLowerCase()}` -> last fire ms.
const lastFireAt = new Map<string, number>();
const COOLDOWN_MS = 8_000;

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
  //
  // The "trigger guide" maps common clip names to the conversational cues
  // that should fire them. Local catalogues often have bare names (just
  // `wave`, `dance`) without descriptions, so this guide is what lets
  // the model still pick the right clip from the user's intent. The
  // model only ever picks names that are present in the catalogue
  // section below — names in the guide that aren't listed are ignored.
  const description =
    catalogueText.length > 0
      ? [
          "Play one animation clip on the avatar to physically express the current reply.",
          "",
          "DECIDE EVERY TURN whether an animation fits. The avatar should feel alive: when",
          "the message naturally calls for a gesture, play it. When it doesn't, stay still.",
          "",
          "Pick a clip when ANY of these hold:",
          "  - The user greets, says hi/hello/hey/yo/sup/hii — play a greeting clip (wave).",
          "  - The user says bye/goodbye/cya/later — play a greeting clip (wave).",
          "  - The user asks the avatar to do an action that matches a clip (\"dance\",",
          "    \"wave\", \"point at it\") — play that clip.",
          "  - The avatar is excited, celebrating, or playful — play `dance` if listed.",
          "  - The avatar is annoyed, irritated, frustrated, or rolling its eyes — play",
          "    `annoyed` if listed.",
          "  - The avatar is being affectionate, flirty, or saying goodnight — play",
          "    `blowkiss` if listed.",
          "  - The avatar is pointing something out, calling attention, or directing the",
          "    user — play `point` if listed.",
          "",
          "Do NOT play a clip when:",
          "  - The reply is a neutral information answer with no emotional or physical beat.",
          "  - No listed clip clearly fits — reply with words only.",
          "  - You already played the same clip in the immediately previous turn unless the",
          "    user explicitly asked again.",
          "",
          "Use exactly one clip name from the list below, spelled exactly. Never invent",
          "names. If none fit, simply skip the tool call.",
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

      // Cooldown: same agent + same clip within COOLDOWN_MS is suppressed.
      // The model occasionally re-fires the same clip on consecutive turns
      // when the conversation stays in the same emotional beat (excited →
      // dance → still excited → dance again). The cooldown prevents the
      // visual repetition without blocking re-asks like "do it again" from
      // re-firing after the cooldown elapses. Different clips on the same
      // agent are unaffected.
      const cooldownKey = `${agentId ?? "?"}:${name.toLowerCase()}`;
      const now = Date.now();
      const lastAt = lastFireAt.get(cooldownKey) ?? 0;
      const remaining = COOLDOWN_MS - (now - lastAt);
      if (remaining > 0) {
        log(
          `play_animation suppressed (cooldown): agent=${agentId ?? "?"} ` +
            `name=${name} remainingMs=${remaining}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `(skipped ${name}: same animation played ${Math.round((now - lastAt) / 1000)}s ago, cooling down)`,
            },
          ],
          details: {
            animation: null,
            agentId,
            hasMedia: false,
            cooldown: true,
            requested: name,
          },
        };
      }
      lastFireAt.set(cooldownKey, now);

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
