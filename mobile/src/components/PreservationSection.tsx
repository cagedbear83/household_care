import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, getPreservations, placePreservation, releasePreservation, type PreservationEntry } from "@/lib/api";
import { isDate, rangeLabel } from "@/lib/report-format";

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");

/**
 * "Keep everything for these dates", for an audit or a dispute. Photos from
 * visits on those dates are not removed when their year is up. It only adds
 * protection; releasing it asks why.
 */
export function PreservationSection({ token, defaultFrom, defaultTo }: { token: string; defaultFrom: string; defaultTo: string }) {
  const [items, setItems] = useState<PreservationEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [reason, setReason] = useState("");
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await getPreservations(token)).preservations);
    } catch {
      // The next load tries again.
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      setOpen(false);
      setReleasing(null);
      setReason("");
      setReleaseReason("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const active = items.filter((i) => i.active);
  const datesOk = isDate(from) && isDate(to) && from <= to;

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Keep everything for certain dates
      </Text>
      <Text style={styles.small}>For an audit or a dispute. Photos from visits on these dates are kept and not removed when their year is up.</Text>

      {notice && (
        <Text style={styles.ok} accessibilityLiveRegion="polite">
          ✓ {notice}
        </Text>
      )}
      {active.map((p) => (
        <View key={p.id} style={styles.item}>
          <Text style={styles.itemTitle}>
            Kept: {rangeLabel(p.fromDate, p.toDate)}
          </Text>
          <Text style={styles.small}>
            {p.reason} · by {p.placedBy ?? "someone"}
          </Text>
          {releasing === p.id ? (
            <View style={styles.form}>
              <Text style={styles.label}>Why it is being released</Text>
              <TextInput style={styles.input} accessibilityLabel="Reason for releasing" value={releaseReason} onChangeText={setReleaseReason} editable={!busy} />
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Release these dates"
                  disabled={busy || releaseReason.trim().length < 3}
                  onPress={() => run(() => releasePreservation(token, p.id, releaseReason.trim()), "Released.")}
                  style={[styles.primary, (busy || releaseReason.trim().length < 3) && styles.disabled]}
                >
                  <Text style={styles.primaryText}>{busy ? "Saving…" : "Release"}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setReleasing(null)} style={styles.outline}>
                  <Text style={styles.outlineText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={`Release the hold on ${rangeLabel(p.fromDate, p.toDate)}`} onPress={() => setReleasing(p.id)} style={styles.outline}>
              <Text style={styles.outlineText}>Release</Text>
            </Pressable>
          )}
        </View>
      ))}

      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}

      {open ? (
        <View style={styles.form}>
          <Text style={styles.label}>From (year-month-day)</Text>
          <TextInput style={styles.input} accessibilityLabel="Keep from date" autoCapitalize="none" value={from} onChangeText={setFrom} editable={!busy} />
          <Text style={styles.label}>To (year-month-day)</Text>
          <TextInput style={styles.input} accessibilityLabel="Keep to date" autoCapitalize="none" value={to} onChangeText={setTo} editable={!busy} />
          <Text style={styles.label}>Why</Text>
          <TextInput style={styles.input} accessibilityLabel="Reason for keeping everything" value={reason} onChangeText={setReason} editable={!busy} />
          {!datesOk && <Text style={styles.error}>Enter two dates as year-month-day, with the start not after the end.</Text>}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Keep everything for these dates"
              disabled={busy || !datesOk || reason.trim().length < 3}
              onPress={() => run(() => placePreservation(token, { fromDate: from, toDate: to, reason: reason.trim() }), "Everything for those dates will be kept.")}
              style={[styles.primary, (busy || !datesOk || reason.trim().length < 3) && styles.disabled]}
            >
              <Text style={styles.primaryText}>{busy ? "Saving…" : "Keep everything for these dates"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setOpen(false)} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Keep everything for certain dates" onPress={() => { setFrom(defaultFrom); setTo(defaultTo); setOpen(true); }} style={styles.outline}>
          <Text style={styles.outlineText}>Keep everything for certain dates</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 12, gap: 8, marginTop: 8 },
  title: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  ok: { color: "#2d6a2d", fontSize: 15, fontWeight: "700" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  item: { borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 8, gap: 4 },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#111" },
  form: { gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48, backgroundColor: "#fff" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
});
