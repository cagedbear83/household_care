import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth-context";
import { FloatingBar } from "@/components/FloatingBar";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: "Sign in" }} />
          <Stack.Screen name="forgot-password" options={{ title: "Reset password" }} />
          <Stack.Screen name="invite" options={{ title: "Join Household Care", headerBackVisible: false }} />
          <Stack.Screen name="home" options={{ title: "Home", headerBackVisible: false }} />
          <Stack.Screen name="today" options={{ title: "Today", headerBackVisible: false }} />
          <Stack.Screen name="corrections" options={{ title: "Corrections", headerBackVisible: false }} />
          <Stack.Screen name="retention" options={{ title: "Retention", headerBackVisible: false }} />
          <Stack.Screen name="reports" options={{ title: "Reports", headerBackVisible: false }} />
          <Stack.Screen name="settings" options={{ title: "Settings", headerBackVisible: false }} />
          <Stack.Screen name="alerts" options={{ title: "Alerts", headerBackVisible: false }} />
          <Stack.Screen name="hear" options={{ title: "Hear an update", headerBackVisible: false }} />
          <Stack.Screen name="review" options={{ title: "Review", headerBackVisible: false }} />
          <Stack.Screen name="schedule" options={{ title: "Schedule", headerBackVisible: false }} />
          <Stack.Screen name="capture" options={{ title: "Take photo" }} />
          <Stack.Screen name="templates" options={{ title: "Task templates", headerBackVisible: false }} />
          <Stack.Screen name="food" options={{ title: "Food requests", headerBackVisible: false }} />
          <Stack.Screen name="shopping" options={{ title: "Shopping list", headerBackVisible: false }} />
          <Stack.Screen name="supplies" options={{ title: "Food and supplies", headerBackVisible: false }} />
          <Stack.Screen name="family" options={{ title: "Family access", headerBackVisible: false }} />
          <Stack.Screen name="messages/index" options={{ title: "Messages" }} />
          <Stack.Screen name="messages/[id]" options={{ title: "Conversation" }} />
        </Stack>
        <FloatingBar />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
