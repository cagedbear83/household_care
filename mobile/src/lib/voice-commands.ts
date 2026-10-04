/**
 * Turns what someone said into one of a small set of commands. Pure and
 * forgiving about wording ("what's left", "what is left to do", "anything
 * left"), and returns null for anything else rather than guessing: a wrong
 * guess would be worse than "I did not catch that". Every command is also a
 * button on the Hear screen, so this is a convenience, never the only way.
 */
export type VoiceCommand =
  | { kind: "stop" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "repeat" }
  | { kind: "slower" }
  | { kind: "faster" }
  | { kind: "summary"; id: "briefing" | "decisions" | "completed" | "left" | "checkin" | "hours" | "shopping" | "alerts" | "messages" };

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const has = (text: string, ...phrases: string[]) => phrases.some((p) => ` ${text} `.includes(` ${p} `));

export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const t = normalize(transcript);
  if (!t) return null;

  // Short answers first, but only when that is all that was said.
  if (["stop", "quiet", "be quiet", "cancel", "enough", "hush", "shut up", "stop reading", "stop talking"].includes(t)) return { kind: "stop" };
  if (["yes", "yeah", "yep", "yes please", "sure", "ok", "okay", "please", "read it", "go ahead"].includes(t)) return { kind: "yes" };
  if (["no", "nope", "no thanks", "no thank you", "not now", "skip"].includes(t)) return { kind: "no" };
  if (["repeat", "say that again", "again", "repeat that", "say again", "what", "pardon"].includes(t)) return { kind: "repeat" };
  if (has(t, "slower", "slow down", "too fast")) return { kind: "slower" };
  if (has(t, "faster", "speed up", "too slow")) return { kind: "faster" };
  if (has(t, "stop")) return { kind: "stop" };

  // Order matters: more specific topics before the general ones.
  if (has(t, "decision", "decisions", "approve", "approval", "needs me", "need me", "waiting for me", "waiting on me", "to review")) return { kind: "summary", id: "decisions" };
  if (has(t, "alert", "alerts", "urgent", "emergency", "emergencies", "warnings")) return { kind: "summary", id: "alerts" };
  if (has(t, "message", "messages", "chat", "texts")) return { kind: "summary", id: "messages" };
  if (has(t, "shopping", "groceries", "grocery", "need to buy", "running low")) return { kind: "summary", id: "shopping" };
  if (has(t, "hours", "hour", "overtime", "how long", "36")) return { kind: "summary", id: "hours" };
  if (has(t, "checked in", "check in", "checkin", "arrive", "arrived", "arrival", "here yet", "is she here", "is he here", "is pat here", "is the ip here", "got here", "show up", "showed up")) return { kind: "summary", id: "checkin" };
  if (has(t, "left", "remaining", "still to do", "not done", "to do", "todo", "outstanding", "yet to do")) return { kind: "summary", id: "left" };
  if (has(t, "done", "completed", "finished", "accomplished", "got done", "did she do", "did he do", "what happened")) return { kind: "summary", id: "completed" };
  if (has(t, "everything", "summary", "update", "briefing", "catch me up", "full update", "how are things", "how is it going", "whats going on", "what is going on", "overview")) return { kind: "summary", id: "briefing" };

  return null;
}
