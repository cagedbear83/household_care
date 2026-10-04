import { Platform } from "react-native";

/**
 * Speaking a command (the web version of the Hear screen only for now: the
 * browser's own speech recognition). On phones this is not built yet, so the
 * screen shows buttons only; nothing here ever listens in the background.
 */
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceInputSupported = () => ctor() !== null;

/** Listens for one phrase. Returns a function that cancels. */
export function listenOnce(handlers: { onText: (text: string) => void; onEnd: () => void; onError: (message: string) => void }): () => void {
  const Ctor = ctor();
  if (!Ctor) {
    handlers.onError("Voice commands are not available here. Use the buttons.");
    handlers.onEnd();
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let heard = false;
  rec.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript;
    if (text) {
      heard = true;
      handlers.onText(text);
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") handlers.onError("The microphone is not allowed. Use the buttons instead.");
    else if (e.error === "no-speech") handlers.onError("I did not hear anything. Try again or use the buttons.");
    else if (e.error !== "aborted") handlers.onError("I could not listen just now. Use the buttons instead.");
  };
  rec.onend = () => {
    if (!heard) {
      // The error handler above already explained why, if it knew.
    }
    handlers.onEnd();
  };
  try {
    rec.start();
  } catch {
    handlers.onError("I could not start listening. Use the buttons instead.");
    handlers.onEnd();
  }
  return () => {
    try {
      rec.stop();
    } catch {
      // Already stopped.
    }
  };
}
