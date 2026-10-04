import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ShiftStatus } from "@/lib/api";
import { addHoursToTime, formatDay, TIME_PATTERN } from "@/lib/dates";
import { Chip } from "./Chip";

const STATUS_OPTIONS: { value: ShiftStatus; label: string }[] = [
  { value: "SCHEDULED", label: "Working" },
  { value: "VACATION", label: "Vacation" },
  { value: "SICK", label: "Sick" },
  { value: "CLIENT_UNAVAILABLE", label: "Client unavailable" },
  { value: "NOT_SCHEDULED", label: "Not scheduled" },
];

export interface ShiftFormValue {
  status: ShiftStatus;
  startLocal?: string;
  endLocal?: string;
  reason?: string;
}

interface Props {
  localDate: string;
  /** "change" edits an existing, not-yet-started shift: the old version is kept and a reason is required. */
  mode?: "add" | "change";
  initial?: { status: ShiftStatus; start: string; end: string };
  busy: boolean;
  error: string | null;
  onSubmit: (value: ShiftFormValue) => void;
  onCancel: () => void;
}

export function ShiftForm({ localDate, mode = "add", initial, busy, error, onSubmit, onCancel }: Props) {
  const [status, setStatus] = useState<ShiftStatus>(initial?.status ?? "SCHEDULED");
  const [start, setStart] = useState(initial?.start ?? "09:00");
  const [end, setEnd] = useState(initial?.end ?? "15:00");
  const [reason, setReason] = useState("");
  const changing = mode === "change";
  const working = status === "SCHEDULED";
  const timesValid = TIME_PATTERN.test(start) && TIME_PATTERN.test(end) && end > start;
  const reasonValid = !changing || reason.trim().length >= 3;
  const canSave = !busy && reasonValid && (!working || timesValid);

  return (
    <View style={styles.form}>
      <Text style={styles.heading} accessibilityRole="header">
        {changing ? "Change" : "Add to"} {formatDay(localDate)}
      </Text>

      <View style={styles.row} accessibilityRole="radiogroup">
        {STATUS_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={status === option.value}
            onPress={() => setStatus(option.value)}
            disabled={busy}
          />
        ))}
      </View>

      {working && (
        <>
          <View style={styles.times}>
            <View style={styles.timeField}>
              <Text style={styles.label}>Start (24-hour)</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Start time, 24 hour, for example 09:00"
                value={start}
                onChangeText={setStart}
                placeholder="09:00"
                autoCapitalize="none"
                editable={!busy}
              />
            </View>
            <View style={styles.timeField}>
              <Text style={styles.label}>End (24-hour)</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="End time, 24 hour, for example 15:00"
                value={end}
                onChangeText={setEnd}
                placeholder="15:00"
                autoCapitalize="none"
                editable={!busy}
              />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Set a six hour shift from the start time"
            onPress={() => {
              const next = addHoursToTime(start, 6);
              if (next) setEnd(next);
            }}
            disabled={busy || !TIME_PATTERN.test(start)}
            style={styles.helper}
          >
            <Text style={styles.helperText}>Make it a 6-hour shift</Text>
          </Pressable>
          {!timesValid && (
            <Text style={styles.hint}>Use HH:MM in 24-hour time (for example 09:00 to 15:00); the end must be after the start.</Text>
          )}
        </>
      )}

      {changing && (
        <View>
          <Text style={styles.label}>Reason for the change (kept in the record)</Text>
          <TextInput
            style={[styles.input, styles.reason]}
            accessibilityLabel="Reason for the change"
            value={reason}
            onChangeText={setReason}
            placeholder="For example: client asked for a shorter day"
            multiline
            editable={!busy}
          />
        </View>
      )}

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={changing ? "Save change" : "Save"}
          onPress={() =>
            onSubmit({
              status,
              ...(working ? { startLocal: start, endLocal: end } : {}),
              ...(changing ? { reason: reason.trim() } : {}),
            })
          }
          disabled={!canSave}
          style={[styles.save, !canSave && styles.disabled]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{changing ? "Save change" : "Save"}</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} disabled={busy} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, paddingTop: 12 },
  heading: { fontSize: 17, fontWeight: "700" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  times: { flexDirection: "row", gap: 12 },
  timeField: { flex: 1 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48 },
  reason: { minHeight: 72, textAlignVertical: "top" },
  helper: { alignSelf: "flex-start", paddingVertical: 8, minHeight: 44, justifyContent: "center" },
  helperText: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  hint: { fontSize: 14, color: "#555" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  save: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 28, minHeight: 48, justifyContent: "center" },
  saveText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  cancel: { paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center" },
  cancelText: { fontSize: 16, color: "#444", fontWeight: "600" },
});
