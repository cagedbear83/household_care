import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatDay } from "@/lib/dates";

interface Props {
  localDate: string;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onKeep: () => void;
}

export function CancelShiftForm({ localDate, busy, error, onConfirm, onKeep }: Props) {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= 3;

  return (
    <View style={styles.form}>
      <Text style={styles.heading} accessibilityRole="header">
        Cancel the shift on {formatDay(localDate)}?
      </Text>
      <Text style={styles.help}>The shift stays in the history. Its hours are freed for the week.</Text>
      <Text style={styles.label}>Reason (kept in the record)</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Reason for cancelling"
        value={reason}
        onChangeText={setReason}
        placeholder="For example: IP is out sick"
        multiline
        editable={!busy}
      />
      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel this shift"
          onPress={() => onConfirm(reason.trim())}
          disabled={busy || !valid}
          style={[styles.danger, (busy || !valid) && styles.disabled]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.dangerText}>Cancel this shift</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Keep the shift" onPress={onKeep} disabled={busy} style={styles.keep}>
          <Text style={styles.keepText}>Keep shift</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10, paddingTop: 12 },
  heading: { fontSize: 17, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  label: { fontSize: 14, fontWeight: "600" },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 72, textAlignVertical: "top" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  danger: { backgroundColor: "#8a1c1c", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  dangerText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  keep: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  keepText: { fontSize: 16, fontWeight: "700" },
});
