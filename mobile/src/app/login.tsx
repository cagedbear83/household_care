import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Household Care
      </Text>

      <Text style={styles.label} nativeID="emailLabel">
        Email or phone number
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabelledBy="emailLabel"
        accessibilityLabel="Email or phone number"
        autoCapitalize="none"
        autoComplete="username"
        keyboardType="default"
        value={email}
        onChangeText={setEmail}
        editable={!submitting}
        returnKeyType="next"
      />

      <Text style={styles.label} nativeID="passwordLabel">
        Password
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabelledBy="passwordLabel"
        accessibilityLabel="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        editable={!submitting}
        returnKeyType="go"
        onSubmitEditing={handleSubmit}
      />

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={handleSubmit}
        disabled={submitting || !email || !password}
        style={[styles.button, (submitting || !email || !password) && styles.buttonDisabled]}
      >
        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel="Forgot your password?" onPress={() => router.push("/forgot-password")} style={styles.forgot}>
        <Text style={styles.forgotText}>Forgot your password?</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#fff" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 32, textAlign: "center" },
  label: { fontSize: 16, fontWeight: "600", marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 2,
    borderColor: "#1a1a1a",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 18,
  },
  error: { color: "#b00020", fontSize: 16, marginTop: 16 },
  button: {
    marginTop: 32,
    backgroundColor: "#0b5fff",
    borderRadius: 8,
    paddingVertical: 16,
    alignItems: "center",
    minHeight: 52,
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  forgot: { marginTop: 20, alignSelf: "center", minHeight: 44, justifyContent: "center" },
  forgotText: { color: "#0b5fff", fontSize: 16, fontWeight: "600", textDecorationLine: "underline" },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "700" },
});
