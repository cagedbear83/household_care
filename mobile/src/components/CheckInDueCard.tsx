import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { getDueCheckIns } from "@/lib/api";

/** On the client's Home: a big reminder only while a check-in is waiting. Nothing shows otherwise. */
export function CheckInDueCard({ token }: { token: string }) {
  const [count, setCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      getDueCheckIns(token)
        .then((r) => live && setCount(r.due.length))
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [token])
  );

  if (count === 0) return null;
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text style={styles.title} accessibilityRole="header">
        A check-in is waiting
      </Text>
      <Text style={styles.body}>It takes less than a minute. You can have it read to you.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Answer the check-in" onPress={() => router.push("/checkin")} style={styles.button}>
        <Text style={styles.buttonText}>Answer now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 3, borderColor: "#0b5fff", borderRadius: 12, padding: 14, gap: 8, backgroundColor: "#f2f6ff" },
  title: { fontSize: 22, fontWeight: "800", color: "#1a1a1a" },
  body: { fontSize: 16, color: "#222", lineHeight: 22 },
  button: { backgroundColor: "#0b5fff", borderRadius: 10, paddingVertical: 14, paddingHorizontal: 22, minHeight: 56, justifyContent: "center", alignSelf: "flex-start" },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 18 },
});
