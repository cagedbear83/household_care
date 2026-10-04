import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, getSummaries, type SummaryDto, type SummaryId } from "@/lib/api";
import { currentSpeed, lastSpoken, setAutoUrgent, setSpeed, SPEEDS, speak, stopSpeaking, useSpeech } from "@/lib/speech";
import { parseVoiceCommand, type VoiceCommand } from "@/lib/voice-commands";
import { listenOnce, voiceInputSupported } from "@/lib/voice-input";
import { HomeBar } from "@/components/HomeBar";
import { Chip } from "@/components/Chip";

const ORDER: SummaryId[] = ["alerts", "decisions", "left", "completed", "checkin", "hours", "shopping", "messages"];

interface Asking {
  title: string;
  question: string;
  text: string;
}

export default function HearScreen() {
  const { token, user } = useAuth();
  const speech = useSpeech();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const [summaries, setSummaries] = useState<SummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SummaryId | null>(null);
  const [now, setNow] = useState<{ title: string; text: string } | null>(null);
  // A "would you like me to read it?" question waiting for a yes or a no.
  const [asking, setAskingState] = useState<Asking | null>(null);
  // Voice commands arrive from a callback that outlives renders, so it reads the question from a ref.
  const askingRef = useRef<Asking | null>(null);
  const setAsking = useCallback((value: Asking | null) => {
    askingRef.current = value;
    setAskingState(value);
  }, []);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const voice = voiceInputSupported();

  const load = useCallback(async () => {
    if (!token) return null;
    try {
      const result = (await getSummaries(token)).summaries;
      setSummaries(result);
      setError(null);
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the update. Check your connection.");
      return null;
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  // Leaving the screen stops the reading and the microphone.
  useEffect(
    () => () => {
      stopSpeaking();
      stopListening.current?.();
    },
    []
  );

  if (user?.role === "IP") return <Redirect href="/" />;

  async function play(id: SummaryId) {
    setBusy(id);
    setAsking(null);
    try {
      const fresh = (await load()) ?? summaries;
      const s = fresh?.find((x) => x.id === id);
      if (!s) {
        const text = "That update is not available for you.";
        setNow({ title: "Not available", text });
        speak(text);
        return;
      }
      if (s.askFirst && !s.empty) {
        // Asked first, as agreed: the list is only read after a yes.
        setAsking({ title: s.title, question: s.askFirst, text: s.text });
        setNow({ title: s.title, text: s.askFirst });
        speak(s.askFirst);
        return;
      }
      setNow({ title: s.title, text: s.text });
      speak(s.text);
    } finally {
      setBusy(null);
    }
  }

  function answerYes() {
    const question = askingRef.current;
    if (!question) return;
    setNow({ title: question.title, text: question.text });
    speak(question.text);
    setAsking(null);
  }

  function answerNo() {
    setAsking(null);
    setNow(null);
    stopSpeaking();
  }

  function run(cmd: VoiceCommand) {
    switch (cmd.kind) {
      case "stop":
        stopSpeaking();
        setAsking(null);
        break;
      case "yes":
        if (askingRef.current) answerYes();
        else speak("There is nothing to say yes to right now.");
        break;
      case "no":
        if (askingRef.current) answerNo();
        else speak("Okay.");
        break;
      case "repeat": {
        const text = lastSpoken();
        if (text) speak(text);
        else speak("I have not read anything yet.");
        break;
      }
      case "slower":
        setSpeed(currentSpeed() === "fast" ? "normal" : "slow");
        speak("Okay, slower.");
        break;
      case "faster":
        setSpeed(currentSpeed() === "slow" ? "normal" : "fast");
        speak("Okay, faster.");
        break;
      case "summary":
        void play(cmd.id);
        break;
    }
  }

  function startVoice() {
    stopSpeaking(); // so the microphone does not hear the reading
    setHeard(null);
    setVoiceNote(null);
    setListening(true);
    stopListening.current = listenOnce({
      onText: (text) => {
        setHeard(text);
        const cmd = parseVoiceCommand(text);
        if (cmd) run(cmd);
        else setVoiceNote("I did not catch that. You can say: full update, what needs my decision, what is left, or stop. Or use the buttons.");
      },
      onEnd: () => setListening(false),
      onError: (message) => setVoiceNote(message),
    });
  }

  const byId = new Map((summaries ?? []).map((s) => [s.id, s]));
  const buttons = ORDER.filter((id) => byId.has(id));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Hear an update
      </Text>
      <Text style={styles.help}>Pick what you would like to hear. It is also shown in writing below. Tap Stop at any time.</Text>

      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop reading"
        accessibilityState={{ disabled: !speech.speaking }}
        onPress={stopSpeaking}
        style={[styles.stop, !speech.speaking && styles.stopIdle]}
      >
        <Text style={[styles.stopText, !speech.speaking && styles.stopIdleText]}>{speech.speaking ? "■ Stop reading" : "■ Stop (not reading now)"}</Text>
      </Pressable>

      {!summaries && !error && <ActivityIndicator size="large" accessibilityLabel="Loading" />}

      {summaries && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hear the full update"
            onPress={() => play("briefing")}
            disabled={busy !== null}
            style={styles.big}
          >
            <Text style={styles.bigText}>{busy === "briefing" ? "Getting it…" : "Hear the full update"}</Text>
          </Pressable>

          <Text style={styles.section} accessibilityRole="header">
            Or choose one thing
          </Text>
          <View style={styles.grid}>
            {buttons.map((id) => {
              const s = byId.get(id)!;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={`Hear: ${s.title}`}
                  onPress={() => play(id)}
                  disabled={busy !== null}
                  style={styles.option}
                >
                  <Text style={styles.optionText}>{busy === id ? "Getting it…" : s.title}</Text>
                  {!s.empty && <Text style={styles.dot}>●</Text>}
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.small}>A ● means there is something to hear.</Text>
        </>
      )}

      {asking && (
        <View style={styles.ask} accessibilityLiveRegion="polite">
          <Text style={styles.askText}>{asking.question}</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Yes, read it" onPress={answerYes} style={styles.yes}>
              <Text style={styles.yesText}>Yes, read it</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="No, do not read it" onPress={answerNo} style={styles.no}>
              <Text style={styles.noText}>No</Text>
            </Pressable>
          </View>
        </View>
      )}

      {now && !asking && (
        <View style={styles.now} accessibilityLiveRegion="polite">
          <Text style={styles.nowTitle}>{speech.speaking ? "Reading now: " : "Last read: "}{now.title}</Text>
          <Text style={styles.nowText}>{now.text}</Text>
        </View>
      )}

      <Text style={styles.section} accessibilityRole="header">
        Reading speed
      </Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {SPEEDS.map((s) => (
          <Chip key={s.key} label={s.label} selected={speech.speed === s.key} onPress={() => setSpeed(s.key)} />
        ))}
      </View>

      {staff && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Urgent alerts
          </Text>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: speech.autoUrgent }}
            aria-checked={speech.autoUrgent}
            accessibilityLabel="Read new urgent alerts aloud"
            onPress={() => setAutoUrgent(!speech.autoUrgent)}
            style={styles.toggle}
          >
            <Text style={styles.toggleLabel}>Read new urgent alerts aloud</Text>
            <Text style={[styles.toggleState, speech.autoUrgent && styles.toggleOn]}>{speech.autoUrgent ? "On" : "Off"}</Text>
          </Pressable>
          <Text style={styles.small}>When this is on, a new urgent alert is read out as soon as the app sees it. The app has to be open. It is off unless you turn it on.</Text>
        </>
      )}

      <Text style={styles.section} accessibilityRole="header">
        Say a command
      </Text>
      {voice ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={listening ? "Listening" : "Speak a command"}
            onPress={() => (listening ? stopListening.current?.() : startVoice())}
            style={[styles.option, listening && styles.listening]}
          >
            <Text style={styles.optionText}>{listening ? "Listening… tap to cancel" : "Speak a command"}</Text>
          </Pressable>
          <Text style={styles.small}>Try: “full update”, “what needs my decision”, “what is left”, “read my alerts”, “stop”. The microphone is only on after you tap, and stops by itself.</Text>
          {heard && <Text style={styles.small}>I heard: “{heard}”</Text>}
          {voiceNote && (
            <Text style={styles.small} accessibilityLiveRegion="polite">
              {voiceNote}
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.small}>Speaking commands is not available on this device yet. Everything here works with the buttons.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 110, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: "#1a1a1a" },
  help: { fontSize: 16, color: "#333", lineHeight: 22 },
  section: { fontSize: 18, fontWeight: "700", color: "#1a1a1a", marginTop: 8 },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  error: { color: "#a1130f", fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  stop: { backgroundColor: "#a1130f", borderRadius: 10, minHeight: 60, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  stopIdle: { backgroundColor: "#fff", borderWidth: 2, borderColor: "#999" },
  stopText: { color: "#fff", fontSize: 20, fontWeight: "800" },
  stopIdleText: { color: "#555", fontSize: 16, fontWeight: "700" },
  big: { backgroundColor: "#1a1a1a", borderRadius: 10, minHeight: 64, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  bigText: { color: "#fff", fontSize: 20, fontWeight: "800" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { flexGrow: 1, flexBasis: "45%", flexDirection: "row", gap: 8, borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, minHeight: 56, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, paddingVertical: 10 },
  optionText: { fontSize: 17, fontWeight: "700", color: "#1a1a1a", textAlign: "center" },
  dot: { fontSize: 14, color: "#a1130f" },
  listening: { backgroundColor: "#fff4f3", borderColor: "#a1130f" },
  ask: { borderWidth: 3, borderColor: "#1a1a1a", borderRadius: 10, padding: 14, gap: 10, backgroundColor: "#fffbe6" },
  askText: { fontSize: 18, fontWeight: "700", color: "#1a1a1a", lineHeight: 24 },
  yes: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 14, paddingHorizontal: 24, minHeight: 52, justifyContent: "center" },
  yesText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  no: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 14, paddingHorizontal: 24, minHeight: 52, justifyContent: "center" },
  noText: { color: "#1a1a1a", fontSize: 18, fontWeight: "800" },
  now: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 14, gap: 6, backgroundColor: "#f4f4f4" },
  nowTitle: { fontSize: 16, fontWeight: "700", color: "#1a1a1a" },
  nowText: { fontSize: 17, color: "#222", lineHeight: 24 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10 },
  toggleLabel: { flex: 1, fontSize: 17, fontWeight: "700", color: "#1a1a1a" },
  toggleState: { fontSize: 17, fontWeight: "800", color: "#555", borderWidth: 2, borderColor: "#999", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 4, overflow: "hidden" },
  toggleOn: { color: "#fff", backgroundColor: "#2d6a2d", borderColor: "#2d6a2d" },
});
