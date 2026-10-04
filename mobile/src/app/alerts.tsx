import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect, type Href } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, getAlerts, getMe, markAlertRead, markAllAlertsRead, type AlertDto } from "@/lib/api";
import { refreshBadges } from "@/lib/badges";
import { formatDateTime } from "@/lib/dates";
import { speak, stopSpeaking, useSpeech } from "@/lib/speech";
import { HomeBar } from "@/components/HomeBar";

const POLL_MS = 15000;

export default function AlertsScreen() {
  const { token, user } = useAuth();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const speech = useSpeech();
  const [timezone, setTimezone] = useState("America/Chicago");
  const [alerts, setAlerts] = useState<AlertDto[] | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    if (!token || !staff) return;
    getMe(token)
      .then((me) => setTimezone(me.household.timezone))
      .catch(() => {});
  }, [token, staff]);

  const load = useCallback(async () => {
    if (!token || !staff || !user) return;
    try {
      setAlerts((await getAlerts(token)).alerts);
      setLoadedAt(Date.now());
      setLoadError(null);
      void refreshBadges(token, user.role);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load alerts. Check your connection.");
    }
  }, [token, staff, user]);

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
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (user && !staff) return <Redirect href="/" />;

  if (!alerts) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading alerts" />}
      </View>
    );
  }

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    setActionError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That did not go through. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const open = (a: AlertDto) =>
    act(a.id, async () => {
      if (!a.read) await markAlertRead(token!, a.id);
      if (a.link) router.push(a.link as Href);
    });

  // Tapping an alert acknowledges it (marks it read) and, where there is something to do, opens that screen.
  const tap = (a: AlertDto) => {
    if (a.link && !a.resolved) return open(a);
    if (!a.read) return act(a.id, () => markAlertRead(token!, a.id));
  };

  // What needs attention first: urgent items nobody has dealt with, then everything else newest first.
  // Urgent and not yet read. Once read they move down to Recent (still labeled urgent until handled).
  const needsAttention = alerts.filter((a) => a.severity === "URGENT" && !a.resolved && !a.read);
  const rest = alerts.filter((a) => !needsAttention.includes(a));
  const recent = rest.filter((a) => !a.read || loadedAt - new Date(a.createdAt).getTime() < 3 * 86_400_000);
  const older = rest.filter((a) => !recent.includes(a));
  const unread = alerts.filter((a) => !a.read).length;

  const readAloudAll = () => {
    const urgent = needsAttention.filter((a) => !a.read);
    const pool = urgent.length > 0 ? urgent : alerts.filter((a) => !a.read && !a.resolved);
    if (pool.length === 0) return speak("You have no new alerts.");
    speak(pool.slice(0, 5).map((a) => `${a.severity === "URGENT" ? "Urgent. " : ""}${a.message}`).join(" "));
  };

  const card = (a: AlertDto) => {
    const urgent = a.severity === "URGENT" && !a.resolved;
    return (
      <View key={a.id} style={[styles.card, urgent && styles.urgentCard, a.resolved && styles.resolvedCard]} accessible={false}>
        <View style={styles.tags}>
          {urgent && <Text style={[styles.tag, styles.urgentTag]}>URGENT</Text>}
          {!a.read && <Text style={[styles.tag, styles.newTag]}>NEW</Text>}
          {a.resolved && <Text style={[styles.tag, styles.doneTag]}>HANDLED</Text>}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${a.title}. ${a.message}. ${a.read ? "" : a.link && !a.resolved ? "Tap to open and acknowledge." : "Tap to acknowledge."}`}
          onPress={() => tap(a)}
          disabled={busy === a.id || (a.read && (!a.link || a.resolved))}
          style={styles.tapArea}
        >
          <Text style={styles.cardTitle}>{a.title}</Text>
          <Text style={styles.message}>{a.message}</Text>
          <Text style={styles.when}>{formatDateTime(a.createdAt, timezone)}</Text>
        </Pressable>
        <View style={styles.actions}>
          {a.link && !a.resolved && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open and deal with: ${a.title}`}
              onPress={() => open(a)}
              disabled={busy === a.id}
              style={[styles.primary, urgent && styles.urgentPrimary]}
            >
              <Text style={styles.primaryText}>{busy === a.id ? "Opening…" : "Open"}</Text>
            </Pressable>
          )}
          {!a.read && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark as read: ${a.title}`}
              onPress={() => act(a.id, () => markAlertRead(token!, a.id))}
              disabled={busy === a.id}
              style={styles.outline}
            >
              <Text style={styles.outlineText}>Mark as read</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Read aloud: ${a.title}`}
            onPress={() => speak(`${a.severity === "URGENT" ? "Urgent. " : ""}${a.title}. ${a.message}`)}
            style={styles.outline}
          >
            <Text style={styles.outlineText}>Read aloud</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
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
        Alerts
      </Text>
      <Text style={styles.help}>Things that need a person to look. New urgent ones are at the top. An alert stays new, and keeps counting on the Alerts button, until you tap into it. Tapping an alert opens the screen where you can deal with it.</Text>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}
      {actionError && (
        <Text style={styles.error} role="alert">
          {actionError}
        </Text>
      )}

      <View style={styles.toolbar}>
        {speech.speaking ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop reading" onPress={stopSpeaking} style={styles.stop}>
            <Text style={styles.stopText}>Stop reading</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="Read my new alerts aloud" onPress={readAloudAll} style={styles.outline}>
            <Text style={styles.outlineText}>Read new alerts aloud</Text>
          </Pressable>
        )}
        {unread > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Mark all ${unread} as read`}
            onPress={() => act("all", () => markAllAlertsRead(token!))}
            disabled={busy === "all"}
            style={styles.outline}
          >
            <Text style={styles.outlineText}>{busy === "all" ? "Marking…" : `Mark all ${unread} as read`}</Text>
          </Pressable>
        )}
      </View>

      {alerts.length === 0 && <Text style={styles.empty}>No alerts. Nothing needs a look right now.</Text>}

      {needsAttention.length > 0 && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            New and urgent ({needsAttention.length})
          </Text>
          {needsAttention.map(card)}
        </>
      )}

      {recent.length > 0 && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Recent
          </Text>
          {recent.map(card)}
        </>
      )}

      {older.length > 0 && (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showOlder }} onPress={() => setShowOlder((v) => !v)} style={styles.outline}>
            <Text style={styles.outlineText}>{showOlder ? "Hide older alerts" : `Show older alerts (${older.length})`}</Text>
          </Pressable>
          {showOlder && older.map(card)}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 110, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 24, fontWeight: "700", color: "#1a1a1a" },
  help: { fontSize: 16, color: "#333", lineHeight: 22 },
  section: { fontSize: 18, fontWeight: "700", color: "#1a1a1a", marginTop: 8 },
  empty: { fontSize: 17, color: "#333", paddingVertical: 12 },
  error: { color: "#a1130f", fontSize: 16, fontWeight: "600" },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 14, gap: 6, backgroundColor: "#fff" },
  urgentCard: { borderColor: "#a1130f", borderWidth: 3, backgroundColor: "#fff4f3" },
  resolvedCard: { opacity: 0.75, backgroundColor: "#f4f4f4" },
  tags: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  tag: { fontSize: 13, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, overflow: "hidden", letterSpacing: 0.5 },
  urgentTag: { backgroundColor: "#a1130f", color: "#fff" },
  newTag: { borderWidth: 2, borderColor: "#1a1a1a", color: "#1a1a1a" },
  doneTag: { borderWidth: 2, borderColor: "#2d6a2d", color: "#2d6a2d" },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#1a1a1a" },
  message: { fontSize: 16, color: "#222", lineHeight: 22 },
  when: { fontSize: 14, color: "#555" },
  tapArea: { gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  urgentPrimary: { backgroundColor: "#a1130f" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, justifyContent: "center", alignItems: "center" },
  outlineText: { color: "#1a1a1a", fontSize: 16, fontWeight: "700" },
  stop: { backgroundColor: "#a1130f", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  stopText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
