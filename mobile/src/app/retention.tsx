import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, getRetention, placeRetentionHold, releaseRetentionHold, setRetentionPeriod, type RetentionStatus } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { isDate } from "@/lib/report-format";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";

const OPTIONS = [
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years (recommended)" },
  { days: 1095, label: "3 years" },
  { days: 1825, label: "5 years" },
];

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const daysLabel = (days: number) => {
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? "" : "s"} (${days} days)`;
  return `${days} days`;
};

export default function RetentionScreen() {
  const { token, user } = useAuth();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !staff) return;
    try {
      setStatus(await getRetention(token));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Could not load. Check your connection."));
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

  if (user && !staff) return <Redirect href="/home" />;

  if (!status) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading" />}
      </View>
    );
  }

  const tz = status.timezone;
  // A full date with the year: these dates can be years away.
  const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).format(new Date(iso)) : "—");
  const r = status.records;

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
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Retention
      </Text>
      <Text style={styles.help}>How long records are kept. Every change asks for your password again and is written to the permanent record.</Text>
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

      <View style={[styles.card, !status.policy.confirmed && styles.warnCard]}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Records are kept for {daysLabel(status.policy.days)}
        </Text>
        {status.policy.confirmed ? (
          <Text style={styles.body}>
            Chosen by {status.policy.setBy ?? "someone"}
            {status.policy.setAt ? ` on ${day(status.policy.setAt)}` : ""}.
          </Text>
        ) : (
          <Text style={styles.body}>Not confirmed yet. The recommended two years applies until someone chooses a period below. Please choose one before real use.</Text>
        )}
        {status.policy.reducedFrom !== null && (
          <Text style={styles.body}>This was shortened from {daysLabel(status.policy.reducedFrom)}. Records made before the change stay protected for the longer period.</Text>
        )}
        <Text style={styles.small}>Counted from the date each record was made. This covers attendance, tasks, notes, photos, approvals, corrections and administrative records.</Text>
      </View>

      <Text style={styles.section} accessibilityRole="header">
        What is being kept
      </Text>
      <View style={styles.card}>
        <Line label="Recorded events" value={r.events} />
        <Line label="Photos" value={r.photos} />
        <Line label="Oldest record" value={day(r.oldestRecordedAt)} />
        <Line label="Earliest a record's protection ends" value={day(r.earliestExpiry)} />
        <Line label="Past their period" value={`${r.pastRetention.events} events, ${r.pastRetention.photos} photos`} strong />
        <Line label="Eligible for archive or disposal review" value={`${r.reviewable.events} events, ${r.reviewable.photos} photos`} />
        <Line label="Kept back by a hold or an open dispute" value={`${r.heldBack.events} events, ${r.heldBack.photos} photos`} />
        <Line label="Disputes not yet resolved" value={r.unresolvedDisputes} />
        <Text style={styles.small}>The app never deletes anything itself. These counts only show what could be reviewed for the locked archive or disposal.</Text>
      </View>

      <PeriodCard
        status={status}
        onSave={async (days, reason, password) => {
          setStatus(await setRetentionPeriod(token!, { days, reason: reason || undefined, password }));
          setNotice("The retention period was saved.");
        }}
      />

      <Text style={styles.section} accessibilityRole="header">
        Preservation holds
      </Text>
      <Text style={styles.small}>A hold keeps records past their period, for example during a dispute or a program review. Records tied to a dispute that is still open are kept automatically.</Text>
      {status.holds.length === 0 && <Text style={styles.empty}>No holds.</Text>}
      {status.holds.map((h) => (
        <HoldCard
          key={h.id}
          hold={h}
          tz={tz}
          onRelease={async (reason, password) => {
            setStatus(await releaseRetentionHold(token!, h.id, { reason, password }));
            setNotice("The hold was released.");
          }}
        />
      ))}
      <NewHoldCard
        onPlace={async (reason, fromDate, toDate, password) => {
          setStatus(await placeRetentionHold(token!, { reason, fromDate: fromDate || undefined, toDate: toDate || undefined, password }));
          setNotice("The hold was placed.");
        }}
      />

      <Text style={styles.section} accessibilityRole="header">
        History of the period
      </Text>
      <View style={styles.card}>
        {status.history.map((h, i) => (
          <View key={`${h.retentionDays}-${i}`} style={styles.historyRow}>
            <Text style={styles.itemTitle}>{daysLabel(h.retentionDays)}</Text>
            <Text style={styles.small}>
              {h.isDefault ? "Starting recommendation" : `${h.setBy ?? "Someone"} · ${day(h.effectiveFrom)}`}
              {h.reason && !h.isDefault ? ` · ${h.reason}` : ""}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Good to know
        </Text>
        {status.notes.map((n) => (
          <Text key={n} style={styles.small}>
            • {n}
          </Text>
        ))}
      </View>
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

function PeriodCard({ status, onSave }: { status: RetentionStatus; onSave: (days: number, reason: string, password: string) => Promise<void> }) {
  const current = status.policy.days;
  const [choice, setChoice] = useState<number | "other">(OPTIONS.some((o) => o.days === current) ? current : "other");
  const [other, setOther] = useState(OPTIONS.some((o) => o.days === current) ? "" : String(current));
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = choice === "other" ? Number(other) : choice;
  const validDays = Number.isInteger(days) && days >= status.policy.minDays && days <= status.policy.maxDays;
  const shortening = validDays && days < current;
  const unchanged = status.policy.confirmed && days === current;
  const ready = validDays && !unchanged && password.length > 0 && (!shortening || reason.trim().length >= 3);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(days, reason.trim(), password);
      setPassword("");
      setReason("");
    } catch (err) {
      setError(errorText(err, "That did not go through. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Choose how long to keep records
      </Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {OPTIONS.map((o) => (
          <Chip key={o.days} label={o.label} selected={choice === o.days} onPress={() => setChoice(o.days)} />
        ))}
        <Chip label="Another number of days" selected={choice === "other"} onPress={() => setChoice("other")} />
      </View>
      {choice === "other" && (
        <>
          <Text style={styles.label}>Days ({status.policy.minDays} to {status.policy.maxDays})</Text>
          <TextInput style={styles.input} accessibilityLabel="Number of days" keyboardType="number-pad" value={other} onChangeText={setOther} editable={!busy} />
        </>
      )}
      {!validDays && <Text style={styles.small}>Choose between {status.policy.minDays} and {status.policy.maxDays} days.</Text>}
      {shortening && (
        <Text style={styles.warn}>This is shorter than now. Records already made stay protected for the longer period; only new records get the shorter one. Please say why.</Text>
      )}
      <Text style={styles.label}>{shortening ? "Why (required when shortening)" : "Why (optional)"}</Text>
      <TextInput style={styles.input} accessibilityLabel="Reason for the retention period" value={reason} onChangeText={setReason} editable={!busy} />
      <Text style={styles.label}>Your password, to confirm</Text>
      <TextInput style={styles.input} accessibilityLabel="Your password" secureTextEntry value={password} onChangeText={setPassword} editable={!busy} autoComplete="current-password" />
      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel="Save the retention period" disabled={busy || !ready} onPress={save} style={[styles.primary, (busy || !ready) && styles.disabled]}>
        <Text style={styles.primaryText}>{busy ? "Saving…" : status.policy.confirmed ? "Save the retention period" : "Confirm the retention period"}</Text>
      </Pressable>
    </View>
  );
}

function HoldCard({ hold, tz, onRelease }: { hold: RetentionStatus["holds"][number]; tz: string; onRelease: (reason: string, password: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release() {
    setBusy(true);
    setError(null);
    try {
      await onRelease(reason.trim(), password);
    } catch (err) {
      setError(errorText(err, "That did not go through. Try again."));
      setBusy(false);
    }
  }

  const covers = hold.fromDate || hold.toDate ? `${hold.fromDate ?? "the beginning"} to ${hold.toDate ?? "no end"}` : "all records";
  return (
    <View style={[styles.card, hold.active && styles.warnCard]}>
      <Text style={styles.itemTitle}>
        {hold.active ? "ACTIVE HOLD" : "Released"} · {hold.reason}
      </Text>
      <Text style={styles.small}>
        Covers {covers}. Placed by {hold.placedBy ?? "someone"} · {formatDateTime(hold.placedAt, tz)}
      </Text>
      {!hold.active && (
        <Text style={styles.small}>
          Released by {hold.releasedBy ?? "someone"}
          {hold.releasedAt ? ` · ${formatDateTime(hold.releasedAt, tz)}` : ""}: {hold.releaseReason}
        </Text>
      )}
      {hold.active &&
        (open ? (
          <View style={styles.form}>
            <Text style={styles.label}>Why it is being released</Text>
            <TextInput style={styles.input} accessibilityLabel="Reason for releasing the hold" value={reason} onChangeText={setReason} editable={!busy} />
            <Text style={styles.label}>Your password, to confirm</Text>
            <TextInput style={styles.input} accessibilityLabel="Your password" secureTextEntry value={password} onChangeText={setPassword} editable={!busy} />
            {error && (
              <Text style={styles.error} role="alert">
                {error}
              </Text>
            )}
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel="Release the hold" disabled={busy || reason.trim().length < 3 || !password} onPress={release} style={[styles.primary, (busy || reason.trim().length < 3 || !password) && styles.disabled]}>
                <Text style={styles.primaryText}>{busy ? "Releasing…" : "Release the hold"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setOpen(false)} style={styles.outline}>
                <Text style={styles.outlineText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={`Release the hold: ${hold.reason}`} onPress={() => setOpen(true)} style={styles.outline}>
            <Text style={styles.outlineText}>Release this hold</Text>
          </Pressable>
        ))}
    </View>
  );
}

function NewHoldCard({ onPlace }: { onPlace: (reason: string, fromDate: string, toDate: string, password: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const datesOk = (!from || isDate(from)) && (!to || isDate(to));

  async function place() {
    setBusy(true);
    setError(null);
    try {
      await onPlace(reason.trim(), from.trim(), to.trim(), password);
      setOpen(false);
      setReason("");
      setFrom("");
      setTo("");
      setPassword("");
    } catch (err) {
      setError(errorText(err, "That did not go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Place a preservation hold" onPress={() => setOpen(true)} style={styles.outline}>
        <Text style={styles.outlineText}>Place a hold</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Place a hold
      </Text>
      <Text style={styles.label}>Why (kept with the hold)</Text>
      <TextInput style={styles.input} accessibilityLabel="Reason for the hold" value={reason} onChangeText={setReason} editable={!busy} />
      <Text style={styles.label}>From (year-month-day, optional)</Text>
      <TextInput style={styles.input} accessibilityLabel="Hold from date" placeholder="2026-01-01" autoCapitalize="none" value={from} onChangeText={setFrom} editable={!busy} />
      <Text style={styles.label}>To (year-month-day, optional)</Text>
      <TextInput style={styles.input} accessibilityLabel="Hold to date" placeholder="2026-12-31" autoCapitalize="none" value={to} onChangeText={setTo} editable={!busy} />
      <Text style={styles.small}>Leave both dates empty to hold every record.</Text>
      {!datesOk && <Text style={styles.error}>Enter dates as year-month-day, for example 2026-10-03.</Text>}
      <Text style={styles.label}>Your password, to confirm</Text>
      <TextInput style={styles.input} accessibilityLabel="Your password" secureTextEntry value={password} onChangeText={setPassword} editable={!busy} />
      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Place the hold" disabled={busy || reason.trim().length < 3 || !password || !datesOk} onPress={place} style={[styles.primary, (busy || reason.trim().length < 3 || !password || !datesOk) && styles.disabled]}>
          <Text style={styles.primaryText}>{busy ? "Placing…" : "Place the hold"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setOpen(false)} style={styles.outline}>
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
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 12, gap: 8 },
  warnCard: { borderColor: "#6b4e00", backgroundColor: "#fffbe6" },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  body: { fontSize: 16, color: "#222", lineHeight: 22 },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  empty: { fontSize: 16, color: "#444" },
  label: { fontSize: 15, fontWeight: "600", color: "#222" },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#111" },
  warn: { fontSize: 14, fontWeight: "600", color: "#6b4e00", lineHeight: 20 },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  ok: { color: "#2d6a2d", fontSize: 16, fontWeight: "700" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  form: { gap: 8 },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 2 },
  lineLabel: { flex: 1, fontSize: 15, color: "#222" },
  lineValue: { fontSize: 15, color: "#111", fontWeight: "700", textAlign: "right", flexShrink: 1 },
  strong: { fontWeight: "800" },
  historyRow: { borderBottomWidth: 1, borderBottomColor: "#ddd", paddingVertical: 6, gap: 2 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48, backgroundColor: "#fff" },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  outlineText: { color: "#1a1a1a", fontWeight: "700", fontSize: 15 },
});
