import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TaskFrequency, TemplateFields } from "@/lib/api";
import { Chip } from "./Chip";

export const FREQUENCY_LABELS: Record<TaskFrequency, string> = {
  VISIT: "Every visit",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  AS_NEEDED: "As needed",
};

interface Props {
  heading: string;
  initial?: TemplateFields;
  groups: string[];
  sortOrder: number;
  busy: boolean;
  error: string | null;
  onSubmit: (value: TemplateFields) => void;
  onCancel: () => void;
}

export function TemplateForm({ heading, initial, groups, sortOrder, busy, error, onSubmit, onCancel }: Props) {
  const [groupName, setGroupName] = useState(initial?.groupName ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [frequency, setFrequency] = useState<TaskFrequency>(initial?.frequency ?? "VISIT");
  const [requiresPhoto, setRequiresPhoto] = useState(initial?.requiresPhoto ?? false);

  const valid = groupName.trim() && title.trim() && instructions.trim();

  return (
    <View style={styles.form}>
      <Text style={styles.heading} accessibilityRole="header">
        {heading}
      </Text>

      <Text style={styles.label}>Area (for example Kitchen)</Text>
      <TextInput style={styles.input} accessibilityLabel="Area" value={groupName} onChangeText={setGroupName} editable={!busy} />
      {groups.length > 0 && (
        <View style={styles.row} accessibilityRole="radiogroup">
          {groups.map((g) => (
            <Chip key={g} label={g} selected={groupName === g} onPress={() => setGroupName(g)} disabled={busy} />
          ))}
        </View>
      )}

      <Text style={styles.label}>Task name</Text>
      <TextInput style={styles.input} accessibilityLabel="Task name" value={title} onChangeText={setTitle} editable={!busy} />

      <Text style={styles.label}>Instructions</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        accessibilityLabel="Instructions"
        value={instructions}
        onChangeText={setInstructions}
        multiline
        editable={!busy}
      />

      <Text style={styles.label}>How often</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {(Object.keys(FREQUENCY_LABELS) as TaskFrequency[]).map((f) => (
          <Chip key={f} label={FREQUENCY_LABELS[f]} selected={frequency === f} onPress={() => setFrequency(f)} disabled={busy} />
        ))}
      </View>

      <Text style={styles.label}>Needs a photo before it can be completed</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        <Chip label="No photo" selected={!requiresPhoto} onPress={() => setRequiresPhoto(false)} disabled={busy} />
        <Chip label="Photo required" selected={requiresPhoto} onPress={() => setRequiresPhoto(true)} disabled={busy} />
      </View>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save task"
          onPress={() =>
            onSubmit({
              groupName: groupName.trim(),
              title: title.trim(),
              instructions: instructions.trim(),
              frequency,
              requiresPhoto,
              sortOrder: initial?.sortOrder ?? sortOrder,
            })
          }
          disabled={busy || !valid}
          style={[styles.save, (busy || !valid) && styles.disabled]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save task</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} disabled={busy} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8, paddingTop: 8 },
  heading: { fontSize: 18, fontWeight: "700" },
  label: { fontSize: 14, fontWeight: "600", marginTop: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  save: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24, minHeight: 48, justifyContent: "center" },
  saveText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  cancel: { paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center" },
  cancelText: { fontSize: 16, color: "#444", fontWeight: "600" },
});
