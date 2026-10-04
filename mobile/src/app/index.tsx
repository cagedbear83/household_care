import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";

export default function Index() {
  const { token, user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator accessibilityLabel="Loading" size="large" />
      </View>
    );
  }

  if (!token || !user) return <Redirect href="/login" />;
  // Everyone starts on Home: one button for each place they can go.
  return <Redirect href="/home" />;
}
