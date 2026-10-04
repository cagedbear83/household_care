import { useSyncExternalStore } from "react";
import * as Speech from "expo-speech";
import { getItem, setItem } from "./storage";

/**
 * Reading text out loud, with a Stop that always works and a speed the person
 * chooses. The text itself is written by the server (see /summaries), so every
 * device says the same thing. One store so any screen can show "Stop" while
 * something is being read.
 */
export type SpeechSpeed = "slow" | "normal" | "fast";
export const SPEEDS: { key: SpeechSpeed; label: string; rate: number }[] = [
  { key: "slow", label: "Slow", rate: 0.7 },
  { key: "normal", label: "Normal", rate: 1 },
  { key: "fast", label: "Fast", rate: 1.4 },
];

interface SpeechState {
  speaking: boolean;
  speed: SpeechSpeed;
  /** Read new urgent alerts out loud as they arrive. Off unless the person turns it on. */
  autoUrgent: boolean;
}

let state: SpeechState = { speaking: false, speed: "normal", autoUrgent: false };
const listeners = new Set<() => void>();
let lastText: string | null = null;
let currentUser: string | null = null;

function update(next: Partial<SpeechState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const SPEED_KEY = "speech.speed";
const autoKey = (userId: string) => `speech.autoUrgent.${userId}`;

/** Loads the saved choices for whoever is signed in. */
export async function loadSpeechSettings(userId: string) {
  currentUser = userId;
  try {
    const [speed, auto] = await Promise.all([getItem(SPEED_KEY), getItem(autoKey(userId))]);
    if (currentUser !== userId) return;
    update({ speed: speed === "slow" || speed === "fast" ? speed : "normal", autoUrgent: auto === "1" });
  } catch {
    // Defaults are fine if storage is unavailable.
  }
}

export function setSpeed(speed: SpeechSpeed) {
  update({ speed });
  void setItem(SPEED_KEY, speed).catch(() => {});
}

export function setAutoUrgent(on: boolean) {
  update({ autoUrgent: on });
  if (currentUser) void setItem(autoKey(currentUser), on ? "1" : "0").catch(() => {});
}

export function stopSpeaking() {
  Speech.stop();
  update({ speaking: false });
}

export const isSpeaking = () => state.speaking;
export const autoUrgentOn = () => state.autoUrgent;
export const currentSpeed = () => state.speed;
export const lastSpoken = () => lastText;

/** Reads the text, replacing anything already being read. */
export function speak(text: string, onDone?: () => void) {
  Speech.stop();
  lastText = text;
  const rate = SPEEDS.find((s) => s.key === state.speed)?.rate ?? 1;
  const finished = () => {
    update({ speaking: false });
    onDone?.();
  };
  update({ speaking: true });
  Speech.speak(text, {
    language: "en-US",
    rate,
    onDone: finished,
    onStopped: () => update({ speaking: false }),
    onError: () => update({ speaking: false }),
  });
}

export function useSpeech(): SpeechState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state
  );
}
