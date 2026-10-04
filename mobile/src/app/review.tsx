import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  approveTask,
  confirmDecline,
  denyDecline,
  addComment,
  disputeTask,
  getMe,
  getReviewDay,
  getReviewPending,
  type ReviewShift,
  type ReviewTask,
} from "@/lib/api";
import { addDays, formatDay, formatTime, todayIn } from "@/lib/dates";
import { HomeBar } from "@/components/HomeBar";
import { ReviewTaskCard } from "@/components/ReviewTaskCard";

const DECISION_STATES = new Set(["COMPLETED_AWAITING_REVIEW", "CORRECTIVE_WORK_SUBMITTED", "DECLINED_AWAITING_CONFIRMATION"]);

function summarize(tasks: ReviewTask[]): string {
  const n = (f: (t: ReviewTask) => boolean) => tasks.filter(f).length;
  const parts = [
    [n((t) => t.state === "APPROVED"), "approved"],
    [n((t) => DECISION_STATES.has(t.state)), "waiting for a decision"],
    [n((t) => t.state === "DISPUTED"), "disputed"],
    [n((t) => t.state === "NOT_STARTED" || t.state === "IN_PROGRESS" || t.state === "COMPLETION_ERROR_CORRECTED"), "not done"],
    [n((t) => ["CLIENT_DECLINED_CONFIRMED", "NOT_NEEDED", "UNABLE_TO_COMPLETE", "MISSED_AT_SHIFT_END"].includes(t.state)), "not completed"],
  ] as const;
  const shown = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return `${tasks.length} task${tasks.length === 1 ? "" : "s"}${shown.length ? `: ${shown.join(", ")}` : ""}`;
}

export default function ReviewScreen() {
  const { token, user, signOut } = useAuth();
  const [timezone, setTimezone] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [pending, setPending] = useState<ReviewTask[]>([]);
  const [shifts, setShifts] = useState<ReviewShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deferred, setDeferred] = useState<Set<string>>(new Set());
  const [showDeferred, setShowDeferred] = useState(false);

  const canDecide = user?.role === "CLIENT";

  useEffect(() => {
    if (!token || user?.role === "IP") return;
    (async () => {
      try {
        const me = await getMe(token);
        setTimezone(me.household.timezone);
        setDate(todayIn(me.household.timezone));
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Could not load.");
        setLoading(false);
      }
    })();
  }, [token, user?.role]);

  const load = useCallback(async () => {
    if (!token || !date || user?.role === "IP") return;
    try {
      const [p, d] = await Promise.all([getReviewPending(token), getReviewDay(token, date)]);
      setPending(p.tasks);
      setShifts(d.shifts);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the review list.");
    }
  }, [token, date, user?.role]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  // Coming back to this screen: show anything the IP has finished since.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const open = useMemo(() => pending.filter((t) => !deferred.has(t.id)), [pending, deferred]);
  const later = useMemo(() => pending.filter((t) => deferred.has(t.id)), [pending, deferred]);

  if (user && user.role === "IP") return <Redirect href="/home" />;

  if (loading || !timezone || !date) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading review" />}
      </View>
    );
  }

  const tz = timezone;
  const today = todayIn(tz);

  async function act(taskId: string, action: () => Promise<unknown>) {
    setBusyId(taskId);
    setErrors((e) => ({ ...e, [taskId]: "" }));
    try {
      await action();
      setDeferred((d) => {
        const next = new Set(d);
        next.delete(taskId);
        return next;
      });
      await load();
    } catch (err) {
      setErrors((e) => ({ ...e, [taskId]: err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again." }));
      // If someone else already decided it, show the current state.
      if (err instanceof ApiError && err.code === "ALREADY_DECIDED") await load();
    } finally {
      setBusyId(null);
    }
  }

  function card(task: ReviewTask, opts: { showDay?: boolean; later?: boolean } = {}) {
    return (
      <ReviewTaskCard
        key={`${opts.later ? "later-" : ""}${task.id}`}
        task={task}
        token={token!}
        timezone={tz}
        canDecide={canDecide}
        showDay={opts.showDay}
        busy={busyId === task.id}
        error={errors[task.id] || null}
        onApprove={() => act(task.id, () => approveTask(token!, task.id))}
        onDispute={(reason) => act(task.id, () => disputeTask(token!, task.id, reason))}
        onConfirmDecline={() => act(task.id, () => confirmDecline(token!, task.id))}
        onDenyDecline={(note) => act(task.id, () => denyDecline(token!, task.id, note))}
        onLater={opts.later ? undefined : () => setDeferred((d) => new Set(d).add(task.id))}
        onComment={(body, evidenceId) => comment(task.id, body, evidenceId)}
      />
    );
  }

  async function comment(taskId: string, body: string, evidenceId?: string) {
    try {
      await addComment(token!, taskId, body, evidenceId);
    } catch (err) {
      throw new Error(err instanceof ApiError ? err.message : "The comment could not be saved. Check your connection and try again.");
    }
    await load();
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <HomeBar />

      <Text style={styles.title} accessibilityRole="header">
        Review
      </Text>
      <Text style={styles.help}>
        {canDecide
          ? "Approve the work you are happy with, or dispute it and say what to fix. Every decision is recorded."
          : user?.role === "FAMILY"
            ? "See how the care is going and leave comments. Only the client can approve or dispute the work."
            : "You can see everything here, including photos. Only the client can approve or dispute the IP's work."}
      </Text>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}

      <Text style={styles.section} accessibilityRole="header">
        {canDecide ? "Needs your decision" : "Waiting on the client"} ({open.length})
      </Text>
      {open.length === 0 ? (
        <Text style={styles.empty}>{pending.length === 0 ? "Nothing is waiting right now." : "Nothing else is waiting. Some items are saved for later."}</Text>
      ) : (
        open.map((t) => card(t, { showDay: true }))
      )}

      {later.length > 0 && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDeferred }}
            accessibilityLabel={`${showDeferred ? "Hide" : "Show"} ${later.length} items saved for later`}
            onPress={() => setShowDeferred(!showDeferred)}
            style={styles.linkButton}
          >
            <Text style={styles.link}>
              {showDeferred ? "Hide" : "Show"} {later.length} saved for later
            </Text>
          </Pressable>
          {showDeferred && later.map((t) => card(t, { showDay: true, later: true }))}
        </>
      )}

      <Text style={styles.section} accessibilityRole="header">
        Day
      </Text>
      <View style={styles.dayNav}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous day" onPress={() => setDate(addDays(date, -1))} style={styles.navButton}>
          <Text style={styles.navText}>‹ Prev</Text>
        </Pressable>
        <Text style={styles.dayLabel} accessibilityRole="header" accessibilityLiveRegion="polite">
          {formatDay(date)}
          {date === today ? " (today)" : ""}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next day" onPress={() => setDate(addDays(date, 1))} style={styles.navButton}>
          <Text style={styles.navText}>Next ›</Text>
        </Pressable>
      </View>
      {date !== today && (
        <Pressable accessibilityRole="button" accessibilityLabel="Jump to today" onPress={() => setDate(today)} style={styles.linkButton}>
          <Text style={styles.link}>Jump to today</Text>
        </Pressable>
      )}

      {shifts.length === 0 ? (
        <Text style={styles.empty}>No shift on this day.</Text>
      ) : (
        shifts.map((s) => {
          const groups = [...new Set(s.tasks.map((t) => t.groupName))];
          return (
            <View key={s.id} style={styles.shift}>
              <Text style={styles.shiftTitle}>
                {s.ipName}: scheduled {formatTime(s.scheduledStartUtc, tz)} – {formatTime(s.scheduledEndUtc, tz)}
              </Text>
              <Text style={styles.meta}>
                {s.observedCheckInUtc ? `Checked in ${formatTime(s.observedCheckInUtc, tz)}` : "Did not check in"}
                {s.observedCheckOutUtc ? `, checked out ${formatTime(s.observedCheckOutUtc, tz)}` : s.observedCheckInUtc ? ", not checked out" : ""}
              </Text>
              {s.tasks.length === 0 ? (
                <Text style={styles.meta}>No tasks were assigned (they appear after check-in).</Text>
              ) : (
                <>
                  <Text style={styles.summary}>{summarize(s.tasks)}</Text>
                  {groups.map((g) => (
                    <View key={g} style={styles.group}>
                      <Text style={styles.groupName} accessibilityRole="header">
                        {g}
                      </Text>
                      {s.tasks.filter((t) => t.groupName === g).map((t) => card(t))}
                    </View>
                  ))}
                </>
              )}
            </View>
          );
        })
      )}

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 100, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 26, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  section: { fontSize: 20, fontWeight: "700", marginTop: 10 },
  empty: { fontSize: 15, color: "#444" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  linkButton: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  link: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  dayNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  navButton: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
  navText: { fontSize: 16, fontWeight: "700" },
  dayLabel: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  shift: { gap: 8, marginTop: 6 },
  shiftTitle: { fontSize: 17, fontWeight: "700" },
  meta: { fontSize: 14, color: "#444" },
  summary: { fontSize: 15, fontWeight: "600", backgroundColor: "#f2f2f2", borderRadius: 8, padding: 10 },
  group: { gap: 8, marginTop: 6 },
  groupName: { fontSize: 18, fontWeight: "700" },
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
