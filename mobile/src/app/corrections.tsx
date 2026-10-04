import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  appendCorrection,
  declineCorrectionRequest,
  getCorrections,
  getMe,
  getReviewDay,
  type CorrectionKind,
  type CorrectionsList,
  type ReviewShift,
  type ReviewTask,
} from "@/lib/api";
import { addDays, formatDateTime, formatDay, todayIn } from "@/lib/dates";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";

const KIND_LABEL: Record<CorrectionKind, string> = {
  COMPLETION_ERROR: "Completion recorded in error",
  ATTENDANCE: "Note about check-in or checkout",
  NOTE: "Other note",
};

const KIND_HELP: Record<CorrectionKind, string> = {
  COMPLETION_ERROR: "The task stops counting as done and the IP can do it again while the visit is open. The original record stays.",
  ATTENDANCE: "A note beside the recorded time. The recorded check-in and checkout times are never changed.",
  NOTE: "A note linked to the recorded step. Nothing is changed.",
};

const STEP_LABEL: Record<string, string> = {
  task_completed: "Marked done",
  evidence_accepted: "Photo accepted",
  task_disputed: "Disputed",
  task_corrective_submitted: "Corrected work submitted",
  task_approved: "Approved",
  task_decline_reported: "Decline reported",
  task_decline_confirmed: "Decline confirmed",
  task_decline_denied: "Decline not accepted",
  task_marked_not_needed: "Marked not needed",
  task_marked_unable: "Marked unable",
  check_in: "Check-in",
  check_out: "Checkout",
};

interface Target {
  title: string;
  kinds: CorrectionKind[];
  steps: { eventId: string; label: string }[];
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export default function CorrectionsScreen() {
  const { token, user } = useAuth();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const [tz, setTz] = useState<string | null>(null);
  const [data, setData] = useState<CorrectionsList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [date, setDate] = useState("");
  const [shifts, setShifts] = useState<ReviewShift[] | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [showDeclined, setShowDeclined] = useState(false);

  useEffect(() => {
    if (!token || !staff) return;
    getMe(token)
      .then((me) => {
        setTz(me.household.timezone);
        setDate(todayIn(me.household.timezone));
      })
      .catch(() => setLoadError("Could not load. Check your connection."));
  }, [token, staff]);

  const load = useCallback(async () => {
    if (!token || !staff) return;
    try {
      setData(await getCorrections(token));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Could not load corrections. Check your connection."));
    }
  }, [token, staff]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );
  useEffect(() => {
    const timer = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const loadDay = useCallback(async () => {
    if (!token || !staff || !date) return;
    try {
      setShifts((await getReviewDay(token, date)).shifts);
      setDayError(null);
    } catch (err) {
      setDayError(errorText(err, "Could not load that day."));
    }
  }, [token, staff, date]);

  useEffect(() => {
    (async () => {
      await loadDay();
    })();
  }, [loadDay]);

  if (user && !staff) return <Redirect href="/home" />;

  if (!data || !tz) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading corrections" />}
      </View>
    );
  }

  const done = async (text: string) => {
    setNotice(text);
    setTarget(null);
    await Promise.all([load(), loadDay()]);
  };

  const taskTarget = (shift: ReviewShift, task: ReviewTask): Target => ({
    title: `${task.title} (${formatDay(date)}, ${shift.ipName})`,
    kinds: ["COMPLETION_ERROR", "NOTE"],
    steps: task.history
      .filter((h) => h.eventId && !h.action.startsWith("correction_"))
      .map((h) => ({ eventId: h.eventId!, label: `${STEP_LABEL[h.action] ?? h.action}${h.at ? ` · ${formatDateTime(h.at, tz)}` : ""}` }))
      .reverse(),
  });

  const attendanceTarget = (shift: ReviewShift): Target => ({
    title: `Check-in and checkout, ${formatDay(date)} (${shift.ipName})`,
    kinds: ["ATTENDANCE", "NOTE"],
    steps: [
      ...(shift.checkInEventId ? [{ eventId: shift.checkInEventId, label: `Check-in${shift.observedCheckInUtc ? ` · ${formatDateTime(shift.observedCheckInUtc, tz)}` : ""}` }] : []),
      ...(shift.checkOutEventId ? [{ eventId: shift.checkOutEventId, label: `Checkout${shift.observedCheckOutUtc ? ` · ${formatDateTime(shift.observedCheckOutUtc, tz)}` : ""}` }] : []),
    ],
  });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await Promise.all([load(), loadDay()]);
            setRefreshing(false);
          }}
        />
      }
    >
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Corrections
      </Text>
      <Text style={styles.help}>
        If a mistake was recorded, you add a correction. The original record is never changed or removed: the correction sits beside it with who made it and why. The IP can report a mistake, but only you can add the correction.
      </Text>
      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}
      {notice && (
        <Text style={styles.ok} accessibilityLiveRegion="polite">
          ✓ {notice}
        </Text>
      )}

      <Text style={styles.section} accessibilityRole="header">
        Reports from the IP ({data.open.length})
      </Text>
      {data.open.length === 0 && <Text style={styles.empty}>Nothing is waiting.</Text>}
      {data.open.map((r) => (
        <RequestCard
          key={r.id}
          request={r}
          tz={tz}
          onAppend={async (kind, reason) => {
            await appendCorrection(token!, { kind, linkedEventId: r.linkedEventId, reason, requestId: r.id });
            await done("The correction was recorded and the IP was told.");
          }}
          onDecline={async (reason) => {
            await declineCorrectionRequest(token!, r.id, reason);
            await done("Your answer was recorded and the IP was told.");
          }}
        />
      ))}

      <Text style={styles.section} accessibilityRole="header">
        Add a correction
      </Text>
      <Text style={styles.small}>Choose the day, then the task or the visit the correction is about.</Text>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous day" onPress={() => setDate(addDays(date, -1))} style={styles.outline}>
          <Text style={styles.outlineText}>‹ Previous</Text>
        </Pressable>
        <Text style={styles.dayLabel}>{date ? formatDay(date) : ""}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next day" onPress={() => setDate(addDays(date, 1))} style={styles.outline}>
          <Text style={styles.outlineText}>Next ›</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Go to today" onPress={() => setDate(todayIn(tz))} style={styles.outline}>
          <Text style={styles.outlineText}>Today</Text>
        </Pressable>
      </View>
      {dayError && <Text style={styles.error}>{dayError}</Text>}
      {shifts && shifts.length === 0 && <Text style={styles.empty}>No visit on this day.</Text>}

      {target && (
        <CorrectionForm
          target={target}
          onCancel={() => setTarget(null)}
          onSave={async (kind, eventId, reason) => {
            await appendCorrection(token!, { kind, linkedEventId: eventId, reason });
            await done("The correction was recorded.");
          }}
        />
      )}

      {shifts?.map((shift) => {
        const withSteps = shift.tasks.filter((t) => t.history.some((h) => h.eventId && !h.action.startsWith("correction_")));
        return (
          <View key={shift.id} style={styles.card}>
            <Text style={styles.cardTitle} accessibilityRole="header">
              {shift.ipName}
            </Text>
            {(shift.checkInEventId || shift.checkOutEventId) && (
              <Pressable accessibilityRole="button" accessibilityLabel="Add a note about the check-in or checkout" onPress={() => { setNotice(null); setTarget(attendanceTarget(shift)); }} style={styles.outline}>
                <Text style={styles.outlineText}>Add a note about the check-in or checkout</Text>
              </Pressable>
            )}
            {withSteps.length === 0 && <Text style={styles.small}>No task has anything recorded on it yet.</Text>}
            {withSteps.map((task) => (
              <View key={task.id} style={styles.taskRow}>
                <View style={styles.taskText}>
                  <Text style={styles.itemTitle}>{task.title}</Text>
                  <Text style={styles.small}>{STATE_TEXT[task.state] ?? task.state}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`Correct ${task.title}`} onPress={() => { setNotice(null); setTarget(taskTarget(shift, task)); }} style={styles.outline}>
                  <Text style={styles.outlineText}>Correct</Text>
                </Pressable>
              </View>
            ))}
          </View>
        );
      })}

      <Text style={styles.section} accessibilityRole="header">
        Corrections recorded ({data.corrections.length})
      </Text>
      {data.corrections.length === 0 && <Text style={styles.empty}>None yet.</Text>}
      {data.corrections.map((c) => (
        <View key={c.id} style={styles.card}>
          <Text style={styles.itemTitle}>
            {KIND_LABEL[c.kind]}: {c.about}
          </Text>
          <Text style={styles.body}>{c.reason}</Text>
          <Text style={styles.small}>
            By {c.by} · {formatDateTime(c.createdAt, tz)}
            {c.linkedAction ? ` · about: ${STEP_LABEL[c.linkedAction] ?? c.linkedAction}${c.linkedAt ? ` (${formatDateTime(c.linkedAt, tz)})` : ""}` : ""}
            {c.answeredRequest ? " · answered an IP report" : ""}
          </Text>
        </View>
      ))}

      {data.declined.length > 0 && (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDeclined }} onPress={() => setShowDeclined((v) => !v)} style={styles.outline}>
            <Text style={styles.outlineText}>{showDeclined ? "Hide" : "Show"} reports answered without a correction ({data.declined.length})</Text>
          </Pressable>
          {showDeclined &&
            data.declined.map((d) => (
              <View key={d.id} style={styles.card}>
                <Text style={styles.itemTitle}>{d.about}</Text>
                <Text style={styles.small}>
                  {d.requestedBy} said: {d.reason}
                </Text>
                <Text style={styles.body}>
                  {d.decidedBy ?? "Someone"} answered: {d.declineReason}
                </Text>
              </View>
            ))}
        </>
      )}
    </ScrollView>
  );
}

const STATE_TEXT: Record<string, string> = {
  COMPLETED_AWAITING_REVIEW: "Done, waiting for the client's review",
  CORRECTIVE_WORK_SUBMITTED: "Corrected work submitted",
  APPROVED: "Approved",
  DISPUTED: "Disputed",
  DECLINED_AWAITING_CONFIRMATION: "Decline waiting for the client",
  CLIENT_DECLINED_CONFIRMED: "Declined (confirmed)",
  NOT_NEEDED: "Marked not needed",
  UNABLE_TO_COMPLETE: "Marked unable",
  MISSED_AT_SHIFT_END: "Missed",
  COMPLETION_ERROR_CORRECTED: "Recorded in error and corrected",
  NOT_STARTED: "Not done yet",
  IN_PROGRESS: "In progress",
};

function RequestCard({
  request,
  tz,
  onAppend,
  onDecline,
}: {
  request: CorrectionsList["open"][number];
  tz: string;
  onAppend: (kind: CorrectionKind, reason: string) => Promise<void>;
  onDecline: (reason: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"none" | "append" | "decline">("none");
  const kinds: CorrectionKind[] = request.isTask ? ["COMPLETION_ERROR", "NOTE"] : ["ATTENDANCE", "NOTE"];
  const [kind, setKind] = useState<CorrectionKind>(kinds[0]!);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "append") await onAppend(kind, reason);
      else await onDecline(reason);
    } catch (err) {
      setError(errorText(err, "That did not go through. Try again."));
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, styles.requestCard]}>
      <Text style={styles.itemTitle}>
        {request.requestedBy} reported a mistake: {request.about}
      </Text>
      <Text style={styles.body}>“{request.reason}”</Text>
      <Text style={styles.small}>
        Reported {formatDateTime(request.requestedAt, tz)}
        {request.taskState ? ` · the task is now: ${STATE_TEXT[request.taskState] ?? request.taskState}` : ""}
      </Text>

      {mode === "none" ? (
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Add a correction for ${request.about}`} onPress={() => { setMode("append"); setKind(kinds[0]!); }} style={styles.primary}>
            <Text style={styles.primaryText}>Add a correction</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Do not correct ${request.about}`} onPress={() => setMode("decline")} style={styles.outline}>
            <Text style={styles.outlineText}>Do not correct</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.form}>
          {mode === "append" && (
            <>
              <View style={styles.row} accessibilityRole="radiogroup">
                {kinds.map((k) => (
                  <Chip key={k} label={KIND_LABEL[k]} selected={kind === k} onPress={() => setKind(k)} />
                ))}
              </View>
              <Text style={styles.small}>{KIND_HELP[kind]}</Text>
            </>
          )}
          <Text style={styles.label}>{mode === "append" ? "Why (this is kept with the correction and shown to the IP)" : "Why this is not being corrected (shown to the IP)"}</Text>
          <TextInput style={styles.input} accessibilityLabel={mode === "append" ? "Reason for the correction" : "Reason for not correcting"} multiline value={reason} onChangeText={setReason} editable={!busy} />
          {error && (
            <Text style={styles.error} role="alert">
              {error}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={mode === "append" ? "Save the correction" : "Save the answer"} disabled={busy || reason.trim().length < 3} onPress={submit} style={[styles.primary, (busy || reason.trim().length < 3) && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? "Saving…" : mode === "append" ? "Save the correction" : "Save the answer"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { setMode("none"); setReason(""); setError(null); }} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function CorrectionForm({ target, onSave, onCancel }: { target: Target; onSave: (kind: CorrectionKind, eventId: string, reason: string) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<CorrectionKind>(target.kinds[0]!);
  const [eventId, setEventId] = useState<string | null>(target.steps[0]?.eventId ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!eventId) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(kind, eventId, reason);
    } catch (err) {
      setError(errorText(err, "That did not go through. Try again."));
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, styles.formCard]}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Correct: {target.title}
      </Text>
      <Text style={styles.label}>What kind of correction?</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {target.kinds.map((k) => (
          <Chip key={k} label={KIND_LABEL[k]} selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <Text style={styles.small}>{KIND_HELP[kind]}</Text>
      <Text style={styles.label}>Which recorded step is it about?</Text>
      {target.steps.length === 0 && <Text style={styles.error}>There is no recorded step to link to.</Text>}
      <View style={styles.row} accessibilityRole="radiogroup">
        {target.steps.map((s) => (
          <Chip key={s.eventId} label={s.label} selected={eventId === s.eventId} onPress={() => setEventId(s.eventId)} />
        ))}
      </View>
      <Text style={styles.label}>Why (kept with the correction)</Text>
      <TextInput style={styles.input} accessibilityLabel="Reason for the correction" multiline value={reason} onChangeText={setReason} editable={!busy} />
      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Save the correction" disabled={busy || !eventId || reason.trim().length < 3} onPress={save} style={[styles.primary, (busy || !eventId || reason.trim().length < 3) && styles.disabled]}>
          <Text style={styles.primaryText}>{busy ? "Saving…" : "Save the correction"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} style={styles.outline}>
          <Text style={styles.outlineText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 110, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 26, fontWeight: "700", color: "#1a1a1a" },
  help: { fontSize: 16, color: "#333", lineHeight: 22 },
  section: { fontSize: 19, fontWeight: "700", color: "#1a1a1a", marginTop: 10 },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  body: { fontSize: 16, color: "#222", lineHeight: 22 },
  empty: { fontSize: 16, color: "#444" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  ok: { color: "#2d6a2d", fontSize: 16, fontWeight: "700" },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  dayLabel: { fontSize: 17, fontWeight: "700", color: "#1a1a1a", flexGrow: 1, textAlign: "center" },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 12, gap: 8 },
  requestCard: { borderColor: "#6b4e00", backgroundColor: "#fffbe6" },
  formCard: { backgroundColor: "#f4f8ff" },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#111" },
  taskRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 8 },
  taskText: { flex: 1, gap: 2 },
  form: { gap: 8 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 80, textAlignVertical: "top", backgroundColor: "#fff" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
});
