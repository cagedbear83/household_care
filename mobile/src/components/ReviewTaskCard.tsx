import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ReviewHistoryItem, ReviewTask } from "@/lib/api";
import { formatDateTime, formatDay } from "@/lib/dates";
import { CommentsSection } from "./CommentsSection";
import { EvidencePhotos } from "./EvidencePhotos";

const WAITING = new Set(["COMPLETED_AWAITING_REVIEW", "CORRECTIVE_WORK_SUBMITTED"]);

function stateLabel(state: string, canDecide: boolean): string {
  switch (state) {
    case "NOT_STARTED":
      return "Not done yet";
    case "IN_PROGRESS":
      return "In progress";
    case "COMPLETED_AWAITING_REVIEW":
      return canDecide ? "Done. Waiting for your review" : "Done. Waiting for the client's review";
    case "CORRECTIVE_WORK_SUBMITTED":
      return canDecide ? "Corrected. Waiting for your review" : "Corrected. Waiting for the client's review";
    case "APPROVED":
      return "Approved";
    case "DISPUTED":
      return "Disputed. The IP has been asked to fix it";
    case "DECLINED_AWAITING_CONFIRMATION":
      return canDecide ? "The IP says you declined. Please confirm" : "The IP says the client declined. Waiting for the client";
    case "CLIENT_DECLINED_CONFIRMED":
      return "Declined by the client (confirmed)";
    case "NOT_NEEDED":
      return "Marked not needed";
    case "UNABLE_TO_COMPLETE":
      return "Marked unable to complete";
    case "MISSED_AT_SHIFT_END":
      return "Missed at the end of the shift";
    case "COMPLETION_ERROR_CORRECTED":
      return "Recorded in error and corrected. It counts as not done";
    default:
      return state;
  }
}

function historyText(h: ReviewHistoryItem): string {
  const who = h.actorName ?? h.actorRole;
  const d = h.detail ? `: ${h.detail}` : "";
  switch (h.action) {
    case "task_completed":
      return `${who} marked it done`;
    case "evidence_accepted":
      return "Photo accepted";
    case "task_disputed":
      return `${who} disputed it${d}`;
    case "task_corrective_submitted":
      return `${who} submitted corrected work`;
    case "task_approved":
      return `${who} approved it`;
    case "task_decline_reported":
      return `${who} reported that the client declined${d}`;
    case "task_decline_confirmed":
      return `${who} confirmed the decline`;
    case "task_decline_denied":
      return `${who} did not accept the decline${d}`;
    case "task_marked_not_needed":
      return `${who} marked it not needed${d}`;
    case "task_marked_unable":
      return `${who} marked it unable to complete${d}`;
    case "correction_requested":
      return `${who} reported a mistake${d}`;
    case "correction_appended":
      return `${who} appended a correction${d}`;
    case "correction_request_declined":
      return `${who} answered the report without a correction${d}`;
    default:
      return h.action;
  }
}

interface Props {
  task: ReviewTask;
  token: string;
  timezone: string;
  /** Only the client may decide; administrators see the same card without the buttons. */
  canDecide: boolean;
  /** Show which day the work was on (for the cross-day pending list). */
  showDay?: boolean;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onDispute: (reason: string) => void;
  onConfirmDecline: () => void;
  onDenyDecline: (note?: string) => void;
  onLater?: () => void;
  /** Add a comment on the task, or on a photo when evidenceId is given. */
  onComment: (body: string, evidenceId?: string) => Promise<void>;
}

export function ReviewTaskCard({ task, token, timezone, canDecide, showDay, busy, error, onApprove, onDispute, onConfirmDecline, onDenyDecline, onLater, onComment }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [mode, setMode] = useState<"dispute" | "deny" | null>(null);
  const [text, setText] = useState("");

  const waiting = WAITING.has(task.state);
  const decline = task.state === "DECLINED_AWAITING_CONFIRMATION";
  const urgent = waiting || decline;

  function closeForm() {
    setMode(null);
    setText("");
  }

  return (
    <View style={[styles.card, urgent && styles.cardUrgent]}>
      <Text style={styles.title} accessibilityRole="header">
        {task.title}
        {task.requiresPhoto ? "  (photo)" : ""}
      </Text>
      {showDay && (
        <Text style={styles.meta}>
          {formatDay(task.shiftLocalDate)} · {task.ipName}
        </Text>
      )}
      <Text style={[styles.state, urgent && styles.stateUrgent]}>{stateLabel(task.state, canDecide)}</Text>

      {task.clientNote && (task.state === "DISPUTED" || task.state === "NOT_STARTED") && (
        <Text style={styles.note}>Your note to the IP: {task.clientNote}</Text>
      )}
      {task.reasonCode && (task.state === "NOT_NEEDED" || task.state === "UNABLE_TO_COMPLETE") && (
        <Text style={styles.note}>
          Reason: {task.reasonCode.replace(/_/g, " ")}
          {task.reasonText ? `: ${task.reasonText}` : ""}
        </Text>
      )}

      <EvidencePhotos evidence={task.evidence} token={token} timezone={timezone} comments={task.comments} onComment={onComment} />
      {task.photoCount > 0 && task.evidence.length === 0 && (
        <Text style={styles.meta}>
          {task.photoCount === 1 ? "1 photo is on file" : `${task.photoCount} photos are on file`}, but you have not been approved to see photos. Ask the client if you would like access.
        </Text>
      )}

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}

      {canDecide && waiting && mode === null && (
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Approve ${task.title}`} onPress={onApprove} disabled={busy} style={[styles.approve, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Approve</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Dispute ${task.title}`} onPress={() => setMode("dispute")} disabled={busy} style={styles.dispute}>
            <Text style={styles.disputeText}>Dispute</Text>
          </Pressable>
          {onLater && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Review ${task.title} later`} onPress={onLater} disabled={busy} style={styles.later}>
              <Text style={styles.laterText}>Review later</Text>
            </Pressable>
          )}
        </View>
      )}

      {canDecide && decline && mode === null && (
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Yes, I declined ${task.title}`} onPress={onConfirmDecline} disabled={busy} style={[styles.approve, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.approveText}>Yes, I declined</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`No, I did not decline ${task.title}`} onPress={() => setMode("deny")} disabled={busy} style={styles.dispute}>
            <Text style={styles.disputeText}>No, I want this done</Text>
          </Pressable>
          {onLater && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Decide on ${task.title} later`} onPress={onLater} disabled={busy} style={styles.later}>
              <Text style={styles.laterText}>Decide later</Text>
            </Pressable>
          )}
        </View>
      )}

      {mode && (
        <View style={styles.form}>
          <Text style={styles.label}>{mode === "dispute" ? "What needs to be fixed? (the IP will see this)" : "Message for the IP (optional)"}</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel={mode === "dispute" ? "What needs to be fixed" : "Message for the IP"}
            value={text}
            onChangeText={setText}
            multiline
            editable={!busy}
            placeholder={mode === "dispute" ? "For example: counters are still sticky" : "For example: I do want lunch"}
          />
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mode === "dispute" ? "Send dispute" : "Send to the IP"}
              onPress={() => (mode === "dispute" ? onDispute(text.trim()) : onDenyDecline(text.trim() || undefined))}
              disabled={busy || (mode === "dispute" && text.trim().length < 3)}
              style={[styles.dispute, (busy || (mode === "dispute" && text.trim().length < 3)) && styles.disabled]}
            >
              {busy ? <ActivityIndicator /> : <Text style={styles.disputeText}>{mode === "dispute" ? "Send dispute" : "Send"}</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={closeForm} disabled={busy} style={styles.later}>
              <Text style={styles.laterText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      <CommentsSection
        title="Comments"
        comments={task.comments.filter((c) => c.evidenceId === null)}
        timezone={timezone}
        addLabel={`Add a comment on ${task.title}`}
        onAdd={(body) => onComment(body)}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${showHistory ? "Hide" : "Show"} history for ${task.title}`}
        accessibilityState={{ expanded: showHistory }}
        onPress={() => setShowHistory(!showHistory)}
        style={styles.historyToggle}
      >
        <Text style={styles.historyToggleText}>{showHistory ? "Hide history" : `Show history (${task.history.length})`}</Text>
      </Pressable>
      {showHistory && (
        <View style={styles.history}>
          <Text style={styles.instructions}>Instructions: {task.instructions}</Text>
          {task.history.length === 0 ? (
            <Text style={styles.meta}>Nothing has happened on this task yet.</Text>
          ) : (
            task.history.map((h, i) => (
              <Text key={`${h.action}-${i}`} style={styles.historyLine}>
                {h.at ? `${formatDateTime(h.at, timezone)}: ` : `${i + 1}. `}
                {historyText(h)}
              </Text>
            ))
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 8 },
  cardUrgent: { borderWidth: 2, borderColor: "#0b5fff" },
  title: { fontSize: 17, fontWeight: "700" },
  meta: { fontSize: 14, color: "#444" },
  state: { fontSize: 15, fontWeight: "600", color: "#333" },
  stateUrgent: { color: "#0b5fff" },
  note: { fontSize: 15, color: "#333", fontStyle: "italic" },
  instructions: { fontSize: 14, color: "#333" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  approve: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 22, minHeight: 48, justifyContent: "center" },
  approveText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  dispute: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  disputeText: { color: "#8a1c1c", fontSize: 16, fontWeight: "700" },
  later: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  laterText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  form: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 72, textAlignVertical: "top" },
  historyToggle: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  historyToggleText: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  history: { gap: 4 },
  historyLine: { fontSize: 14, color: "#222" },
});
