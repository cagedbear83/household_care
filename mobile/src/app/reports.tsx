import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, getMe, getProfile, getReport, type Report } from "@/lib/api";
import { formatDateTime, todayIn } from "@/lib/dates";
import { printHtml } from "@/lib/print";
import { reportToHtml } from "@/lib/report-html";
import { clock, isDate, minutesLabel, PERCENT_ROWS, pctLabel, RANGE_LABEL, rangeFor, rangeLabel, stepAnchor, TASK_ROWS, VISIT_STATUS, type RangeKind } from "@/lib/report-format";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";

const KINDS: RangeKind[] = ["day", "week", "month", "custom"];

export default function ReportsScreen() {
  const { token, user } = useAuth();
  const allowed = user?.role === "CLIENT" || user?.role === "ADMIN" || user?.role === "FAMILY";

  const [tz, setTz] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState(1);
  const [householdName, setHouseholdName] = useState<string | undefined>();

  const [kind, setKind] = useState<RangeKind>("week");
  const [anchor, setAnchor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [report, setReport] = useState<Report | null>(null);
  const [view, setView] = useState<"summary" | "attendance">("summary");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !allowed) return;
    (async () => {
      try {
        const [me, profile] = await Promise.all([getMe(token), getProfile(token)]);
        const today = todayIn(me.household.timezone);
        setTz(me.household.timezone);
        setWeekStart(me.household.workweekStartWeekday);
        setHouseholdName(profile.profile.household.name);
        setAnchor(today);
        setFrom(today);
        setTo(today);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load. Check your connection.");
      }
    })();
  }, [token, allowed]);

  const covered = useCallback((): { from: string; to: string } | null => {
    if (kind === "custom") return isDate(from) && isDate(to) ? { from, to } : null;
    return isDate(anchor) ? rangeFor(kind, anchor, weekStart) : null;
  }, [kind, anchor, from, to, weekStart]);

  if (user && !allowed) return <Redirect href="/home" />;

  async function show() {
    const range = covered();
    if (!range) return setError("Enter dates as year-month-day, for example 2026-10-03.");
    if (range.from > range.to) return setError("The start date must not be after the end date.");
    setBusy(true);
    setError(null);
    setPrintError(null);
    try {
      const result = await getReport(token!, range.from, range.to);
      setReport(result);
      setView("summary");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not make the report. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    if (!report) return;
    setPrintError(null);
    try {
      await printHtml(reportToHtml(report, householdName));
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "Could not open the print window.");
    }
  }

  if (!tz) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading" />}
      </View>
    );
  }

  const range = covered();
  const stepKind = kind === "custom" ? null : kind;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Reports
      </Text>
      <Text style={styles.help}>
        Choose the dates, then show the report. It is made when you ask and is not saved by the app. You can print it or save it as a PDF.
      </Text>

      <Text style={styles.section} accessibilityRole="header">
        Dates
      </Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {KINDS.map((k) => (
          <Chip key={k} label={RANGE_LABEL[k]} selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>

      {stepKind ? (
        <View style={styles.card}>
          <Text style={styles.label}>{kind === "day" ? "Day" : kind === "week" ? "Any day in the week" : "Any day in the month"} (year-month-day)</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Previous ${kind}`} onPress={() => isDate(anchor) && setAnchor(stepAnchor(stepKind, anchor, -1))} style={styles.outline}>
              <Text style={styles.outlineText}>‹ Previous</Text>
            </Pressable>
            <TextInput style={[styles.input, styles.dateInput]} accessibilityLabel="Date" value={anchor} onChangeText={setAnchor} placeholder="2026-10-03" autoCapitalize="none" autoCorrect={false} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Next ${kind}`} onPress={() => isDate(anchor) && setAnchor(stepAnchor(stepKind, anchor, 1))} style={styles.outline}>
              <Text style={styles.outlineText}>Next ›</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Go to today" onPress={() => setAnchor(todayIn(tz))} style={styles.outline}>
              <Text style={styles.outlineText}>Today</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>From (year-month-day)</Text>
          <TextInput style={styles.input} accessibilityLabel="From date" value={from} onChangeText={setFrom} placeholder="2026-10-01" autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.label}>To (year-month-day)</Text>
          <TextInput style={styles.input} accessibilityLabel="To date" value={to} onChangeText={setTo} placeholder="2026-10-31" autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.small}>Up to 366 days.</Text>
        </View>
      )}

      <Text style={styles.covers}>{range ? `This report covers ${rangeLabel(range.from, range.to)}.` : "Enter valid dates to see what the report will cover."}</Text>

      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}

      <Pressable accessibilityRole="button" accessibilityLabel="Show report" disabled={busy} onPress={show} style={[styles.primary, busy && styles.disabled]}>
        <Text style={styles.primaryText}>{busy ? "Making the report…" : "Show report"}</Text>
      </Pressable>

      {report && (
        <ReportView report={report} view={view} setView={setView} onPrint={print} printError={printError} />
      )}
    </ScrollView>
  );
}

function Line({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={[styles.lineLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.lineValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

function ReportView({ report, view, setView, onPrint, printError }: { report: Report; view: "summary" | "attendance"; setView: (v: "summary" | "attendance") => void; onPrint: () => void; printError: string | null }) {
  const { meta, tasks, attendance, exceptions } = report;
  const tz = meta.timezone;

  return (
    <View style={styles.report}>
      <View style={styles.card} accessibilityLabel="About this report">
        <Text style={styles.cardTitle} accessibilityRole="header">
          {rangeLabel(meta.from, meta.to)}
        </Text>
        <Text style={styles.small}>
          {meta.days} day{meta.days === 1 ? "" : "s"} · Timezone: {tz}
        </Text>
        <Text style={styles.small}>
          Created {formatDateTime(meta.generatedAt, tz)} by {meta.generatedBy.name}
        </Text>
        {meta.scope === "tasks_only" && <Text style={styles.small}>This shows task results only. Attendance and exceptions need the client&apos;s approval to see times.</Text>}
      </View>

      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Print or save as PDF" onPress={onPrint} style={styles.primary}>
          <Text style={styles.primaryText}>Print or save as PDF</Text>
        </Pressable>
      </View>
      {printError && (
        <Text style={styles.error} role="alert">
          {printError}
        </Text>
      )}

      {attendance && (
        <View style={styles.row} accessibilityRole="radiogroup">
          <Chip label="Task results" selected={view === "summary"} onPress={() => setView("summary")} />
          <Chip label="Attendance and exceptions" selected={view === "attendance"} onPress={() => setView("attendance")} />
        </View>
      )}

      {(view === "summary" || !attendance) && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Task results
          </Text>
          <View style={styles.card}>
            {TASK_ROWS.map(([label, key]) => (
              <Line key={key} label={label} value={tasks.totals[key]} strong={key === "assigned"} />
            ))}
          </View>

          <Text style={styles.section} accessibilityRole="header">
            Percentages
          </Text>
          <View style={styles.card}>
            {PERCENT_ROWS.map((p) => (
              <View key={p.key} style={styles.percent}>
                <Line label={p.label} value={pctLabel(tasks.percentages[p.key])} strong />
                <Text style={styles.small}>{p.how}</Text>
              </View>
            ))}
            <Text style={styles.small}>
              Declines, not-needed and unable-to-complete are never counted as completed work. Resolved: {tasks.resolved}. Not yet resolved: {tasks.unresolved}.
            </Text>
          </View>

          {tasks.byDay.length > 0 && (
            <>
              <Text style={styles.section} accessibilityRole="header">
                By day
              </Text>
              <View style={styles.card}>
                {tasks.byDay.map((d) => (
                  <Text key={d.date} style={styles.rowText}>
                    {d.date}: {d.assigned} assigned, {d.submitted} submitted, {d.approved} approved, {d.disputed} disputed, {d.missed} not done
                  </Text>
                ))}
              </View>
            </>
          )}

          {tasks.byGroup.length > 0 && (
            <>
              <Text style={styles.section} accessibilityRole="header">
                By area
              </Text>
              <View style={styles.card}>
                {tasks.byGroup.map((g) => (
                  <Text key={g.group} style={styles.rowText}>
                    {g.group}: {g.assigned} assigned, {g.submitted} submitted, {g.approved} approved, {g.disputed} disputed, {g.missed} not done
                  </Text>
                ))}
              </View>
            </>
          )}

          <Text style={styles.section} accessibilityRole="header">
            Tasks that were not completed ({tasks.notCompletedTotal})
          </Text>
          <View style={styles.card}>
            {tasks.notCompleted.length === 0 && <Text style={styles.rowText}>None in these dates.</Text>}
            {tasks.notCompleted.map((t, i) => (
              <Text key={`${t.date}-${i}`} style={styles.rowText}>
                {t.date} · {t.group} · {t.title}: {t.outcome}
                {t.reason ? ` (${t.reason})` : ""}
              </Text>
            ))}
            {tasks.notCompletedTotal > tasks.notCompleted.length && <Text style={styles.small}>Showing the first {tasks.notCompleted.length}. Choose a shorter range to see the rest.</Text>}
          </View>
        </>
      )}

      {attendance && view === "attendance" && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Attendance
          </Text>
          <View style={styles.card}>
            <Line label="Visits scheduled" value={attendance.totals.visitsScheduled ?? 0} />
            <Line label="Visits attended" value={attendance.totals.visitsAttended ?? 0} />
            <Line label="Visits with no check-in" value={attendance.totals.visitsMissed ?? 0} />
            <Line label="Visits with no checkout recorded" value={attendance.totals.visitsWithoutCheckout ?? 0} />
            <Line label="Scheduled time" value={minutesLabel(attendance.totals.scheduledMinutes ?? 0)} />
            <Line label="Authorized time (counted toward the limit)" value={minutesLabel(attendance.totals.authorizedMinutes ?? 0)} strong />
            <Line label="Observed time (check-in to checkout)" value={minutesLabel(attendance.totals.observedMinutes ?? 0)} strong />
            <Text style={styles.small}>Authorized time stops at the authorized end, so it can be less than the time observed.</Text>
          </View>

          {attendance.weeks.length > 0 && (
            <>
              <Text style={styles.section} accessibilityRole="header">
                Weekly hours against the limit
              </Text>
              <View style={styles.card}>
                {attendance.weeks.map((w) => (
                  <Text key={w.weekStart} style={styles.rowText}>
                    {w.weekStart} to {w.weekEnd}: {minutesLabel(w.authorizedMinutes)} authorized of {minutesLabel(w.capMinutes)}
                    {w.overCap ? " — OVER THE LIMIT" : ""}
                    {w.partial ? " (only the days in this report)" : ""}
                  </Text>
                ))}
              </View>
            </>
          )}

          <Text style={styles.section} accessibilityRole="header">
            Visits
          </Text>
          <View style={styles.card}>
            {attendance.rows.length === 0 && <Text style={styles.rowText}>No visits in these dates.</Text>}
            {attendance.rows.map((r) => (
              <View key={r.shiftId} style={styles.visit}>
                <Text style={styles.visitTitle}>
                  {r.date} · {r.ipName} · {VISIT_STATUS[r.status] ?? r.status}
                </Text>
                <Text style={styles.rowText}>
                  Scheduled {clock(r.scheduledStart, tz)} to {clock(r.scheduledEnd, tz)} ({minutesLabel(r.scheduledMinutes)})
                </Text>
                <Text style={styles.rowText}>
                  In {clock(r.checkIn, tz)} · Out {clock(r.checkOut, tz)}
                </Text>
                <Text style={styles.rowText}>
                  Authorized {minutesLabel(r.authorizedMinutes)} · Observed {r.observedMinutes === null ? "not available" : minutesLabel(r.observedMinutes)}
                </Text>
                {r.correctionNotes.map((n) => (
                  <Text key={n} style={styles.rowText}>
                    Correction note: {n}
                  </Text>
                ))}
              </View>
            ))}
            {attendance.daysOff.map((d) => (
              <Text key={`${d.date}-${d.ipName}`} style={styles.rowText}>
                {d.date} · {d.ipName}: {d.status.replace(/_/g, " ").toLowerCase()}
              </Text>
            ))}
          </View>

          <Text style={styles.section} accessibilityRole="header">
            Exceptions ({exceptions?.items.length ?? 0})
          </Text>
          <View style={styles.card}>
            {(exceptions?.items.length ?? 0) === 0 && <Text style={styles.rowText}>No exceptions in these dates.</Text>}
            {exceptions?.items.map((i, n) => (
              <View key={`${i.date}-${i.kind}-${n}`} style={styles.visit}>
                <Text style={styles.visitTitle}>
                  {i.label} · {i.date}
                  {i.at ? ` · ${clock(i.at, tz)}` : ""}
                </Text>
                <Text style={styles.rowText}>{i.text}</Text>
              </View>
            ))}
            <Text style={styles.small}>Flags are prompts to take a look. They never mean something is proven.</Text>
          </View>
        </>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Notes
        </Text>
        {meta.notes.map((n) => (
          <Text key={n} style={styles.small}>
            • {n}
          </Text>
        ))}
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
  section: { fontSize: 19, fontWeight: "700", color: "#1a1a1a", marginTop: 8 },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 12, gap: 6 },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  report: { gap: 12, marginTop: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  covers: { fontSize: 16, fontWeight: "600", color: "#1a1a1a" },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  dateInput: { minWidth: 150, flexGrow: 1 },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 14, paddingHorizontal: 22, minHeight: 52, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
  outlineText: { color: "#1a1a1a", fontSize: 16, fontWeight: "700" },
  error: { color: "#a1130f", fontSize: 16, fontWeight: "600" },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 2 },
  lineLabel: { flex: 1, fontSize: 16, color: "#222" },
  lineValue: { fontSize: 16, color: "#111", fontWeight: "700", textAlign: "right" },
  strong: { fontWeight: "800" },
  percent: { gap: 2, marginBottom: 6 },
  rowText: { fontSize: 15, color: "#222", lineHeight: 21 },
  visit: { gap: 2, borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 6, marginTop: 4 },
  visitTitle: { fontSize: 15, fontWeight: "700", color: "#111" },
});
