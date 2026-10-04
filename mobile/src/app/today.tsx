import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getVerifiedCoords, LocationUnavailableError } from "@/lib/location";
import {
  ApiError,
  reportCompletionError,
  checkIn,
  checkOut,
  completeTask,
  getTodayShift,
  locationPing,
  markTaskException,
  submitCorrective,
  type ShiftDto,
} from "@/lib/api";
import { TaskRow } from "@/components/TaskRow";
import { HomeBar } from "@/components/HomeBar";
import { CorrectionReports } from "@/components/CorrectionReports";

// Within the spec's approved 30-60 minute range, while the app is open in
// the foreground. True background collection (screen off / app backgrounded)
// needs a native dev build with expo-task-manager + a foreground service on
// Android — not wired up yet; see src/lib/location.ts.
const PERIODIC_PING_MS = 45 * 60 * 1000;

export default function TodayScreen() {
  const { token, user, signOut } = useAuth();
  const [shift, setShift] = useState<ShiftDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [reportsKey, setReportsKey] = useState(0);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const pingInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const result = await getTodayShift(token);
      setShift(result.shift);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not load today's shift." });
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  // Coming back from the camera screen: pick up the newly accepted photo.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const shiftIsActive = Boolean(shift?.checkInEventId && !shift?.checkOutEventId);

  // There are no push notifications yet, so while a shift is open the list
  // refreshes itself; a client's dispute then appears within seconds.
  useEffect(() => {
    if (!shiftIsActive) return;
    const timer = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [shiftIsActive, load]);

  useEffect(() => {
    if (!shiftIsActive || !token || !shift) {
      if (pingInterval.current) clearInterval(pingInterval.current);
      return;
    }
    pingInterval.current = setInterval(async () => {
      try {
        const coords = await getVerifiedCoords();
        await locationPing(token, shift.id, coords);
      } catch {
        // Missing periodic readings generate a review alert server-side;
        // the app does not need to surface every missed ping to the IP.
      }
    }, PERIODIC_PING_MS);
    return () => {
      if (pingInterval.current) clearInterval(pingInterval.current);
    };
  }, [shiftIsActive, token, shift]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function handleCheckIn() {
    if (!token || !shift) return;
    setMessage(null);
    setActionBusy(true);
    try {
      const coords = await getVerifiedCoords();
      await checkIn(token, shift.id, coords);
    } catch (err) {
      if (err instanceof LocationUnavailableError) {
        setMessage({ kind: "error", text: "Location permission is required to check in." });
      } else if (err instanceof ApiError) {
        setMessage({ kind: "error", text: err.message });
      } else {
        setMessage({ kind: "error", text: "Check-in failed. Try again." });
      }
    } finally {
      setActionBusy(false);
      load();
    }
  }

  async function handleCheckOut() {
    if (!token || !shift) return;
    setMessage(null);
    setActionBusy(true);
    try {
      let coords = null;
      try {
        coords = await getVerifiedCoords();
      } catch {
        // Checkout must remain available even if GPS fails — the server
        // records the attempt with an unverified/failed location instead.
      }
      await checkOut(token, shift.id, coords);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Checkout failed. Try again." });
    } finally {
      setActionBusy(false);
      load();
    }
  }

  // "Report completion error": only asks. Throws a readable message for the task row to show.
  async function handleReportError(taskId: string, reason: string) {
    try {
      await reportCompletionError(token!, { taskInstanceId: taskId, reason });
    } catch (err) {
      throw new Error(err instanceof ApiError ? err.message : "Could not send the report. Check your connection and try again.");
    }
    setReportsKey((k) => k + 1);
    await load();
  }

  async function handleComplete(taskId: string) {
    if (!token) return;
    setBusyTaskId(taskId);
    try {
      await completeTask(token, taskId);
      await load();
    } catch (err) {
      Alert.alert("Could not complete task", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleCorrective(taskId: string) {
    if (!token) return;
    setBusyTaskId(taskId);
    try {
      await submitCorrective(token, taskId);
      await load();
    } catch (err) {
      Alert.alert("Could not submit the corrected work", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleException(
    taskId: string,
    outcome: "NOT_NEEDED" | "UNABLE_TO_COMPLETE",
    reasonCode: string,
    reasonText?: string
  ) {
    if (!token) return;
    setBusyTaskId(taskId);
    try {
      await markTaskException(token, taskId, outcome, reasonCode as never, reasonText);
      await load();
    } catch (err) {
      Alert.alert("Could not update task", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusyTaskId(null);
    }
  }

  if (user && user.role !== "IP") return <Redirect href="/" />;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading today's shift" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <HomeBar />
      <Text style={styles.greeting} accessibilityRole="header">
        {user?.name ? `Hi, ${user.name}` : "Today"}
      </Text>

      {message && (
        <Text
          style={message.kind === "error" ? styles.errorBanner : styles.infoBanner}
          accessibilityLiveRegion="assertive"
          role="alert"
        >
          {message.text}
        </Text>
      )}

      {!shift ? (
        <Text style={styles.noShift}>No scheduled shift today.</Text>
      ) : (
        <>
          <View style={styles.statusCard}>
            <Text style={styles.statusLine}>
              Scheduled: {formatTime(shift.scheduledStartUtc)} – {formatTime(shift.scheduledEndUtc)}
            </Text>
            <Text style={styles.statusLine}>{describeStatus(shift)}</Text>
          </View>

          {!shift.checkInEventId && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check in"
              onPress={handleCheckIn}
              disabled={actionBusy}
              style={[styles.primaryButton, actionBusy && styles.buttonDisabled]}
            >
              {actionBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Check in</Text>}
            </Pressable>
          )}

          {shiftIsActive && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check out"
              onPress={handleCheckOut}
              disabled={actionBusy}
              style={[styles.primaryButton, styles.checkOutButton, actionBusy && styles.buttonDisabled]}
            >
              {actionBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Check out</Text>}
            </Pressable>
          )}

          {shiftIsActive && (
            <Pressable accessibilityRole="button" accessibilityLabel="Food and supplies" onPress={() => router.push("/supplies")} style={styles.suppliesButton}>
              <Text style={styles.suppliesText}>Food and supplies</Text>
            </Pressable>
          )}

          {shiftIsActive && (
            <View style={styles.taskList}>
              <Text style={styles.sectionTitle} accessibilityRole="header">
                Today&apos;s tasks
              </Text>
              {shift.taskInstances.length === 0 ? (
                <Text>No tasks assigned yet.</Text>
              ) : (
                shift.taskInstances.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    busy={busyTaskId === task.id}
                    onTakePhoto={() => router.push({ pathname: "/capture", params: { taskId: task.id, title: task.titleSnapshot } })}
                    onComplete={() => handleComplete(task.id)}
                    onCorrective={() => handleCorrective(task.id)}
                    onException={(outcome, reasonCode, reasonText) =>
                      handleException(task.id, outcome, reasonCode, reasonText)
                    }
                    onReportError={(reason) => handleReportError(task.id, reason)}
                  />
                ))
              )}
            </View>
          )}
        </>
      )}

      {token && <CorrectionReports token={token} shiftId={shift?.checkInEventId ? shift.id : null} refreshKey={reportsKey} />}

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function describeStatus(shift: ShiftDto): string {
  if (shift.checkOutEventId) return "Checked out.";
  if (shift.checkInEventId && shift.authorizationClosedAt) {
    return "Authorized window has closed. Please check out.";
  }
  if (shift.checkInEventId && shift.authorizedEndUtc) {
    return `Checked in. Authorized until ${formatTime(shift.authorizedEndUtc)}.`;
  }
  return "Not checked in yet.";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 100 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  greeting: { fontSize: 26, fontWeight: "700", marginBottom: 16 },
  noShift: { fontSize: 17 },
  statusCard: { backgroundColor: "#f2f2f2", borderRadius: 10, padding: 16, marginBottom: 16 },
  statusLine: { fontSize: 16, marginBottom: 4 },
  errorBanner: { color: "#b00020", fontSize: 15, marginBottom: 12 },
  infoBanner: { color: "#0b5fff", fontSize: 15, marginBottom: 12 },
  primaryButton: {
    backgroundColor: "#0b5fff",
    borderRadius: 10,
    paddingVertical: 18,
    alignItems: "center",
    minHeight: 56,
    justifyContent: "center",
    marginBottom: 16,
  },
  checkOutButton: { backgroundColor: "#8a1c1c" },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: "#fff", fontSize: 19, fontWeight: "700" },
  suppliesButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 10, paddingVertical: 14, minHeight: 52, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  suppliesText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  taskList: { marginTop: 8 },
  sectionTitle: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  signOut: { marginTop: 32, alignItems: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
