import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { foodPhotoUrl, type FoodStaffRequest } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { AuthImage } from "./AuthImage";

const LOCATION_TEXT: Record<string, string> = {
  VERIFIED: "taken at the apartment",
  UNVERIFIED: "location could not be verified",
  FAILED: "taken away from the apartment",
};

/** The full story of one request, in plain sentences with who did what and when. */
export function describeHistory(r: FoodStaffRequest, tz: string): string[] {
  const t = (iso: string | null) => (iso ? formatDateTime(iso, tz) : "");
  const lines = [`${r.requestedBy ?? "The IP"} ${r.kind === "HAZARD" ? "reported a hazard" : "asked to throw it away"} on ${t(r.requestedAt)}.`];
  if (r.kind === "HAZARD") {
    lines.push(`What was done: ${r.actionTaken}`);
    if (r.acknowledgedBy) lines.push(`${r.acknowledgedBy} acknowledged it on ${t(r.acknowledgedAt)}.`);
    return lines;
  }
  if (r.escalatedAt) lines.push(`No answer was received, so it was left in place and the administrator was alerted on ${t(r.escalatedAt)}.`);
  if (r.status === "DECLINED") lines.push(`${r.decidedBy} declined it on ${t(r.decidedAt)}${r.decisionNote ? `: ${r.decisionNote}` : ""}.`);
  if (r.decidedBy && r.status !== "DECLINED") lines.push(`${r.decidedBy} approved it on ${t(r.decidedAt)}.`);
  if (r.status === "DISPOSED") lines.push(`${r.disposedBy} threw it away on ${t(r.disposedAt)}.`);
  return lines;
}

interface Props {
  request: FoodStaffRequest;
  token: string;
  timezone: string;
  /** Only the client decides; administrators see the same card read-only. */
  canDecide: boolean;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onDecline: (note?: string) => void;
  onAcknowledge: () => void;
}

export function FoodRequestCard({ request: r, token, timezone, canDecide, busy, error, onApprove, onDecline, onAcknowledge }: Props) {
  const [showPhoto, setShowPhoto] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [showStory, setShowStory] = useState(false);

  const pending = r.status === "PENDING";
  const hazard = r.status === "HAZARD_REPORTED";

  return (
    <View style={[styles.card, (pending || hazard) && styles.cardUrgent]}>
      <Text style={styles.title} accessibilityRole="header">
        {r.item}
        {r.kind === "HAZARD" ? "  (immediate hazard)" : ""}
      </Text>
      <Text style={styles.line}>
        <Text style={styles.bold}>Where: </Text>
        {r.location}
      </Text>
      <Text style={styles.line}>
        <Text style={styles.bold}>{r.kind === "HAZARD" ? "Why it was a hazard: " : "Why: "}</Text>
        {r.kind === "HAZARD" ? r.reasonText : `${r.reason}${r.reasonText ? ` (${r.reasonText})` : ""}`}
      </Text>
      {r.kind === "HAZARD" && (
        <Text style={styles.line}>
          <Text style={styles.bold}>What was done: </Text>
          {r.actionTaken}
        </Text>
      )}
      {r.dateLabel && (
        <Text style={styles.line}>
          <Text style={styles.bold}>Date on the label: </Text>
          {r.dateLabel}
        </Text>
      )}
      {r.replacement && (
        <Text style={styles.line}>
          <Text style={styles.bold}>Replacement to buy: </Text>
          {r.replacement}
        </Text>
      )}
      <Text style={styles.meta}>
        {r.requestedBy} · {formatDateTime(r.requestedAt, timezone)}
      </Text>

      {r.escalatedAt && pending && (
        <Text style={styles.warn}>Nobody has answered yet. The item is being left where it is, and the administrator was alerted.</Text>
      )}
      {r.status === "APPROVED" && <Text style={styles.good}>Approved. Waiting for the IP to throw it away and record it.</Text>}

      {r.hasPhoto && (
        <View style={styles.photoBox}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPhoto }} accessibilityLabel={`${showPhoto ? "Hide" : "Show"} the photo of ${r.item}`} onPress={() => setShowPhoto(!showPhoto)} style={styles.linkButton}>
            <Text style={styles.link}>{showPhoto ? "Hide photo" : "Show photo"}</Text>
          </Pressable>
          {showPhoto && (
            <>
              <AuthImage uri={foodPhotoUrl(r.id)} token={token} style={styles.photo} resizeMode="contain" accessibilityLabel={`Photo of ${r.item}`} />
              <Text style={styles.meta}>
                {r.photoLocationVerification ? LOCATION_TEXT[r.photoLocationVerification] : ""}
                {r.photoFingerprint ? ` · fingerprint ${r.photoFingerprint}` : ""}
              </Text>
            </>
          )}
        </View>
      )}

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}

      {canDecide && pending && !declining && (
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Approve throwing away ${r.item}`} onPress={onApprove} disabled={busy} style={[styles.approve, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Yes, throw it away</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Decline throwing away ${r.item}`} onPress={() => setDeclining(true)} disabled={busy} style={styles.decline}>
            <Text style={styles.declineText}>No, keep it</Text>
          </Pressable>
        </View>
      )}
      {canDecide && pending && declining && (
        <View style={styles.form}>
          <Text style={styles.bold}>Message for the IP (optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="Message for the IP" value={note} onChangeText={setNote} multiline editable={!busy} placeholder="For example: I am still going to eat that" />
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Send: keep it" onPress={() => onDecline(note.trim() || undefined)} disabled={busy} style={[styles.decline, busy && styles.disabled]}>
              {busy ? <ActivityIndicator /> : <Text style={styles.declineText}>Keep it</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setDeclining(false)} disabled={busy} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
      {canDecide && hazard && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Acknowledge the hazard report for ${r.item}`} onPress={onAcknowledge} disabled={busy} style={[styles.approve, busy && styles.disabled]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>I have seen this</Text>}
        </Pressable>
      )}

      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showStory }} accessibilityLabel={`${showStory ? "Hide" : "Show"} the full record for ${r.item}`} onPress={() => setShowStory(!showStory)} style={styles.linkButton}>
        <Text style={styles.link}>{showStory ? "Hide record" : "Show full record"}</Text>
      </Pressable>
      {showStory && (
        <View style={styles.story}>
          {describeHistory(r, timezone).map((line, i) => (
            <Text key={i} style={styles.meta}>
              {line}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 6 },
  cardUrgent: { borderWidth: 2, borderColor: "#0b5fff" },
  title: { fontSize: 18, fontWeight: "700" },
  line: { fontSize: 15, color: "#111" },
  bold: { fontWeight: "700" },
  meta: { fontSize: 14, color: "#444" },
  warn: { fontSize: 15, fontWeight: "600", color: "#8a5a00" },
  good: { fontSize: 15, fontWeight: "600", color: "#157a3d" },
  photoBox: { gap: 6 },
  photo: { width: "100%", height: 260, backgroundColor: "#111", borderRadius: 8 },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  form: { gap: 8 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 16, minHeight: 64, textAlignVertical: "top" },
  approve: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center", alignItems: "center" },
  approveText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  decline: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  declineText: { color: "#8a1c1c", fontSize: 16, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  outlineText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  linkButton: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  link: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  story: { gap: 4 },
});
