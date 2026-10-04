import { Pressable, StyleSheet, Text } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useBadges } from "@/lib/badges";

/**
 * A line at the TOP of a screen saying urgent alerts are waiting. It is part of
 * the page (not floating over it), so it can never cover a text box or a Send
 * button. Used on the message screens, where the floating alert button is hidden.
 */
export function UrgentBanner() {
  const { user } = useAuth();
  const { alertsUrgent } = useBadges();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  if (!staff || alertsUrgent === 0) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${alertsUrgent} urgent alert${alertsUrgent === 1 ? "" : "s"} waiting. Open alerts.`}
      onPress={() => router.push("/alerts")}
      style={styles.banner}
    >
      <Text style={styles.text}>
        Urgent: {alertsUrgent} alert{alertsUrgent === 1 ? "" : "s"} waiting. Tap to open.
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: "#a1130f", paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, justifyContent: "center" },
  text: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
