import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";

/**
 * A "Home" button at the top of every main screen. Home is where all the other
 * screens are one tap away, so this is the only navigation a screen needs.
 */
export function HomeBar() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <View style={styles.bar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Go to Home" onPress={() => router.replace("/home")} style={styles.button}>
        <Text style={styles.text}>‹ Home</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row" },
  button: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18, minHeight: 48, justifyContent: "center" },
  text: { fontSize: 17, fontWeight: "700", color: "#1a1a1a" },
});
