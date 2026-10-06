import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  answerCheckIn,
  getCheckInPlans,
  getDueCheckIns,
  pauseCheckIn,
  skipCheckIn,
  type CheckInPlan,
  type CheckInResult,
  type DueCheckIn,
} from "@/lib/api";
import { speak, stopSpeaking, useSpeech } from "@/lib/speech";
import { HomeBar } from "@/components/HomeBar";

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");
const EVERY: Record<number, string> = { 1: "every day", 2: "every 2 days", 3: "every 3 days" };
const NAME = { PHQ2: "Mood check-in", GAD2: "Worry check-in" } as const;

/**
 * The client's check-in: big answer buttons, and a "Read it to me" button.
 * Only the client (and the primary family member, who has the client's access)
 * sees this. What comes back is a kind message, never a score.
 */
export default function CheckInScreen() {
  const { token, user } = useAuth();
  const speech = useSpeech();
  const [due, setDue] = useState<DueCheckIn[] | null>(null);
  const [plans, setPlans] = useState<CheckInPlan[]>([]);
  const [picked, setPicked] = useState<Record<string, (number | null)[]>>({});
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || user?.role !== "CLIENT") return;
    try {
      const [d, p] = await Promise.all([getDueCheckIns(token), getCheckInPlans(token)]);
      setDue(d.due);
      setPlans(p.plans);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [token, user?.role]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
      return () => stopSpeaking();
    }, [load])
  );

  const current = due?.[0] ?? null;
  // Answers are kept per check-in, so moving to the next one starts clean.
  const answers: (number | null)[] = current ? (picked[current.instrument] ?? current.questions.map(() => null)) : [];

  if (user && user.role !== "CLIENT") return <Redirect href="/home" />;
  if (!due) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading" />}
      </View>
    );
  }

  const readAloud = () => {
    if (!current) return;
    const parts = [current.intro, ...current.questions.map((q, i) => `Question ${i + 1}. ${q}.`), `Your choices are: ${current.options.map((o) => o.label).join(", ")}.`];
    speak(parts.join(" "));
  };

  async function save() {
    if (!token || !current || answers.some((a) => a === null)) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await answerCheckIn(token, current.instrument, answers as number[]));
      setPicked((p) => ({ ...p, [current.instrument]: current.questions.map(() => null) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function notToday() {
    if (!token || !current) return;
    setBusy(true);
    setError(null);
    try {
      await skipCheckIn(token, current.instrument);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    stopSpeaking();
    setResult(null);
    await load();
  }

  async function togglePause(plan: CheckInPlan) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await pauseCheckIn(token, plan.instrument, plan.active);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <HomeBar />

      {result ? (
        <View style={styles.card} accessibilityLiveRegion="polite">
          <Text style={styles.title} accessibilityRole="header">
            {result.flagged ? "Thank you" : "All done"}
          </Text>
          <Text style={styles.body}>{result.message}</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Read this to me" onPress={() => (speech.speaking ? stopSpeaking() : speak(result.message))} style={styles.outline}>
              <Text style={styles.outlineText}>{speech.speaking ? "Stop reading" : "Read it to me"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Continue" onPress={next} style={styles.primary}>
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      ) : current ? (
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            {current.title}
          </Text>
          <Text style={styles.body}>{current.intro}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Read the questions to me" onPress={() => (speech.speaking ? stopSpeaking() : readAloud())} style={styles.outline}>
            <Text style={styles.outlineText}>{speech.speaking ? "Stop reading" : "Read it to me"}</Text>
          </Pressable>

          {current.questions.map((q, qi) => (
            <View key={q} style={styles.question}>
              <Text style={styles.qText}>
                {qi + 1}. {q}
              </Text>
              {current.options.map((o) => {
                const selected = answers[qi] === o.value;
                return (
                  <Pressable
                    key={o.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${q}: ${o.label}`}
                    onPress={() => setPicked((p) => ({ ...p, [current.instrument]: answers.map((v, i) => (i === qi ? o.value : v)) }))}
                    style={[styles.answer, selected && styles.answerSelected]}
                  >
                    <Text style={[styles.answerText, selected && styles.answerTextSelected]}>{selected ? `✓ ${o.label}` : o.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Text style={styles.small}>Your answers are shared with your case manager. This is not a test, and it does not replace talking with a doctor.</Text>
          {error && (
            <Text style={styles.error} role="alert">
              {error}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save my answers"
              disabled={busy || answers.some((a) => a === null)}
              onPress={save}
              style={[styles.primary, (busy || answers.some((a) => a === null)) && styles.disabled]}
            >
              <Text style={styles.primaryText}>{busy ? "Saving…" : "Save my answers"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Not today" disabled={busy} onPress={notToday} style={styles.outline}>
              <Text style={styles.outlineText}>Not today</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">
            Nothing to answer right now
          </Text>
          <Text style={styles.body}>{plans.length === 0 ? "No check-ins are set up." : "You are all caught up. The next check-in will show here when it is due."}</Text>
        </View>
      )}

      {plans.length > 0 && !result && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Your check-ins
          </Text>
          {plans.map((p) => (
            <View key={p.instrument} style={styles.planRow}>
              <View style={styles.planText}>
                <Text style={styles.qText}>{NAME[p.instrument]}</Text>
                <Text style={styles.small}>{p.active ? `Asked ${EVERY[p.everyDays] ?? `every ${p.everyDays} days`}` : "Paused"}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`${p.active ? "Pause" : "Resume"} the ${NAME[p.instrument]}`} disabled={busy} onPress={() => togglePause(p)} style={styles.outline}>
                <Text style={styles.outlineText}>{p.active ? "Pause" : "Resume"}</Text>
              </Pressable>
            </View>
          ))}
          <Text style={styles.small}>Your case manager sets up the check-ins. You can pause one at any time.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 40, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 12, padding: 14, gap: 12, backgroundColor: "#fff" },
  title: { fontSize: 26, fontWeight: "800", color: "#1a1a1a" },
  sectionTitle: { fontSize: 20, fontWeight: "800", color: "#1a1a1a" },
  body: { fontSize: 18, color: "#222", lineHeight: 26 },
  small: { fontSize: 15, color: "#444", lineHeight: 21 },
  error: { color: "#a1130f", fontSize: 16, fontWeight: "600" },
  question: { gap: 8, marginTop: 4 },
  qText: { fontSize: 19, fontWeight: "700", color: "#111" },
  answer: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, minHeight: 56, justifyContent: "center", backgroundColor: "#fff" },
  answerSelected: { backgroundColor: "#0b5fff", borderColor: "#0b5fff" },
  answerText: { fontSize: 19, fontWeight: "700", color: "#1a1a1a" },
  answerTextSelected: { color: "#fff" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  planRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 10 },
  planText: { flexShrink: 1, gap: 2 },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 10, paddingVertical: 14, paddingHorizontal: 22, minHeight: 56, justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18, minHeight: 52, justifyContent: "center" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 17 },
});
