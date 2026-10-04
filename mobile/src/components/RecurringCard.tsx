import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { GenerationResult } from "@/lib/api";
import { formatDay, TIME_PATTERN, weekdayName } from "@/lib/dates";
import { Chip } from "./Chip";

// Monday-first display order; values are 0=Sunday .. 6=Saturday.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface Props {
  busy: boolean;
  message: string | null;
  results: GenerationResult[] | null;
  rangeLabel: string;
  onSaveRule: (value: { weekday: number; startLocal: string; endLocal: string }) => void;
  onGenerate: () => void;
}

export function RecurringCard({ busy, message, results, rangeLabel, onSaveRule, onGenerate }: Props) {
  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("15:00");
  const valid = TIME_PATTERN.test(start) && TIME_PATTERN.test(end) && end > start;

  const created = results?.filter((r) => r.outcome === "created").length ?? 0;
  const skipped = results?.filter((r) => r.outcome === "skipped") ?? [];

  return (
    <View style={styles.card}>
      <Text style={styles.heading} accessibilityRole="header">
        Repeat weekly
      </Text>
      <Text style={styles.help}>
        Save a weekly pattern, then fill the schedule from your patterns. Days that already have an entry are left alone.
      </Text>

      <View style={styles.row} accessibilityRole="radiogroup">
        {WEEKDAY_ORDER.map((d) => (
          <Chip key={d} label={weekdayName(d)} selected={weekday === d} onPress={() => setWeekday(d)} disabled={busy} />
        ))}
      </View>

      <View style={styles.times}>
        <View style={styles.timeField}>
          <Text style={styles.label}>Start (24-hour)</Text>
          <TextInput style={styles.input} accessibilityLabel="Pattern start time, 24 hour" value={start} onChangeText={setStart} autoCapitalize="none" editable={!busy} />
        </View>
        <View style={styles.timeField}>
          <Text style={styles.label}>End (24-hour)</Text>
          <TextInput style={styles.input} accessibilityLabel="Pattern end time, 24 hour" value={end} onChangeText={setEnd} autoCapitalize="none" editable={!busy} />
        </View>
      </View>

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Save weekly pattern for ${weekdayName(weekday)}`}
          onPress={() => onSaveRule({ weekday, startLocal: start, endLocal: end })}
          disabled={busy || !valid}
          style={[styles.primary, (busy || !valid) && styles.disabled]}
        >
          <Text style={styles.primaryText}>Save pattern</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Fill schedule from patterns for four weeks starting ${rangeLabel}`}
          onPress={onGenerate}
          disabled={busy}
          style={[styles.secondary, busy && styles.disabled]}
        >
          {busy ? <ActivityIndicator /> : <Text style={styles.secondaryText}>Fill next 4 weeks</Text>}
        </Pressable>
      </View>

      {message && (
        <Text style={styles.message} accessibilityLiveRegion="polite">
          {message}
        </Text>
      )}

      {results && (
        <View accessibilityLiveRegion="polite">
          <Text style={styles.summary}>
            {created} day{created === 1 ? "" : "s"} added, {skipped.length} skipped.
          </Text>
          {skipped.map((r) => (
            <Text key={`${r.localDate}-${r.code}`} style={styles.skipped}>
              {formatDay(r.localDate)}: {r.message}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#f2f2f2", borderRadius: 10, padding: 16, gap: 12, marginTop: 8 },
  heading: { fontSize: 20, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  times: { flexDirection: "row", gap: 12 },
  timeField: { flex: 1 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  primary: { backgroundColor: "#0b5fff", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  secondary: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center", backgroundColor: "#fff" },
  secondaryText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  message: { fontSize: 15, fontWeight: "600" },
  summary: { fontSize: 15, fontWeight: "700" },
  skipped: { fontSize: 14, color: "#8a1c1c", marginTop: 4 },
});
