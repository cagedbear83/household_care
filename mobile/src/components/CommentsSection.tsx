import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ReviewComment } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

interface Props {
  title: string;
  comments: ReviewComment[];
  timezone: string;
  addLabel: string;
  /** Resolves when saved; throws (or rejects) to keep the draft and show an error. */
  onAdd: (body: string) => Promise<void>;
}

/** Comments are never edited or deleted, so there are only "add" controls. */
export function CommentsSection({ title, comments, timezone, addLabel, onAdd }: Props) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onAdd(text.trim());
      setText("");
      setWriting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The comment could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole="header">
        {title} ({comments.length})
      </Text>

      {comments.map((c) => (
        <View key={c.id} style={styles.comment}>
          <Text style={styles.who}>
            {c.authorName}
            <Text style={styles.role}> · {c.authorRoleLabel}</Text>
            {c.at ? <Text style={styles.time}> · {formatDateTime(c.at, timezone)}</Text> : null}
          </Text>
          <Text style={styles.body}>{c.body}</Text>
        </View>
      ))}

      {writing ? (
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            accessibilityLabel={addLabel}
            value={text}
            onChangeText={setText}
            multiline
            editable={!busy}
            placeholder="Write a comment"
          />
          {error && (
            <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
              {error}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Post comment"
              onPress={send}
              disabled={busy || text.trim().length === 0}
              style={[styles.post, (busy || text.trim().length === 0) && styles.disabled]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.postText}>Post comment</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel comment"
              onPress={() => {
                setWriting(false);
                setError(null);
              }}
              disabled={busy}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={addLabel} onPress={() => setWriting(true)} style={styles.add}>
          <Text style={styles.addText}>+ Add a comment</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, borderTopWidth: 1, borderTopColor: "#ddd", paddingTop: 10 },
  title: { fontSize: 15, fontWeight: "700" },
  comment: { backgroundColor: "#f6f6f6", borderRadius: 8, padding: 10, gap: 2 },
  who: { fontSize: 14, fontWeight: "700" },
  role: { fontWeight: "400", color: "#444" },
  time: { fontWeight: "400", color: "#555" },
  body: { fontSize: 15, color: "#111" },
  form: { gap: 8 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 10, fontSize: 16, minHeight: 64, textAlignVertical: "top" },
  error: { color: "#b00020", fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  post: { backgroundColor: "#0b5fff", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: "center" },
  postText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  cancel: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: "center" },
  cancelText: { fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  add: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  addText: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
});
