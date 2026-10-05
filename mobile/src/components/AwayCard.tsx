import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, endAway, getAway, startAway, type AwayKind, type AwayStatus } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { isDate } from "@/lib/report-format";

const KIND_LABEL: Record<AwayKind, string> = { HOSPITAL: "in the hospital", VACATION: "on vacation", OTHER: "away" };

/**
 * For the client, an administrator and the primary family member. While the
 * client is in hospital or away, the IP cannot check in or do tasks. Anyone on
 * the client's side can turn it on and off, so it can still be done if the
 * client cannot.
 */
export function AwayCard({ token, timezone }: { token: string; timezone: string }) {
  const [status, setStatus] = useState<AwayStatus | null>(null);
  const [kind, setKind] = useState<AwayKind | null>(null);
  const [returnDate, setReturnDate] = useState("");
  const [note, setNote] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getAway(token));
    } catch {
      // The next refresh tries again.
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
    })();
    const timer = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setKind(null);
      setConfirmEnd(false);
      setReturnDate("");
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (status.away) {
    return (
      <View style={[styles.card, styles.awayCard]} accessibilityLiveRegion="polite">
        <Text style={styles.title} accessibilityRole="header">
          The client is {status.kind ? KIND_LABEL[status.kind] : "away"}
        </Text>
        <Text style={styles.body}>Work is paused. The IP cannot check in or complete tasks until the client is back. They can still check out.</Text>
        {status.startedAt && (
          <Text style={styles.small}>
            Since {formatDateTime(status.startedAt, timezone)}
            {status.setBy ? ` · turned on by ${status.setBy}` : ""}
            {status.expectedReturnDate ? ` · expected back ${status.expectedReturnDate}` : ""}
          </Text>
        )}
        {status.note ? <Text style={styles.small}>Note: {status.note}</Text> : null}
        {error && (
          <Text style={styles.error} role="alert">
            {error}
          </Text>
        )}
        {confirmEnd ? (
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Yes, the client is back home" disabled={busy} onPress={() => run(() => endAway(token))} style={[styles.primary, busy && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? "Saving…" : "Yes, the client is back"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setConfirmEnd(false)} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="The client is back home" onPress={() => setConfirmEnd(true)} style={styles.primary}>
            <Text style={styles.primaryText}>The client is back home</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        The client is home
      </Text>
      <Text style={styles.small}>If the client goes into the hospital or goes away, pause work here. The IP then cannot check in or complete tasks until you say the client is back.</Text>
      {kind === null ? (
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel="The client is in the hospital" onPress={() => setKind("HOSPITAL")} style={styles.outline}>
            <Text style={styles.outlineText}>In the hospital</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="The client is on vacation" onPress={() => setKind("VACATION")} style={styles.outline}>
            <Text style={styles.outlineText}>On vacation</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="The client is away for another reason" onPress={() => setKind("OTHER")} style={styles.outline}>
            <Text style={styles.outlineText}>Away, other</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={styles.label}>Expected back (year-month-day, optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="Expected back date" placeholder="2026-10-20" autoCapitalize="none" value={returnDate} onChangeText={setReturnDate} editable={!busy} />
          <Text style={styles.label}>A note for the administrator (optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="Note" value={note} onChangeText={setNote} editable={!busy} />
          <Text style={styles.small}>The IP is only told that work is paused, never why.</Text>
          {error && (
            <Text style={styles.error} role="alert">
              {error}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Pause work: the client is ${KIND_LABEL[kind]}`}
              disabled={busy || (returnDate.trim() !== "" && !isDate(returnDate.trim()))}
              onPress={() => run(() => startAway(token, { kind, expectedReturnDate: returnDate.trim() || undefined, note: note.trim() || undefined }))}
              style={[styles.primary, (busy || (returnDate.trim() !== "" && !isDate(returnDate.trim()))) && styles.disabled]}
            >
              <Text style={styles.primaryText}>{busy ? "Saving…" : `Pause work: ${KIND_LABEL[kind]}`}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setKind(null)} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 12, padding: 14, gap: 8, backgroundColor: "#fff" },
  awayCard: { borderColor: "#a1130f", borderWidth: 3, backgroundColor: "#fff4f3" },
  title: { fontSize: 20, fontWeight: "800", color: "#1a1a1a" },
  body: { fontSize: 16, color: "#222", lineHeight: 22 },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  form: { gap: 8 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48, backgroundColor: "#fff" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
});
