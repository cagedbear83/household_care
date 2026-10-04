import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TaskInstanceDto } from "@/lib/api";

const REASONS: { code: "supplies_unavailable" | "insufficient_time" | "equipment_problem" | "other"; label: string }[] = [
  { code: "supplies_unavailable", label: "Supplies unavailable" },
  { code: "insufficient_time", label: "Insufficient time" },
  { code: "equipment_problem", label: "Equipment problem" },
  { code: "other", label: "Other" },
];

const STATE_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  COMPLETED_AWAITING_REVIEW: "Completed — awaiting review",
  APPROVED: "Approved",
  DISPUTED: "Disputed",
  CORRECTIVE_WORK_SUBMITTED: "Corrective work submitted",
  DECLINED_AWAITING_CONFIRMATION: "Declined — awaiting client confirmation",
  CLIENT_DECLINED_CONFIRMED: "Client declined — confirmed",
  NOT_NEEDED: "Not needed",
  UNABLE_TO_COMPLETE: "Unable to complete",
  MISSED_AT_SHIFT_END: "Missed at shift end",
  COMPLETION_ERROR_CORRECTED: "Corrected: this was recorded by mistake. Please do it again",
};

// Recorded steps that can have been a mistake ("Report completion error").
const REPORTABLE = new Set(["COMPLETED_AWAITING_REVIEW", "CORRECTIVE_WORK_SUBMITTED", "APPROVED", "NOT_NEEDED", "UNABLE_TO_COMPLETE", "DECLINED_AWAITING_CONFIRMATION", "DISPUTED"]);

interface Props {
  task: TaskInstanceDto;
  busy: boolean;
  onTakePhoto: () => void;
  onComplete: () => void;
  onCorrective: () => void;
  onException: (outcome: "NOT_NEEDED" | "UNABLE_TO_COMPLETE", reasonCode: string, reasonText?: string) => void;
  /** Sends the IP's report that this task was recorded by mistake. Throws a readable error if it fails. */
  onReportError: (reason: string) => Promise<void>;
}

export function TaskRow({ task, busy, onTakePhoto, onComplete, onCorrective, onException, onReportError }: Props) {
  const [pickingReasonFor, setPickingReasonFor] = useState<"NOT_NEEDED" | "UNABLE_TO_COMPLETE" | null>(null);
  const [otherText, setOtherText] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const disputed = task.state === "DISPUTED";
  const actionable = task.state === "NOT_STARTED" || task.state === "IN_PROGRESS" || disputed || task.state === "COMPLETION_ERROR_CORRECTED";
  const canReport = REPORTABLE.has(task.state) && task.correctionStatus !== "OPEN";

  async function sendReport() {
    setReportBusy(true);
    setReportError(null);
    try {
      await onReportError(reportText.trim());
      setReporting(false);
      setReportText("");
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Could not send the report.");
    } finally {
      setReportBusy(false);
    }
  }
  // After a dispute, "hasEvidence" only counts a photo taken since the dispute.
  const needsPhoto = task.requiresPhotoSnapshot && !task.hasEvidence;
  const showNote = task.clientNote && (disputed || task.state === "NOT_STARTED");

  return (
    <View style={styles.row}>
      <Text style={styles.title} accessibilityRole="header">
        {task.titleSnapshot}
        {task.requiresPhotoSnapshot ? " (photo required)" : ""}
      </Text>
      <Text style={styles.instructions}>{task.instructionsSnapshot}</Text>
      <Text style={styles.state}>{STATE_LABELS[task.state] ?? task.state}</Text>
      {showNote && (
        <Text style={styles.clientNote} accessibilityLiveRegion="polite">
          The client says: {task.clientNote}
        </Text>
      )}
      {task.requiresPhotoSnapshot && actionable && (
        <Text style={styles.photoState} accessibilityLiveRegion="polite">
          {task.hasEvidence
            ? "Photo accepted ✓"
            : disputed
              ? "Take a new photo of the corrected work before submitting it."
              : "Take the photo first. It is needed before this can be completed."}
        </Text>
      )}

      {actionable && (
        <View style={styles.actions}>
          {task.requiresPhotoSnapshot && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${task.hasEvidence ? "Retake" : "Take"} the photo for ${task.titleSnapshot}`}
              onPress={onTakePhoto}
              disabled={busy}
              style={[styles.actionButton, styles.photoButton]}
            >
              <Text style={styles.actionButtonText}>{task.hasEvidence ? "Retake photo" : "Take photo"}</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={disputed ? `Submit corrected work for ${task.titleSnapshot}` : `Mark ${task.titleSnapshot} complete`}
            accessibilityState={{ disabled: busy || needsPhoto }}
            onPress={disputed ? onCorrective : onComplete}
            disabled={busy || needsPhoto}
            style={[styles.actionButton, styles.completeButton, needsPhoto && styles.actionButtonDisabled]}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionButtonText}>{disputed ? "Submit corrected work" : "Complete"}</Text>}
          </Pressable>
          {!disputed && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark ${task.titleSnapshot} not needed`}
              onPress={() => setPickingReasonFor("NOT_NEEDED")}
              disabled={busy}
              style={styles.actionButton}
            >
              <Text style={styles.actionButtonTextDark}>Not needed</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Mark ${task.titleSnapshot} unable to complete`}
            onPress={() => setPickingReasonFor("UNABLE_TO_COMPLETE")}
            disabled={busy}
            style={styles.actionButton}
          >
            <Text style={styles.actionButtonTextDark}>Unable to complete</Text>
          </Pressable>
        </View>
      )}

      {task.correctionStatus === "OPEN" && (
        <Text style={styles.reported} accessibilityLiveRegion="polite">
          You reported a mistake on this task. Waiting for an answer.
        </Text>
      )}
      {task.correctionStatus && task.correctionStatus !== "OPEN" && task.state !== "COMPLETION_ERROR_CORRECTED" && (
        <Text style={styles.reported}>Your report on this task was answered. See “My reports of mistakes” below.</Text>
      )}

      {canReport && !reporting && !pickingReasonFor && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Report a completion error on ${task.titleSnapshot}`} onPress={() => setReporting(true)} style={styles.reportLink}>
          <Text style={styles.reportLinkText}>Report completion error</Text>
        </Pressable>
      )}
      {reporting && (
        <View style={styles.reasonPicker}>
          <Text style={styles.reasonPrompt}>What was recorded by mistake? Nothing is changed until an administrator answers.</Text>
          <TextInput style={styles.otherInput} accessibilityLabel="What was recorded by mistake" multiline value={reportText} onChangeText={setReportText} editable={!reportBusy} />
          {reportError ? <Text style={styles.clientNote}>{reportError}</Text> : null}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Send report" disabled={reportBusy || reportText.trim().length < 3} onPress={sendReport} style={[styles.actionButton, styles.completeButton, (reportBusy || reportText.trim().length < 3) && styles.actionButtonDisabled]}>
              <Text style={styles.actionButtonText}>{reportBusy ? "Sending…" : "Send report"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel the report" onPress={() => setReporting(false)} style={styles.actionButton}>
              <Text style={styles.actionButtonTextDark}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      {pickingReasonFor && (
        <View style={styles.reasonPicker}>
          <Text style={styles.reasonPrompt}>Why?</Text>
          {REASONS.map((reason) => (
            <Pressable
              key={reason.code}
              accessibilityRole="button"
              accessibilityLabel={reason.label}
              style={styles.reasonChip}
              onPress={() => {
                if (reason.code === "other") return; // wait for text input below
                onException(pickingReasonFor, reason.code);
                setPickingReasonFor(null);
              }}
            >
              <Text>{reason.label}</Text>
            </Pressable>
          ))}
          <TextInput
            style={styles.otherInput}
            placeholder="Describe the reason"
            accessibilityLabel="Other reason, describe"
            value={otherText}
            onChangeText={setOtherText}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Submit other reason"
            style={[styles.actionButton, styles.completeButton, !otherText.trim() && styles.actionButtonDisabled]}
            disabled={!otherText.trim()}
            onPress={() => {
              onException(pickingReasonFor, "other", otherText.trim());
              setPickingReasonFor(null);
              setOtherText("");
            }}
          >
            <Text style={styles.actionButtonText}>Submit</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setPickingReasonFor(null)}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#ddd" },
  title: { fontSize: 17, fontWeight: "700" },
  instructions: { fontSize: 15, color: "#333", marginTop: 4 },
  state: { fontSize: 14, color: "#555", marginTop: 6, fontStyle: "italic" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  actionButton: {
    borderWidth: 2,
    borderColor: "#1a1a1a",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: "center",
  },
  actionButtonDisabled: { opacity: 0.5 },
  completeButton: { backgroundColor: "#157a3d", borderColor: "#157a3d" },
  photoButton: { backgroundColor: "#0b5fff", borderColor: "#0b5fff" },
  photoState: { fontSize: 14, fontWeight: "600", marginTop: 4 },
  clientNote: { fontSize: 15, fontWeight: "600", color: "#8a1c1c", marginTop: 4 },
  actionButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  actionButtonTextDark: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
  reported: { fontSize: 14, fontWeight: "600", color: "#6b4e00", marginTop: 6 },
  reportLink: { marginTop: 8, minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  reportLinkText: { fontSize: 15, fontWeight: "600", color: "#1a1a1a", textDecorationLine: "underline" },
  reasonPicker: { marginTop: 12, gap: 8 },
  reasonPrompt: { fontSize: 15, fontWeight: "600" },
  reasonChip: {
    borderWidth: 1,
    borderColor: "#888",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: "center",
  },
  otherInput: {
    borderWidth: 1,
    borderColor: "#888",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  cancelText: { color: "#b00020", fontSize: 15, textAlign: "center", paddingVertical: 8 },
});
