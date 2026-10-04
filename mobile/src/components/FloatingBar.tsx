import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { refreshBadges, resetBadges, useBadges } from "@/lib/badges";
import { loadSpeechSettings, stopSpeaking } from "@/lib/speech";

const POLL_MS = 15000;
// Screens where floating buttons would be in the way or make no sense.
// Home has a button for each of these already.
const HIDDEN_ON = ["/", "/login", "/invite", "/capture", "/forgot-password", "/home"];

const count = (n: number) => (n > 99 ? "99+" : String(n));

/**
 * Buttons that float over every main screen: Alerts (client and administrators,
 * with the number unread, and the word "urgent" when any are) and Messages. The
 * same component keeps the counts fresh and, if the person turned it on, reads
 * a new urgent alert out loud.
 */
export function FloatingBar() {
  const { token, user } = useAuth();
  const pathname = usePathname();
  const badges = useBadges();

  const signedIn = Boolean(token && user);
  const hidden = !signedIn || HIDDEN_ON.includes(pathname);
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const userId = user?.id;
  const role = user?.role;

  // The saved speech choices belong to the person signed in; nothing keeps talking after sign-out.
  useEffect(() => {
    if (!userId) {
      stopSpeaking();
      resetBadges();
      return;
    }
    void loadSpeechSettings(userId);
  }, [userId]);

  useEffect(() => {
    if (!token || !role) return;
    let cancelled = false;
    const check = () => {
      if (!cancelled) void refreshBadges(token, role);
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, role, pathname]);

  if (hidden) return null;

  const showAlerts = staff && pathname !== "/alerts";
  const showMessages = !pathname.startsWith("/messages");
  if (!showAlerts && !showMessages) return null;
  const urgent = badges.alertsUrgent > 0;

  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <View pointerEvents="box-none" style={styles.row}>
        {showAlerts && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              badges.alertsUnread === 0 ? "Alerts, none new" : `Alerts, ${badges.alertsUnread} new${urgent ? `, ${badges.alertsUrgent} urgent` : ""}`
            }
            onPress={() => router.push("/alerts")}
            style={[styles.button, styles.alertsButton, urgent && styles.urgentButton]}
          >
            <Text style={[styles.text, !urgent && styles.alertsText]}>{urgent ? "Urgent alerts" : "Alerts"}</Text>
            {badges.alertsUnread > 0 && <Text style={styles.badge}>{count(badges.alertsUnread)}</Text>}
          </Pressable>
        )}
        {showMessages && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={badges.messagesUnread > 0 ? `Messages, ${badges.messagesUnread} unread` : "Messages"}
            onPress={() => router.push("/messages")}
            style={styles.button}
          >
            <Text style={styles.text}>Messages</Text>
            {badges.messagesUnread > 0 && <Text style={styles.badge}>{count(badges.messagesUnread)}</Text>}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, right: 0, bottom: 0, top: 0, justifyContent: "flex-end", padding: 16 },
  row: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1a1a1a",
    borderRadius: 28,
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 52,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  // Normal: an empty box. Something urgent waiting: the box fills in.
  alertsButton: { backgroundColor: "#fff", borderWidth: 2, borderColor: "#1a1a1a" },
  alertsText: { color: "#1a1a1a" },
  urgentButton: { backgroundColor: "#1a1a1a" },
  text: { color: "#fff", fontSize: 16, fontWeight: "700" },
  // A red circle with a white number; it goes away when nothing is unread.
  badge: { backgroundColor: "#d71920", color: "#fff", fontSize: 14, fontWeight: "800", borderRadius: 13, minWidth: 26, height: 26, lineHeight: 22, textAlign: "center", borderWidth: 2, borderColor: "#fff", overflow: "hidden" },
});
