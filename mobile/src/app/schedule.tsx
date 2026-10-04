import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  cancelShift,
  createRecurringRule,
  createShift,
  generateSchedule,
  getScheduleContext,
  listShifts,
  replaceShift,
  type AdminShift,
  type GenerationResult,
  type ScheduleContext,
  type ShiftStatus,
} from "@/lib/api";
import { addDays, formatDay, formatHours, formatRange, formatTime, localTimeOf, todayIn, weekStartFor } from "@/lib/dates";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";
import { ShiftForm, type ShiftFormValue } from "@/components/ShiftForm";
import { CancelShiftForm } from "@/components/CancelShiftForm";
import { RecurringCard } from "@/components/RecurringCard";

const STATUS_LABELS: Record<ShiftStatus, string> = {
  SCHEDULED: "Working",
  VACATION: "Vacation",
  SICK: "Sick",
  CLIENT_UNAVAILABLE: "Client unavailable",
  NOT_SCHEDULED: "Not scheduled",
};

type Panel = { kind: "add" | "change" | "cancel"; date: string };

export default function ScheduleScreen() {
  const { token, user, signOut } = useAuth();
  const [ctx, setCtx] = useState<ScheduleContext | null>(null);
  const [ipId, setIpId] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [shifts, setShifts] = useState<AdminShift[]>([]);
  // When the shifts were loaded; used to decide which are still in the future (and so changeable).
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleMessage, setRuleMessage] = useState<string | null>(null);
  const [ruleResults, setRuleResults] = useState<GenerationResult[] | null>(null);

  useEffect(() => {
    if (!token || user?.role === "IP" || user?.role === "FAMILY") return;
    (async () => {
      try {
        const context = await getScheduleContext(token);
        setCtx(context);
        setIpId(context.ips[0]?.id ?? null);
        setWeekStart(weekStartFor(todayIn(context.household.timezone), context.household.workweekStartWeekday));
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Could not load the schedule.");
        setLoading(false);
      }
    })();
  }, [token, user?.role]);

  const loadShifts = useCallback(async () => {
    if (!token || !weekStart) return;
    try {
      const result = await listShifts(token, weekStart, addDays(weekStart, 6));
      setShifts(result.shifts);
      setLoadedAt(Date.now());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load shifts.");
    }
  }, [token, weekStart]);

  useEffect(() => {
    (async () => {
      await loadShifts();
      setLoading(false);
    })();
  }, [loadShifts]);

  const days = useMemo(() => (weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : []), [weekStart]);
  const ipShifts = useMemo(() => shifts.filter((s) => s.ipUserId === ipId), [shifts, ipId]);
  const shiftByDate = useMemo(() => new Map(ipShifts.map((s) => [s.localDate, s])), [ipShifts]);

  const scheduledMinutes = useMemo(
    () =>
      ipShifts
        .filter((s) => s.status === "SCHEDULED")
        .reduce((sum, s) => sum + Math.round((Date.parse(s.scheduledEndUtc) - Date.parse(s.scheduledStartUtc)) / 60_000), 0),
    [ipShifts]
  );

  if (user && (user.role === "IP" || user.role === "FAMILY")) return <Redirect href={user.role === "IP" ? "/home" : "/review"} />;

  if (loading || !ctx || !weekStart) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading schedule" />}
      </View>
    );
  }

  const cap = ctx.household.weeklyHourCapMinutes;
  const tz = ctx.household.timezone;
  const remaining = Math.max(0, cap - scheduledMinutes);
  const full = remaining === 0;
  const today = todayIn(tz);
  const thisWeek = weekStartFor(today, ctx.household.workweekStartWeekday);

  function openPanel(kind: Panel["kind"], date: string) {
    setPanel({ kind, date });
    setFormError(null);
  }

  function closePanel() {
    setPanel(null);
    setFormError(null);
  }

  async function run(action: () => Promise<unknown>) {
    setFormBusy(true);
    setFormError(null);
    try {
      await action();
      setPanel(null);
      await loadShifts();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save. Check your connection and try again.");
    } finally {
      setFormBusy(false);
    }
  }

  const onAdd = (date: string, v: ShiftFormValue) =>
    run(() => createShift(token!, { ipUserId: ipId!, localDate: date, status: v.status, startLocal: v.startLocal, endLocal: v.endLocal }));

  const onChange = (shift: AdminShift, v: ShiftFormValue) =>
    run(() =>
      replaceShift(token!, shift.id, {
        localDate: shift.localDate,
        status: v.status,
        startLocal: v.startLocal,
        endLocal: v.endLocal,
        reason: v.reason ?? "",
      })
    );

  const onCancelShift = (shift: AdminShift, reason: string) => run(() => cancelShift(token!, shift.id, reason));

  async function onSaveRule(value: { weekday: number; startLocal: string; endLocal: string }) {
    if (!token || !ipId || !weekStart) return;
    setRuleBusy(true);
    setRuleMessage(null);
    setRuleResults(null);
    try {
      await createRecurringRule(token, { ipUserId: ipId, effectiveFrom: weekStart, ...value });
      setRuleMessage("Pattern saved. Choose Fill next 4 weeks to add the days to the schedule.");
    } catch (err) {
      setRuleMessage(err instanceof ApiError ? err.message : "Could not save the pattern.");
    } finally {
      setRuleBusy(false);
    }
  }

  async function onGenerate() {
    if (!token || !weekStart) return;
    setRuleBusy(true);
    setRuleMessage(null);
    try {
      const { results } = await generateSchedule(token, weekStart, addDays(weekStart, 27));
      setRuleResults(results);
      await loadShifts();
    } catch (err) {
      setRuleResults(null);
      setRuleMessage(err instanceof ApiError ? err.message : "Could not fill the schedule.");
    } finally {
      setRuleBusy(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await loadShifts();
    setRefreshing(false);
  }

  function changeWeek(delta: number) {
    closePanel();
    setRuleResults(null);
    setRuleMessage(null);
    setWeekStart(addDays(weekStart!, delta * 7));
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <HomeBar />

      <Text style={styles.title} accessibilityRole="header">
        Schedule
      </Text>

      {ctx.ips.length === 0 ? (
        <Text style={styles.body}>There is no active IP in this household yet.</Text>
      ) : ctx.ips.length === 1 ? (
        <Text style={styles.body}>Scheduling: {ctx.ips[0]!.name}</Text>
      ) : (
        <View style={styles.row} accessibilityRole="radiogroup">
          {ctx.ips.map((ip) => (
            <Chip key={ip.id} label={ip.name} selected={ipId === ip.id} onPress={() => setIpId(ip.id)} />
          ))}
        </View>
      )}

      <View style={styles.weekNav}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous week" onPress={() => changeWeek(-1)} style={styles.navButton}>
          <Text style={styles.navText}>‹ Prev</Text>
        </Pressable>
        <Text style={styles.weekLabel} accessibilityRole="header" accessibilityLiveRegion="polite">
          {formatRange(weekStart, addDays(weekStart, 6))}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next week" onPress={() => changeWeek(1)} style={styles.navButton}>
          <Text style={styles.navText}>Next ›</Text>
        </Pressable>
      </View>
      {weekStart !== thisWeek && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to this week"
          onPress={() => {
            closePanel();
            setWeekStart(thisWeek);
          }}
          style={styles.thisWeek}
        >
          <Text style={styles.thisWeekText}>Jump to this week</Text>
        </Pressable>
      )}

      <View style={styles.hoursCard} accessible accessibilityLabel={`${formatHours(scheduledMinutes)} of ${formatHours(cap)} hours scheduled this week. ${formatHours(remaining)} hours remaining.`}>
        <Text style={styles.hoursText}>
          {formatHours(scheduledMinutes)} of {formatHours(cap)} hours scheduled
        </Text>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, full && styles.barFull, { width: `${Math.min(100, (scheduledMinutes / cap) * 100)}%` }]} />
        </View>
        <Text style={styles.hoursSub}>{full ? "Weekly limit reached. No more hours can be added this week." : `${formatHours(remaining)} hours left this week`}</Text>
      </View>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}

      {days.map((date) => {
        const shift = shiftByDate.get(date);
        const here = panel?.date === date ? panel.kind : null;
        // Started or finished shifts are part of the attendance record and cannot be changed.
        const editable = shift ? !shift.checkInEventId && (shift.status !== "SCHEDULED" || Date.parse(shift.scheduledEndUtc) > loadedAt) : false;
        return (
          <View key={date} style={styles.day}>
            <View style={styles.dayHeader}>
              <Text style={styles.dayName} accessibilityRole="header">
                {formatDay(date)}
              </Text>
              {date === today && <Text style={styles.today}>Today</Text>}
            </View>

            {shift ? (
              <View style={styles.shiftBlock}>
                <Text style={styles.shiftText}>
                  {shift.status === "SCHEDULED"
                    ? `${formatTime(shift.scheduledStartUtc, tz)} – ${formatTime(shift.scheduledEndUtc, tz)}`
                    : STATUS_LABELS[shift.status]}
                  {shift.status === "SCHEDULED" && shift.recurringSourceId ? "  (weekly pattern)" : ""}
                </Text>
                {shift.previous && (
                  <Text style={styles.sub}>
                    Changed. Previously{" "}
                    {shift.previous.status === "SCHEDULED"
                      ? `${formatTime(shift.previous.scheduledStartUtc, tz)} – ${formatTime(shift.previous.scheduledEndUtc, tz)}`
                      : STATUS_LABELS[shift.previous.status]}
                    .
                  </Text>
                )}
                {shift.checkOutEventId ? (
                  <Text style={styles.sub}>Checked out</Text>
                ) : shift.checkInEventId ? (
                  <Text style={styles.sub}>Checked in, shift in progress</Text>
                ) : null}

                {here === "change" ? (
                  <ShiftForm
                    localDate={date}
                    mode="change"
                    initial={{
                      status: shift.status,
                      start: shift.status === "SCHEDULED" ? localTimeOf(shift.scheduledStartUtc, tz) : "09:00",
                      end: shift.status === "SCHEDULED" ? localTimeOf(shift.scheduledEndUtc, tz) : "15:00",
                    }}
                    busy={formBusy}
                    error={formError}
                    onSubmit={(v) => onChange(shift, v)}
                    onCancel={closePanel}
                  />
                ) : here === "cancel" ? (
                  <CancelShiftForm
                    localDate={date}
                    busy={formBusy}
                    error={formError}
                    onConfirm={(reason) => onCancelShift(shift, reason)}
                    onKeep={closePanel}
                  />
                ) : editable ? (
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Change the entry on ${formatDay(date)}`}
                      onPress={() => openPanel("change", date)}
                      style={styles.outlineButton}
                    >
                      <Text style={styles.outlineText}>Change</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel the entry on ${formatDay(date)}`}
                      onPress={() => openPanel("cancel", date)}
                      style={styles.dangerOutline}
                    >
                      <Text style={styles.dangerOutlineText}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : here === "add" ? (
              <ShiftForm
                localDate={date}
                busy={formBusy}
                error={formError}
                onSubmit={(v) => onAdd(date, v)}
                onCancel={closePanel}
              />
            ) : (
              <View style={styles.emptyRow}>
                <Text style={styles.sub}>Nothing scheduled</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Add a shift or time off on ${formatDay(date)}`}
                  onPress={() => openPanel("add", date)}
                  disabled={!ipId}
                  style={styles.add}
                >
                  <Text style={styles.addText}>Add</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}

      <RecurringCard
        busy={ruleBusy}
        message={ruleMessage}
        results={ruleResults}
        rangeLabel={formatRange(weekStart, addDays(weekStart, 27))}
        onSaveRule={onSaveRule}
        onGenerate={onGenerate}
      />

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
  body: { fontSize: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  weekNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  navButton: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
  navText: { fontSize: 16, fontWeight: "700" },
  weekLabel: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  thisWeek: { alignSelf: "center", minHeight: 44, justifyContent: "center" },
  thisWeekText: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  hoursCard: { backgroundColor: "#f2f2f2", borderRadius: 10, padding: 16, gap: 8 },
  hoursText: { fontSize: 18, fontWeight: "700" },
  hoursSub: { fontSize: 15, color: "#333" },
  barTrack: { height: 14, borderRadius: 7, backgroundColor: "#d9d9d9", overflow: "hidden" },
  barFill: { height: 14, backgroundColor: "#157a3d" },
  barFull: { backgroundColor: "#8a1c1c" },
  day: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 6 },
  dayHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  dayName: { fontSize: 17, fontWeight: "700" },
  today: { fontSize: 13, fontWeight: "700", color: "#fff", backgroundColor: "#0b5fff", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  shiftBlock: { gap: 6 },
  shiftText: { fontSize: 18, fontWeight: "600" },
  sub: { fontSize: 15, color: "#444" },
  emptyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  add: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 22, minHeight: 44, justifyContent: "center" },
  addText: { color: "#0b5fff", fontSize: 16, fontWeight: "700" },
  outlineButton: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 16, fontWeight: "700" },
  dangerOutline: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },
  dangerOutlineText: { color: "#8a1c1c", fontSize: 16, fontWeight: "700" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
