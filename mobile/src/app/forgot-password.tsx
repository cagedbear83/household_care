import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ApiError, requestPasswordReset, resetPassword } from "@/lib/api";

type Step = "ask" | "reset" | "done";

/**
 * Forgot password: (1) say which email address or phone number the account
 * uses and we send a 6-digit code there; (2) enter the code and a new
 * password. Changing the password signs the account out everywhere.
 * This screen never says whether an account exists.
 */
export default function ForgotPasswordScreen() {
  const [step, setStep] = useState<Step>("ask");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const ask = () =>
    run(async () => {
      const result = await requestPasswordReset(identifier.trim());
      setDevCode(result.devCode ?? null);
      setCode("");
      setStep("reset");
    });

  const reset = () =>
    run(async () => {
      await resetPassword(identifier.trim(), code, password);
      setStep("done");
    });

  const passwordOk = password.length >= 10 && password === password2;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.column}>
        {step === "ask" && (
          <>
            <Text style={styles.heading} accessibilityRole="header">
              Reset your password
            </Text>
            <Text style={styles.body}>Enter the email address or phone number you sign in with. We will send a 6-digit code to it.</Text>
            <Text style={styles.label}>Email address or phone number</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Email address or phone number"
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoComplete="username"
              editable={!busy}
              onSubmitEditing={ask}
            />
            {error && (
              <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
                {error}
              </Text>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Send me a code" onPress={ask} disabled={busy || !identifier.trim()} style={[styles.primary, (busy || !identifier.trim()) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Send me a code</Text>}
            </Pressable>
          </>
        )}

        {step === "reset" && (
          <>
            <Text style={styles.heading} accessibilityRole="header">
              Enter your code
            </Text>
            <Text style={styles.body}>If there is an account for that, we have sent a 6-digit code to it. It works for 15 minutes.</Text>
            {devCode && (
              <View style={styles.dev}>
                <Text style={styles.devText}>Development mode: nothing was really sent. Your code is {devCode}.</Text>
              </View>
            )}
            <Text style={styles.label}>6-digit code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              accessibilityLabel="6-digit code"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              maxLength={6}
              editable={!busy}
            />
            <Text style={styles.label}>New password (at least 10 characters)</Text>
            <TextInput style={styles.input} accessibilityLabel="New password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" editable={!busy} />
            <Text style={styles.label}>Type the new password again</Text>
            <TextInput style={styles.input} accessibilityLabel="New password again" value={password2} onChangeText={setPassword2} secureTextEntry autoCapitalize="none" editable={!busy} />
            {password2.length > 0 && password !== password2 && <Text style={styles.error}>The two passwords do not match.</Text>}
            {error && (
              <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
                {error}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change my password"
              onPress={reset}
              disabled={busy || code.length !== 6 || !passwordOk}
              style={[styles.primary, (busy || code.length !== 6 || !passwordOk) && styles.disabled]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Change my password</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send a new code"
              onPress={() => {
                setError(null);
                setStep("ask");
              }}
              disabled={busy}
              style={styles.outline}
            >
              <Text style={styles.outlineText}>Send a new code</Text>
            </Pressable>
          </>
        )}

        {step === "done" && (
          <>
            <Text style={styles.heading} accessibilityRole="header" accessibilityLiveRegion="polite">
              Password changed
            </Text>
            <Text style={styles.body}>Your password was changed, and you were signed out everywhere it was in use. Sign in with your new password.</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Go to sign in" onPress={() => router.replace("/login")} style={styles.primary}>
              <Text style={styles.primaryText}>Go to sign in</Text>
            </Pressable>
          </>
        )}

        {step !== "done" && (
          <Pressable accessibilityRole="button" accessibilityLabel="Back to sign in" onPress={() => router.replace("/login")} disabled={busy} style={styles.link}>
            <Text style={styles.linkText}>Back to sign in</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 60, flexGrow: 1, justifyContent: "center" },
  column: { width: "100%", maxWidth: 520, alignSelf: "center", gap: 10 },
  heading: { fontSize: 26, fontWeight: "700" },
  body: { fontSize: 16, color: "#222" },
  label: { fontSize: 15, fontWeight: "600", marginTop: 6 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 18, minHeight: 52, backgroundColor: "#fff" },
  codeInput: { fontSize: 28, letterSpacing: 8, textAlign: "center" },
  error: { color: "#b00020", fontSize: 16, fontWeight: "600" },
  dev: { backgroundColor: "#fff7e0", borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "#e0c060" },
  devText: { fontSize: 15, color: "#111" },
  primary: { backgroundColor: "#0b5fff", borderRadius: 10, paddingVertical: 16, minHeight: 56, alignItems: "center", justifyContent: "center", marginTop: 8 },
  primaryText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingVertical: 14, minHeight: 52, alignItems: "center", justifyContent: "center" },
  outlineText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  link: { alignSelf: "center", minHeight: 44, justifyContent: "center" },
  linkText: { color: "#0b5fff", fontSize: 16, fontWeight: "600", textDecorationLine: "underline" },
});
