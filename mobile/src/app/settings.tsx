import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  changeMyPassword,
  confirmContactChange,
  getProfile,
  startContactChange,
  updateProfileName,
  type Profile,
} from "@/lib/api";
import { HomeBar } from "@/components/HomeBar";

const MIN_PASSWORD = 10;
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export default function SettingsScreen() {
  const { token, user, loading, signOut, startSession } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setProfile((await getProfile(token)).profile);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Could not load your settings. Check your connection."));
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  // Wait for the saved sign-in to load before deciding the person is signed out.
  if (!loading && !token) return <Redirect href="/login" />;

  if (loading || !profile) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading your settings" />}
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <HomeBar />
      <Text style={styles.title} accessibilityRole="header">
        Settings
      </Text>
      <Text style={styles.help}>Your own information. Only you can change it.</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          About you
        </Text>
        <Text style={styles.line}>Role: {profile.roleLabel}</Text>
        {profile.relationship ? <Text style={styles.line}>Relationship: {profile.relationship}</Text> : null}
        <Text style={styles.line}>Household: {profile.household.name}</Text>
        {profile.canViewTimestamps !== null && (
          <Text style={styles.line}>Photos and times: {profile.canViewTimestamps ? "approved by the client" : "not approved by the client"}</Text>
        )}
      </View>

      <NameCard
        profile={profile}
        onSave={async (first, last) => {
          const result = await updateProfileName(token!, first, last);
          setProfile(result.profile);
          // The saved sign-in carries the display name, so the greeting on Home follows.
          if (user) await startSession({ token: token!, user: { ...user, name: result.profile.name } });
        }}
      />

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          How you sign in
        </Text>
        <Text style={styles.small}>You can sign in with either one. A new one only replaces the old one after you enter the code we send to it.</Text>
        <ContactCard
          kind="email"
          current={profile.email}
          verified={profile.emailVerified}
          onProfile={setProfile}
          start={(value) => startContactChange(token!, value)}
          confirm={(code) => confirmContactChange(token!, code).then((r) => r.profile)}
        />
        <ContactCard
          kind="phone"
          current={profile.phone}
          verified={profile.phoneVerified}
          onProfile={setProfile}
          start={(value) => startContactChange(token!, value)}
          confirm={(code) => confirmContactChange(token!, code).then((r) => r.profile)}
        />
      </View>

      <PasswordCard
        onSave={async (current, next) => {
          const result = await changeMyPassword(token!, current, next);
          // Other devices are signed out; this one continues with a fresh session.
          if (user) await startSession({ token: result.token, user });
        }}
      />

      <View style={styles.card}>
        <Text style={styles.cardTitle} accessibilityRole="header">
          Reading aloud
        </Text>
        <Text style={styles.small}>Reading speed and whether new urgent alerts are read out loud are on the Hear screen.</Text>
        {user?.role !== "IP" && (
          <Pressable accessibilityRole="button" accessibilityLabel="Open reading and voice settings" onPress={() => router.push("/hear")} style={styles.outline}>
            <Text style={styles.outlineText}>Open Hear</Text>
          </Pressable>
        )}
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.outline}>
        <Text style={styles.outlineText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function Notice({ kind, text }: { kind: "ok" | "error"; text: string | null }) {
  if (!text) return null;
  return (
    <Text style={kind === "ok" ? styles.ok : styles.error} accessibilityLiveRegion="polite" role={kind === "error" ? "alert" : undefined}>
      {kind === "ok" ? "✓ " : ""}
      {text}
    </Text>
  );
}

function NameCard({ profile, onSave }: { profile: Profile; onSave: (first: string, last: string) => Promise<void> }) {
  const [first, setFirst] = useState(profile.firstName);
  const [last, setLast] = useState(profile.lastName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const unchanged = first.trim() === profile.firstName && last.trim() === profile.lastName;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await onSave(first, last);
      setMessage({ kind: "ok", text: "Your name was saved." });
    } catch (err) {
      setMessage({ kind: "error", text: errorText(err, "Could not save. Check your connection and try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Your name
      </Text>
      <Text style={styles.label}>First name</Text>
      <TextInput style={styles.input} accessibilityLabel="First name" value={first} onChangeText={(v) => { setFirst(v); setMessage(null); }} editable={!busy} autoCapitalize="words" autoComplete="given-name" />
      <Text style={styles.label}>Last name</Text>
      <TextInput style={styles.input} accessibilityLabel="Last name" value={last} onChangeText={(v) => { setLast(v); setMessage(null); }} editable={!busy} autoCapitalize="words" autoComplete="family-name" />
      <Notice kind={message?.kind ?? "ok"} text={message?.text ?? null} />
      <Pressable accessibilityRole="button" accessibilityLabel="Save name" accessibilityState={{ disabled: busy || unchanged }} disabled={busy || unchanged} onPress={save} style={[styles.primary, (busy || unchanged) && styles.disabled]}>
        <Text style={styles.primaryText}>{busy ? "Saving…" : "Save name"}</Text>
      </Pressable>
    </View>
  );
}

interface ContactProps {
  kind: "email" | "phone";
  current: string | null;
  verified: boolean;
  onProfile: (p: Profile) => void;
  start: (value: string) => Promise<{ channel: "EMAIL" | "SMS"; maskedTo: string; devCode?: string }>;
  confirm: (code: string) => Promise<Profile>;
}

function ContactCard({ kind, current, verified, onProfile, start, confirm }: ContactProps) {
  const label = kind === "email" ? "Email address" : "Phone number";
  const [step, setStep] = useState<"idle" | "value" | "code">("idle");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await start(value);
      setSentTo(result.maskedTo);
      setDevCode(result.devCode);
      setCode("");
      setStep("code");
    } catch (err) {
      setMessage({ kind: "error", text: errorText(err, "Could not send the code. Check your connection and try again.") });
    } finally {
      setBusy(false);
    }
  }

  async function confirmIt() {
    setBusy(true);
    setMessage(null);
    try {
      onProfile(await confirm(code));
      setStep("idle");
      setValue("");
      setCode("");
      setMessage({ kind: "ok", text: `Your ${label.toLowerCase()} was changed.` });
    } catch (err) {
      setMessage({ kind: "error", text: errorText(err, "Could not confirm. Check your connection and try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.contact}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>
        {current ?? "Not added yet"}
        {current ? (verified ? "  ✓ confirmed" : "  (not confirmed)") : ""}
      </Text>

      {step === "idle" && (
        <Pressable accessibilityRole="button" accessibilityLabel={`${current ? "Change" : "Add"} ${label.toLowerCase()}`} onPress={() => { setMessage(null); setStep("value"); }} style={styles.outline}>
          <Text style={styles.outlineText}>{current ? "Change" : "Add"}</Text>
        </Pressable>
      )}

      {step === "value" && (
        <>
          <TextInput
            style={styles.input}
            accessibilityLabel={`New ${label.toLowerCase()}`}
            placeholder={kind === "email" ? "name@example.com" : "(312) 555-0123"}
            value={value}
            onChangeText={setValue}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={kind === "email" ? "email-address" : "phone-pad"}
          />
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Send me a code" disabled={busy || !value.trim()} onPress={send} style={[styles.primary, (busy || !value.trim()) && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? "Sending…" : "Send me a code"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { setStep("idle"); setMessage(null); }} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      )}

      {step === "code" && (
        <>
          <Text style={styles.small}>We sent a 6-digit code to {sentTo}. It works for 15 minutes.</Text>
          {devCode ? <Text style={styles.dev}>Development only: no real message is sent. Your code is {devCode}.</Text> : null}
          <TextInput style={styles.input} accessibilityLabel="6-digit code" value={code} onChangeText={setCode} editable={!busy} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" />
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Confirm the code" disabled={busy || code.trim().length !== 6} onPress={confirmIt} style={[styles.primary, (busy || code.trim().length !== 6) && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? "Checking…" : "Confirm"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { setStep("idle"); setMessage(null); }} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      )}
      <Notice kind={message?.kind ?? "ok"} text={message?.text ?? null} />
    </View>
  );
}

function PasswordCard({ onSave }: { onSave: (current: string, next: string) => Promise<void> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save() {
    setMessage(null);
    if (next.length < MIN_PASSWORD) return setMessage({ kind: "error", text: `Choose a new password of at least ${MIN_PASSWORD} characters.` });
    if (next !== again) return setMessage({ kind: "error", text: "The two new passwords are not the same." });
    setBusy(true);
    try {
      await onSave(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setMessage({ kind: "ok", text: "Your password was changed. Other devices were signed out." });
    } catch (err) {
      setMessage({ kind: "error", text: errorText(err, "Could not change it. Check your connection and try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} accessibilityRole="header">
        Password
      </Text>
      <Text style={styles.label}>Current password</Text>
      <TextInput style={styles.input} accessibilityLabel="Current password" secureTextEntry value={current} onChangeText={setCurrent} editable={!busy} autoComplete="current-password" />
      <Text style={styles.label}>New password (at least {MIN_PASSWORD} characters)</Text>
      <TextInput style={styles.input} accessibilityLabel="New password" secureTextEntry value={next} onChangeText={setNext} editable={!busy} autoComplete="new-password" />
      <Text style={styles.label}>New password again</Text>
      <TextInput style={styles.input} accessibilityLabel="New password again" secureTextEntry value={again} onChangeText={setAgain} editable={!busy} autoComplete="new-password" />
      <Notice kind={message?.kind ?? "ok"} text={message?.text ?? null} />
      <Pressable accessibilityRole="button" accessibilityLabel="Change password" disabled={busy || !current || !next} onPress={save} style={[styles.primary, (busy || !current || !next) && styles.disabled]}>
        <Text style={styles.primaryText}>{busy ? "Saving…" : "Change password"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 60, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 26, fontWeight: "700", color: "#1a1a1a" },
  help: { fontSize: 16, color: "#333" },
  card: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, padding: 14, gap: 8 },
  cardTitle: { fontSize: 19, fontWeight: "700", color: "#1a1a1a" },
  line: { fontSize: 16, color: "#222" },
  small: { fontSize: 14, color: "#444", lineHeight: 20 },
  label: { fontSize: 15, fontWeight: "600", color: "#222", marginTop: 4 },
  value: { fontSize: 17, color: "#1a1a1a" },
  contact: { gap: 6, borderTopWidth: 1, borderTopColor: "#ccc", paddingTop: 8, marginTop: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  primary: { backgroundColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, justifyContent: "center", alignItems: "center", alignSelf: "flex-start" },
  outlineText: { color: "#1a1a1a", fontSize: 16, fontWeight: "700" },
  error: { color: "#a1130f", fontSize: 15, fontWeight: "600" },
  ok: { color: "#2d6a2d", fontSize: 15, fontWeight: "700" },
  dev: { fontSize: 14, color: "#6b4e00", backgroundColor: "#fff6d6", padding: 8, borderRadius: 6 },
});
