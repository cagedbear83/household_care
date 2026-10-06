import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, getCheckInHistory, getCheckInPlans, setCheckInPlan, type CheckInHistoryRow, type CheckInInstrument, type CheckInPlan } from "@/lib/api";
import { formatDay } from "@/lib/dates";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");

const INSTRUMENTS: { key: CheckInInstrument; name: string; about: string }[] = [
  { key: "PHQ2", name: "PHQ-2 (mood)", about: "Two questions about low mood and loss of interest. A total of 3 or more out of 6 is the usual sign to follow up." },
  { key: "GAD2", name: "GAD-2 (anxiety)", about: "Two questions about nervousness and worry. A total of 3 or more out of 6 is the usual sign to follow up." },
];
const EVERY = [
  { days: 1, label: "Every day" },
  { days: 2, label: "Every 2 days" },
  { days: 3, label: "Every 3 days" },
];

/**
 * For administrators only: set up which check-ins the client gets and how
 * often, and read the answers. Nobody else can see the answers, and the IP can
 * see nothing about this at all.
 */
export default function WellbeingScreen() {
  const { token, user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [plans, setPlans] = useState<CheckInPlan[] | null>(null);
  const [rows, setRows] = useState<CheckInHistoryRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      const [p, h] = await Promise.all([getCheckInPlans(token), getCheckInHistory(token, 60)]);
      setPlans(p.plans);
      setRows(h.responses);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [token, isAdmin]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (user && !isAdmin) return <Redirect href="/home" />;
  if (!plans) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading" />}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Wellbeing check-ins
      </Text>
      <Text style={styles.small}>
        Short screening questions, not a diagnosis and not an emergency service. Only administrators can read the answers. The IP cannot see any of this, and no message or log entry ever contains an answer or a score.
      </Text>
      {notice && (
        <Text style={styles.ok} accessibilityLiveRegion="polite">
          ✓ {notice}
        </Text>
      )}
      {loadError && <Text style={styles.error}>{loadError}</Text>}

      {INSTRUMENTS.map((inst) => (
        <PlanCard
          key={`${inst.key}-${plans.find((p) => p.instrument === inst.key)?.everyDays ?? "new"}`}
          inst={inst}
          plan={plans.find((p) => p.instrument === inst.key) ?? null}
          token={token!}
          onSaved={async (text) => {
            setNotice(text);
            await load();
          }}
        />
      ))}

      <View style={styles.card}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Recent answers
        </Text>
        <Text style={styles.small}>The last 60 days. “Needs follow-up” means the total was 3 or more.</Text>
        {rows.length === 0 && <Text style={styles.small}>No answers yet.</Text>}
        {rows.map((r) => (
          <View key={r.id} style={styles.item}>
            <Text style={styles.itemTitle}>
              {formatDay(r.localDate)} · {r.instrument === "PHQ2" ? "PHQ-2" : "GAD-2"}
            </Text>
            {r.skipped ? (
              <Text style={styles.small}>Skipped (“Not today”)</Text>
            ) : (
              <Text style={styles.body}>
                Total {r.score} of 6 (answers {r.answers.join(" and ")}){r.flagged ? " · Needs follow-up" : ""}
              </Text>
            )}
            <Text style={styles.small}>Answered by {r.answeredBy ?? "someone"}{r.answeredByRole === "FAMILY" ? " (primary family member)" : ""}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function PlanCard({
  inst,
  plan,
  token,
  onSaved,
}: {
  inst: { key: CheckInInstrument; name: string; about: string };
  plan: CheckInPlan | null;
  token: string;
  onSaved: (text: string) => Promise<void>;
}) {
  const [everyDays, setEveryDays] = useState(plan?.everyDays ?? 2);
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setCheckInPlan(token, { instrument: inst.key, everyDays, clientAgreed: agreed, consentNote: note.trim() || undefined });
      setAgreed(false);
      setNote("");
      await onSaved(plan ? `${inst.name} now asked every ${everyDays === 1 ? "day" : `${everyDays} days`}.` : `${inst.name} started.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const unchanged = plan !== null && plan.everyDays === everyDays;
  const blocked = busy || unchanged || (plan === null && !agreed);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {inst.name}
      </Text>
      <Text style={styles.small}>{inst.about}</Text>
      <Text style={styles.body}>{plan ? (plan.active ? "On" : "Paused by the client side") : "Not set up"}</Text>
      <Text style={styles.label}>How often</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {EVERY.map((e) => (
          <Chip key={e.days} label={e.label} selected={everyDays === e.days} onPress={() => setEveryDays(e.days)} disabled={busy} />
        ))}
      </View>
      {plan === null && (
        <View style={styles.form}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            accessibilityLabel="The client has agreed to be asked these questions"
            onPress={() => setAgreed((a) => !a)}
            style={[styles.check, agreed && styles.checkOn]}
          >
            <Text style={[styles.checkText, agreed && styles.checkTextOn]}>{agreed ? "✓ " : ""}The client has agreed to be asked these questions</Text>
          </Pressable>
          <Text style={styles.label}>How they agreed (optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="How the client agreed" placeholder="For example: agreed at the March visit" value={note} onChangeText={setNote} editable={!busy} />
        </View>
      )}
      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel={plan ? `Save how often for ${inst.name}` : `Start ${inst.name}`} disabled={blocked} onPress={save} style={[styles.primary, blocked && styles.disabled]}>
        <Text style={styles.primaryText}>{busy ? "Saving…" : plan ? "Save" : "Start"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 26, fontWeight: "800", color: "#1a1a1a" },
  sectionTitle: { fontSize: 20, fontWeight: "800", color: "#1a1a1a" },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 12, padding: 14, gap: 10, backgroundColor: "#fff" },
  body: { fontSize: 16, color: "#222", lineHeight: 22 },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  ok: { color: "#2d6a2d", fontSize: 15, fontWeight: "700" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  form: { gap: 8 },
  item: { borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 8, gap: 2 },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#111" },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48, backgroundColor: "#fff" },
  check: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
  checkOn: { backgroundColor: "#0b5fff", borderColor: "#0b5fff" },
  checkText: { fontSize: 16, fontWeight: "700", color: "#1a1a1a" },
  checkTextOn: { color: "#fff" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 22, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
});
