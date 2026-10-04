import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, getMyCorrections, reportCompletionError, type MyCorrectionRequest } from "@/lib/api";

interface Props {
  token: string;
  /** The IP's visit that has a check-in, so a problem with the check-in or checkout can be reported. */
  shiftId: string | null;
  /** Changes when something was reported elsewhere on the screen, so the list refreshes. */
  refreshKey: number;
}

const STATUS_LABEL: Record<MyCorrectionRequest["status"], string> = {
  OPEN: "Waiting for an answer",
  RESOLVED: "Answered: a correction was recorded",
  DECLINED: "Answered: no correction was made",
};

/** The IP's own reports of mistakes, with the answers. This only asks; it never changes the record. */
export function CorrectionReports({ token, shiftId, refreshKey }: Props) {
  const [requests, setRequests] = useState<MyCorrectionRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRequests((await getMyCorrections(token)).requests);
    } catch {
      // The list is a convenience; the next refresh tries again.
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load, refreshKey]);

  async function send() {
    if (!shiftId) return;
    setBusy(true);
    setMessage(null);
    try {
      await reportCompletionError(token, { shiftId, reason });
      setMessage({ kind: "ok", text: "Your report was sent. The record has not changed; an administrator will answer it." });
      setReason("");
      setOpen(false);
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not send it. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  if (requests.length === 0 && !shiftId) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        My reports of mistakes
      </Text>
      <Text style={styles.small}>If something was recorded by mistake, report it. Nothing is changed or erased: an administrator adds a correction and keeps the original.</Text>

      {requests.length === 0 && <Text style={styles.small}>You have not reported anything.</Text>}
      {requests.map((r) => (
        <View key={r.id} style={styles.item}>
          <Text style={styles.itemTitle}>{r.about}</Text>
          <Text style={styles.small}>You said: {r.reason}</Text>
          <Text style={[styles.status, r.status === "OPEN" && styles.waiting]}>{STATUS_LABEL[r.status]}</Text>
          {r.answer ? <Text style={styles.small}>Answer: {r.answer}</Text> : null}
        </View>
      ))}

      {message && (
        <Text style={message.kind === "ok" ? styles.ok : styles.error} accessibilityLiveRegion="polite">
          {message.text}
        </Text>
      )}

      {shiftId &&
        (open ? (
          <View style={styles.form}>
            <Text style={styles.label}>What is wrong with your check-in or checkout?</Text>
            <TextInput style={styles.input} accessibilityLabel="What is wrong with my check-in or checkout" multiline value={reason} onChangeText={setReason} editable={!busy} />
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel="Send report" disabled={busy || reason.trim().length < 3} onPress={send} style={[styles.primary, (busy || reason.trim().length < 3) && styles.disabled]}>
                <Text style={styles.primaryText}>{busy ? "Sending…" : "Send report"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setOpen(false)} style={styles.outline}>
                <Text style={styles.outlineText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="Report a problem with my check-in or checkout" onPress={() => { setMessage(null); setOpen(true); }} style={styles.outline}>
            <Text style={styles.outlineText}>Report a problem with my check-in or checkout</Text>
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 12, gap: 8, marginTop: 20 },
  title: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  item: { borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 8, gap: 2 },
  itemTitle: { fontSize: 15, fontWeight: "700", color: "#111" },
  status: { fontSize: 14, fontWeight: "700", color: "#2d6a2d" },
  waiting: { color: "#6b4e00" },
  ok: { color: "#2d6a2d", fontSize: 15, fontWeight: "700" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  form: { gap: 8 },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 80, textAlignVertical: "top", backgroundColor: "#fff" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
});
