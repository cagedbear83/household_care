import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { acceptInvite, ApiError, getInvite, startOtherContact, verifyOtherContact, type InviteInfo } from "@/lib/api";

type Step = "details" | "contact" | "code";

const channelWord = (c: "EMAIL" | "SMS") => (c === "EMAIL" ? "email address" : "phone number");

/**
 * Family signup, opened from the link in the invitation:
 *  1. confirm your first and last name, confirm the email/phone the invitation
 *     reached is yours, and choose a password;
 *  2. add the other contact (phone if invited by email, email if invited by text);
 *  3. enter the 6-digit code sent to it. Then you are signed in.
 */
export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { startSession } = useAuth();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [loading, setLoading] = useState(true);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const result = await getInvite(token);
        setInfo(result);
        setFirstName(result.firstName);
        setLastName(result.lastName);
        if (result.stage === "ACCEPTED") {
          setStep(result.pendingContactMasked ? "code" : "contact");
          setSentTo(result.pendingContactMasked);
        }
      } catch (err) {
        setLinkError(err instanceof ApiError ? err.message : "Could not open the invitation. Check your connection and try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

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

  const passwordsOk = password.length >= 10 && password === password2;

  const submitDetails = () =>
    run(async () => {
      await acceptInvite(token!, { firstName, lastName, password, confirmContact: confirmed });
      setStep("contact");
      setInfo((i) => (i ? { ...i, stage: "ACCEPTED" } : i));
    });

  const sendCode = () =>
    run(async () => {
      const result = await startOtherContact(token!, contact);
      setSentTo(result.sentToMasked);
      setDevCode(result.devCode ?? null);
      setCode("");
      setStep("code");
    });

  const verify = () =>
    run(async () => {
      const session = await verifyOtherContact(token!, code.trim());
      await startSession(session);
      router.replace("/");
    });

  const missingToken = !token;

  if (loading && !missingToken) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Opening your invitation" />
      </View>
    );
  }

  if (missingToken || linkError || !info) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading} accessibilityRole="header">
          This link will not work
        </Text>
        <Text style={styles.body}>{missingToken ? "This invitation link is incomplete. Open the link from your message again." : linkError}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Go to sign in" onPress={() => router.replace("/login")} style={styles.outline}>
          <Text style={styles.outlineText}>Go to sign in</Text>
        </Pressable>
      </View>
    );
  }

  const other = info.otherChannel;
  const stepNumber = step === "details" ? 1 : step === "contact" ? 2 : 3;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.column}>
        <Text style={styles.progress} accessibilityLiveRegion="polite">
          Step {stepNumber} of 3
        </Text>

        {step === "details" && (
          <>
            <Text style={styles.heading} accessibilityRole="header">
              Join Household Care
            </Text>
            <Text style={styles.body}>
              {info.inviterName} invited you as a family member. Check your name, confirm your {channelWord(info.invitedVia)}, and choose a password.
            </Text>

            <Text style={styles.label}>First name</Text>
            <TextInput style={styles.input} accessibilityLabel="First name" value={firstName} onChangeText={setFirstName} editable={!busy} autoCapitalize="words" />
            <Text style={styles.label}>Last name</Text>
            <TextInput style={styles.input} accessibilityLabel="Last name" value={lastName} onChangeText={setLastName} editable={!busy} autoCapitalize="words" />

            <View style={styles.confirmBox}>
              <Text style={styles.body}>
                The invitation was sent to your {channelWord(info.invitedVia)}: <Text style={styles.strong}>{info.contactMasked}</Text>
              </Text>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: confirmed }}
                accessibilityLabel={`Yes, this is my ${channelWord(info.invitedVia)}`}
                onPress={() => setConfirmed(!confirmed)}
                style={[styles.check, confirmed && styles.checkOn]}
              >
                <Text style={[styles.checkText, confirmed && styles.checkTextOn]}>{confirmed ? "✓ " : ""}Yes, this is my {channelWord(info.invitedVia)}</Text>
              </Pressable>
            </View>

            <Text style={styles.label}>Choose a password (at least 10 characters)</Text>
            <TextInput style={styles.input} accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry editable={!busy} autoCapitalize="none" />
            <Text style={styles.label}>Type the password again</Text>
            <TextInput style={styles.input} accessibilityLabel="Password again" value={password2} onChangeText={setPassword2} secureTextEntry editable={!busy} autoCapitalize="none" />
            {password2.length > 0 && password !== password2 && <Text style={styles.error}>The two passwords do not match.</Text>}

            {error && (
              <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
                {error}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Continue"
              onPress={submitDetails}
              disabled={busy || !confirmed || !passwordsOk || !firstName.trim() || !lastName.trim()}
              style={[styles.primary, (busy || !confirmed || !passwordsOk || !firstName.trim() || !lastName.trim()) && styles.disabled]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Continue</Text>}
            </Pressable>
          </>
        )}

        {step === "contact" && (
          <>
            <Text style={styles.heading} accessibilityRole="header">
              Add your {channelWord(other)}
            </Text>
            <Text style={styles.body}>
              Your {channelWord(info.invitedVia)} is confirmed. Now add your {channelWord(other)} too. We will send a 6-digit code to check it is yours.
            </Text>
            <Text style={styles.label}>Your {channelWord(other)}</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel={`Your ${channelWord(other)}`}
              value={contact}
              onChangeText={setContact}
              editable={!busy}
              autoCapitalize="none"
              keyboardType={other === "EMAIL" ? "email-address" : "phone-pad"}
            />
            {error && (
              <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
                {error}
              </Text>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Send me a code" onPress={sendCode} disabled={busy || !contact.trim()} style={[styles.primary, (busy || !contact.trim()) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Send me a code</Text>}
            </Pressable>
          </>
        )}

        {step === "code" && (
          <>
            <Text style={styles.heading} accessibilityRole="header">
              Enter your code
            </Text>
            <Text style={styles.body}>
              We sent a 6-digit code to <Text style={styles.strong}>{sentTo}</Text>. It works for 10 minutes.
            </Text>
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
              editable={!busy}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              maxLength={6}
            />
            {error && (
              <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
                {error}
              </Text>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Finish signing up" onPress={verify} disabled={busy || code.length !== 6} style={[styles.primary, (busy || code.length !== 6) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Finish signing up</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Use a different contact or send a new code"
              onPress={() => {
                setStep("contact");
                setError(null);
              }}
              disabled={busy}
              style={styles.outline}
            >
              <Text style={styles.outlineText}>Send a new code or change it</Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 60 },
  column: { width: "100%", maxWidth: 520, alignSelf: "center", gap: 10 },
  center: { flex: 1, padding: 24, gap: 14, justifyContent: "center", backgroundColor: "#fff", maxWidth: 520, width: "100%", alignSelf: "center" },
  progress: { fontSize: 14, fontWeight: "700", color: "#0b5fff" },
  heading: { fontSize: 26, fontWeight: "700" },
  body: { fontSize: 16, color: "#222" },
  strong: { fontWeight: "700" },
  label: { fontSize: 15, fontWeight: "600", marginTop: 6 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 18, minHeight: 52, backgroundColor: "#fff" },
  codeInput: { fontSize: 28, letterSpacing: 8, textAlign: "center" },
  confirmBox: { gap: 8, backgroundColor: "#f2f2f2", borderRadius: 10, padding: 14 },
  check: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, minHeight: 52, justifyContent: "center", backgroundColor: "#fff" },
  checkOn: { backgroundColor: "#0b5fff", borderColor: "#0b5fff" },
  checkText: { fontSize: 16, fontWeight: "700", color: "#1a1a1a" },
  checkTextOn: { color: "#fff" },
  error: { color: "#b00020", fontSize: 16, fontWeight: "600" },
  dev: { backgroundColor: "#fff7e0", borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "#e0c060" },
  devText: { fontSize: 15, color: "#111" },
  primary: { backgroundColor: "#0b5fff", borderRadius: 10, paddingVertical: 16, minHeight: 56, alignItems: "center", justifyContent: "center", marginTop: 8 },
  primaryText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingVertical: 14, minHeight: 52, alignItems: "center", justifyContent: "center" },
  outlineText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
});
