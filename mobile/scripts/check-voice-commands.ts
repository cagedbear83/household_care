import assert from "node:assert/strict";
import { parseVoiceCommand } from "../src/lib/voice-commands.ts";

const cases: [string, unknown][] = [
  ["Stop", { kind: "stop" }],
  ["stop reading!", { kind: "stop" }],
  ["Yes please", { kind: "yes" }],
  ["No thanks.", { kind: "no" }],
  ["say that again", { kind: "repeat" }],
  ["slow down", { kind: "slower" }],
  ["a bit faster please", { kind: "faster" }],
  ["What needs my decision?", { kind: "summary", id: "decisions" }],
  ["anything waiting for me", { kind: "summary", id: "decisions" }],
  ["Read my alerts", { kind: "summary", id: "alerts" }],
  ["is there anything urgent", { kind: "summary", id: "alerts" }],
  ["do I have any messages", { kind: "summary", id: "messages" }],
  ["what's on the shopping list", { kind: "summary", id: "shopping" }],
  ["how many hours has she worked", { kind: "summary", id: "hours" }],
  ["did she check in", { kind: "summary", id: "checkin" }],
  ["is Pat here yet", { kind: "summary", id: "checkin" }],
  ["What's left to do today?", { kind: "summary", id: "left" }],
  ["what is left", { kind: "summary", id: "left" }],
  ["what was completed today", { kind: "summary", id: "completed" }],
  ["what got done", { kind: "summary", id: "completed" }],
  ["give me a full update", { kind: "summary", id: "briefing" }],
  ["catch me up", { kind: "summary", id: "briefing" }],
  ["", null],
  ["purple elephant", null],
  ["the weather", null],
];
let failed = 0;
for (const [said, expected] of cases) {
  try {
    assert.deepEqual(parseVoiceCommand(said), expected);
  } catch {
    failed++;
    console.error(`FAIL: "${said}" -> ${JSON.stringify(parseVoiceCommand(said))}, expected ${JSON.stringify(expected)}`);
  }
}
if (failed) process.exit(1);
console.log(`voice commands: ${cases.length} ok`);
