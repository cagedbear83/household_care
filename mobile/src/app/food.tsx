import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { acknowledgeFoodHazard, ApiError, approveFood, declineFood, getFoodRequests, getMe, type FoodStaffRequest } from "@/lib/api";
import { HomeBar } from "@/components/HomeBar";
import { FoodRequestCard } from "@/components/FoodRequestCard";

interface Lists {
  pending: FoodStaffRequest[];
  hazards: FoodStaffRequest[];
  approvedWaiting: FoodStaffRequest[];
  history: FoodStaffRequest[];
}

export default function FoodScreen() {
  const { token, user, signOut } = useAuth();
  const canDecide = user?.role === "CLIENT";
  const [timezone, setTimezone] = useState<string | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";

  useEffect(() => {
    if (!token || !staff) return;
    (async () => {
      try {
        setTimezone((await getMe(token)).household.timezone);
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Could not load.");
      }
    })();
  }, [token, staff]);

  const load = useCallback(async () => {
    if (!token || !staff) return;
    try {
      setLists(await getFoodRequests(token));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load food requests.");
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

  // New requests show up without a refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (user && !staff) return <Redirect href="/" />;

  if (!lists || !timezone) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading food requests" />}
      </View>
    );
  }

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      await action();
      await load();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again." }));
      if (err instanceof ApiError && err.code === "ALREADY_DECIDED") await load();
    } finally {
      setBusyId(null);
    }
  }

  const card = (r: FoodStaffRequest) => (
    <FoodRequestCard
      key={r.id}
      request={r}
      token={token!}
      timezone={timezone}
      canDecide={canDecide}
      busy={busyId === r.id}
      error={errors[r.id] || null}
      onApprove={() => act(r.id, () => approveFood(token!, r.id))}
      onDecline={(note) => act(r.id, () => declineFood(token!, r.id, note))}
      onAcknowledge={() => act(r.id, () => acknowledgeFoodHazard(token!, r.id))}
    />
  );

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
        Food requests
      </Text>
      <Text style={styles.help}>
        {canDecide
          ? "The IP asks before throwing food away. Nothing is thrown away until you say yes. If you do not answer, the item stays where it is and the administrator is told."
          : "You can see every request and photo here. Only the client can approve or decline."}
      </Text>
      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}

      <Text style={styles.section} accessibilityRole="header">
        {canDecide ? "Needs your decision" : "Waiting on the client"} ({lists.pending.length})
      </Text>
      {lists.pending.length === 0 ? <Text style={styles.empty}>Nothing is waiting.</Text> : lists.pending.map(card)}

      {lists.hazards.length > 0 && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Hazards reported ({lists.hazards.length})
          </Text>
          {lists.hazards.map(card)}
        </>
      )}

      {lists.approvedWaiting.length > 0 && (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Approved, not yet thrown away ({lists.approvedWaiting.length})
          </Text>
          {lists.approvedWaiting.map(card)}
        </>
      )}

      <Text style={styles.section} accessibilityRole="header">
        History
      </Text>
      {lists.history.length === 0 ? <Text style={styles.empty}>Nothing has been decided yet.</Text> : lists.history.map(card)}

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
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
