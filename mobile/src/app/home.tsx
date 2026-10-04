import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router, type Href } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useBadges } from "@/lib/badges";
import type { Role } from "@/lib/api";

interface Tile {
  key: string;
  label: string;
  note: string;
  href: Href;
  roles: Role[];
}

const STAFF: Role[] = ["CLIENT", "ADMIN"];

// The order here is the order on screen.
const TILES: Tile[] = [
  { key: "today", label: "Today", note: "Check in, tasks and photos", href: "/today", roles: ["IP"] },
  { key: "alerts", label: "Alerts", note: "Urgent and new notices", href: "/alerts", roles: STAFF },
  { key: "review", label: "Review", note: "Approve or dispute work", href: "/review", roles: [...STAFF, "FAMILY"] },
  { key: "corrections", label: "Corrections", note: "Mistakes the IP reported, and notes", href: "/corrections", roles: STAFF },
  { key: "food", label: "Food", note: "Throw-away requests", href: "/food", roles: STAFF },
  { key: "supplies", label: "Food and supplies", note: "Ask before throwing out, report low items", href: "/supplies", roles: ["IP"] },
  { key: "shopping", label: "Shopping", note: "What the house needs", href: "/shopping", roles: STAFF },
  { key: "schedule", label: "Schedule", note: "Visits and weekly hours", href: "/schedule", roles: STAFF },
  { key: "templates", label: "Tasks", note: "The checklist for each visit", href: "/templates", roles: STAFF },
  { key: "family", label: "Family", note: "Invitations and access", href: "/family", roles: STAFF },
  { key: "hear", label: "Hear", note: "Listen to an update", href: "/hear", roles: [...STAFF, "FAMILY"] },
  { key: "reports", label: "Reports", note: "Hours and task results", href: "/reports", roles: [...STAFF, "FAMILY"] },
  { key: "retention", label: "Retention", note: "How long records are kept", href: "/retention", roles: STAFF },
  { key: "messages", label: "Messages", note: "Chat with the household", href: "/messages", roles: ["CLIENT", "ADMIN", "FAMILY", "IP"] },
  { key: "settings", label: "Settings", note: "Your name, contact and password", href: "/settings", roles: ["CLIENT", "ADMIN", "FAMILY", "IP"] },
];

const count = (n: number) => (n > 99 ? "99+" : String(n));

/** The first screen after signing in: one big button for each place the person can go. */
export default function HomeScreen() {
  const { user, loading, signOut } = useAuth();
  const badges = useBadges();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading" />
      </View>
    );
  }
  if (!user) return <Redirect href="/login" />;

  const tiles = TILES.filter((t) => t.roles.includes(user.role));
  const first = user.name.trim().split(/\s+/)[0] ?? "";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title} accessibilityRole="header">
        {first ? `Hello, ${first}` : "Hello"}
      </Text>
      <Text style={styles.help}>Choose where you would like to go.</Text>

      <View style={styles.grid}>
        {tiles.map((t) => {
          const badge = t.key === "alerts" ? badges.alertsUnread : t.key === "messages" ? badges.messagesUnread : 0;
          const urgent = t.key === "alerts" && badges.alertsUrgent > 0;
          const filled = urgent;
          const label =
            t.key === "alerts"
              ? badge > 0
                ? `Alerts, ${badge} new${urgent ? `, ${badges.alertsUrgent} urgent` : ""}`
                : "Alerts, none new"
              : t.key === "messages"
                ? badge > 0
                  ? `Messages, ${badge} unread`
                  : "Messages"
                : `${t.label}. ${t.note}`;
          return (
            <Pressable key={t.key} accessibilityRole="button" accessibilityLabel={label} onPress={() => router.push(t.href)} style={[styles.tile, filled && styles.tileFilled]}>
              <View style={styles.tileTop}>
                <Text style={[styles.tileLabel, filled && styles.tileTextFilled]}>{urgent ? "Urgent alerts" : t.label}</Text>
                {badge > 0 && <Text style={styles.badge}>{count(badge)}</Text>}
              </View>
              <Text style={[styles.tileNote, filled && styles.tileTextFilled]}>{t.note}</Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "800", color: "#1a1a1a" },
  help: { fontSize: 17, color: "#333" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 4 },
  tile: { flexGrow: 1, flexBasis: "45%", minHeight: 104, borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 12, padding: 14, gap: 6, justifyContent: "space-between", backgroundColor: "#fff" },
  tileFilled: { backgroundColor: "#1a1a1a" },
  tileTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  tileLabel: { fontSize: 20, fontWeight: "800", color: "#1a1a1a", flexShrink: 1 },
  tileNote: { fontSize: 14, color: "#444", lineHeight: 19 },
  tileTextFilled: { color: "#fff" },
  // A red circle with a white number; gone when nothing is unread.
  badge: { backgroundColor: "#d71920", color: "#fff", fontSize: 14, fontWeight: "800", borderRadius: 13, minWidth: 26, height: 26, lineHeight: 22, textAlign: "center", borderWidth: 2, borderColor: "#fff", overflow: "hidden" },
  signOut: { marginTop: 16, alignItems: "center", minHeight: 48, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 16, textDecorationLine: "underline" },
});
