import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  getFamily,
  inviteFamily,
  resendFamilyInvite,
  revokeFamily,
  setFamilyVisibility,
  type Delivery,
  type FamilyEntry,
  type FamilyStatus,
} from "@/lib/api";
import { HomeBar } from "@/components/HomeBar";
import { Chip } from "@/components/Chip";

const STATUS_TEXT: Record<FamilyStatus, string> = {
  INVITED: "Invitation sent. Waiting for them to open it.",
  EXPIRED: "The invitation expired. Resend it to give them a new link.",
  NEEDS_SECOND_CONTACT: "Started signing up. Still needs to add and verify their second contact.",
  ACTIVE: "Signed up and active.",
  REVOKED: "Access is turned off.",
};

function DeliveryNotice({ delivery, who }: { delivery: Delivery; who: string }) {
  return (
    <View style={[styles.notice, !delivery.delivered && styles.noticeBad]} accessibilityLiveRegion="polite">
      <Text style={styles.noticeText}>
        {delivery.delivered
          ? delivery.provider === "dev-outbox"
            ? `Development mode: nothing was really emailed or texted to ${who}.`
            : `Invitation sent to ${who}.`
          : `The invitation to ${who} could not be delivered. You can use Resend to try again.`}
      </Text>
      {delivery.devLink && (
        <>
          <Text style={styles.noticeText}>This is the link they would have received:</Text>
          <Text style={styles.link} selectable>
            {delivery.devLink}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Open the invitation link to sign up as this person" onPress={() => Linking.openURL(delivery.devLink!)} style={styles.outline}>
            <Text style={styles.outlineText}>Open the invitation link</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export default function FamilyScreen() {
  const { token, user, signOut } = useAuth();
  const isClient = user?.role === "CLIENT";
  const [family, setFamily] = useState<FamilyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [via, setVia] = useState<"EMAIL" | "SMS">("EMAIL");
  const [contact, setContact] = useState("");
  const [photoAccess, setPhotoAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<{ who: string; delivery: Delivery } | null>(null);

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<Record<string, { who: string; delivery: Delivery } | string>>({});
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || user?.role === "IP" || user?.role === "FAMILY") return;
    try {
      setFamily((await getFamily(token)).family);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load family members.");
    }
  }, [token, user?.role]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  if (user && (user.role === "IP" || user.role === "FAMILY")) return <Redirect href={user.role === "IP" ? "/home" : "/review"} />;

  const ready = firstName.trim() && lastName.trim() && contact.trim();

  async function send() {
    if (!token) return;
    setBusy(true);
    setFormError(null);
    setLastSent(null);
    try {
      const { delivery } = await inviteFamily(token, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        relationship: relationship.trim() || undefined,
        ...(via === "EMAIL" ? { email: contact.trim() } : { phone: contact.trim() }),
        canViewTimestamps: isClient ? photoAccess : undefined,
      });
      setLastSent({ who: `${firstName.trim()} ${lastName.trim()}`, delivery });
      setFirstName("");
      setLastName("");
      setRelationship("");
      setContact("");
      setPhotoAccess(false);
      setAdding(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not send the invitation. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function rowAction(id: string, action: () => Promise<unknown>, onDone?: (result: unknown) => void) {
    setRowBusy(id);
    try {
      const result = await action();
      onDone?.(result);
      await load();
    } catch (err) {
      setRowNotice((n) => ({ ...n, [id]: err instanceof ApiError ? err.message : "That did not go through. Try again." }));
    } finally {
      setRowBusy(null);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading family access" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <HomeBar />

      <Text style={styles.title} accessibilityRole="header">
        Family access
      </Text>
      <Text style={styles.help}>
        Invite family members so they can follow along and leave comments. Each person gets their own sign-in. By default they see task status and history, but not photos or times.
        {isClient ? " You decide who may also see photos and times." : " Only the client can approve photo and time access, or turn someone's access off."}
      </Text>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}
      {lastSent && <DeliveryNotice delivery={lastSent.delivery} who={lastSent.who} />}

      {adding ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            Invite a family member
          </Text>

          <Text style={styles.label}>First name</Text>
          <TextInput style={styles.input} accessibilityLabel="First name" value={firstName} onChangeText={setFirstName} editable={!busy} autoCapitalize="words" />
          <Text style={styles.label}>Last name</Text>
          <TextInput style={styles.input} accessibilityLabel="Last name" value={lastName} onChangeText={setLastName} editable={!busy} autoCapitalize="words" />
          <Text style={styles.label}>Relationship (optional, for example Sister)</Text>
          <TextInput style={styles.input} accessibilityLabel="Relationship" value={relationship} onChangeText={setRelationship} editable={!busy} />

          <Text style={styles.label}>Send the invitation by</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            <Chip label="Email" selected={via === "EMAIL"} onPress={() => setVia("EMAIL")} disabled={busy} />
            <Chip label="Text message" selected={via === "SMS"} onPress={() => setVia("SMS")} disabled={busy} />
          </View>
          <Text style={styles.label}>{via === "EMAIL" ? "Their email address" : "Their mobile phone number"}</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel={via === "EMAIL" ? "Their email address" : "Their mobile phone number"}
            value={contact}
            onChangeText={setContact}
            editable={!busy}
            autoCapitalize="none"
            keyboardType={via === "EMAIL" ? "email-address" : "phone-pad"}
          />
          <Text style={styles.small}>They will confirm this {via === "EMAIL" ? "email address" : "phone number"} when they sign up, and then add and verify their {via === "EMAIL" ? "phone number" : "email address"}.</Text>

          {isClient && (
            <>
              <Text style={styles.label}>May they see photos and times?</Text>
              <View style={styles.row} accessibilityRole="radiogroup">
                <Chip label="Status and history only" selected={!photoAccess} onPress={() => setPhotoAccess(false)} disabled={busy} />
                <Chip label="Also photos and times" selected={photoAccess} onPress={() => setPhotoAccess(true)} disabled={busy} />
              </View>
            </>
          )}

          {formError && (
            <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
              {formError}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Send invitation" onPress={send} disabled={busy || !ready} style={[styles.primary, (busy || !ready) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Send invitation</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={() => {
                setAdding(false);
                setFormError(null);
              }}
              disabled={busy}
              style={styles.outline}
            >
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Invite a family member" onPress={() => setAdding(true)} style={styles.addButton}>
          <Text style={styles.addText}>+ Invite a family member</Text>
        </Pressable>
      )}

      <Text style={styles.section} accessibilityRole="header">
        People ({family.length})
      </Text>
      {family.length === 0 && <Text style={styles.help}>No family members have been invited yet.</Text>}

      {family.map((f) => {
        const notice = rowNotice[f.id];
        const open = f.status !== "REVOKED";
        return (
          <View key={f.id} style={[styles.card, f.status === "REVOKED" && styles.dim]}>
            <Text style={styles.cardTitle} accessibilityRole="header">
              {f.name}
              {f.relationship ? ` (${f.relationship})` : ""}
            </Text>
            <Text style={[styles.status, f.status === "ACTIVE" && styles.statusGood]}>{STATUS_TEXT[f.status]}</Text>
            <Text style={styles.small}>
              {f.email ? `Email: ${f.email}${f.emailVerified ? " (verified)" : f.invitedVia === "EMAIL" ? " (invited)" : ""}` : "Email: not added yet"}
            </Text>
            <Text style={styles.small}>
              {f.phone ? `Phone: ${f.phone}${f.phoneVerified ? " (verified)" : f.invitedVia === "SMS" ? " (invited)" : ""}` : "Phone: not added yet"}
            </Text>
            <Text style={styles.small}>
              {f.canViewTimestamps ? "Can see photos and times." : "Sees status and history only (no photos or times)."}
              {f.invitedBy ? ` Invited by ${f.invitedBy}.` : ""}
            </Text>

            {typeof notice === "string" && (
              <Text style={styles.error} role="alert">
                {notice}
              </Text>
            )}
            {notice && typeof notice !== "string" && <DeliveryNotice delivery={notice.delivery} who={notice.who} />}

            {open && (
              <View style={styles.row}>
                {f.status !== "ACTIVE" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Resend the invitation to ${f.name}`}
                    onPress={() => rowAction(f.id, () => resendFamilyInvite(token!, f.id), (r) => setRowNotice((n) => ({ ...n, [f.id]: { who: f.name, delivery: (r as { delivery: Delivery }).delivery } })))}
                    disabled={rowBusy === f.id}
                    style={styles.outline}
                  >
                    <Text style={styles.outlineText}>Resend invitation</Text>
                  </Pressable>
                )}
                {isClient && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${f.canViewTimestamps ? "Stop letting" : "Let"} ${f.name} see photos and times`}
                    onPress={() => rowAction(f.id, () => setFamilyVisibility(token!, f.id, !f.canViewTimestamps))}
                    disabled={rowBusy === f.id}
                    style={styles.outline}
                  >
                    <Text style={styles.outlineText}>{f.canViewTimestamps ? "Hide photos and times" : "Allow photos and times"}</Text>
                  </Pressable>
                )}
                {isClient &&
                  (confirmRevoke === f.id ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Yes, turn off access for ${f.name}`}
                        onPress={() => rowAction(f.id, () => revokeFamily(token!, f.id), () => setConfirmRevoke(null))}
                        disabled={rowBusy === f.id}
                        style={styles.danger}
                      >
                        <Text style={styles.dangerText}>Yes, turn off access</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" accessibilityLabel="Keep their access" onPress={() => setConfirmRevoke(null)} style={styles.outline}>
                        <Text style={styles.outlineText}>Keep access</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable accessibilityRole="button" accessibilityLabel={`Turn off access for ${f.name}`} onPress={() => setConfirmRevoke(f.id)} style={styles.dangerOutline}>
                      <Text style={styles.dangerOutlineText}>Turn off access</Text>
                    </Pressable>
                  ))}
              </View>
            )}
          </View>
        );
      })}

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 100, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 26, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  section: { fontSize: 20, fontWeight: "700", marginTop: 10 },
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 8 },
  dim: { backgroundColor: "#f2f2f2", opacity: 0.85 },
  cardTitle: { fontSize: 18, fontWeight: "700" },
  status: { fontSize: 15, fontWeight: "600", color: "#8a5a00" },
  statusGood: { color: "#157a3d" },
  small: { fontSize: 14, color: "#333" },
  label: { fontSize: 14, fontWeight: "600", marginTop: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  notice: { backgroundColor: "#eef4ff", borderRadius: 8, padding: 12, gap: 6, borderWidth: 1, borderColor: "#9db8f0" },
  noticeBad: { backgroundColor: "#fdecec", borderColor: "#e0a0a0" },
  noticeText: { fontSize: 14, color: "#111" },
  link: { fontSize: 13, color: "#0b5fff" },
  addButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  addText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  primary: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 22, minHeight: 48, justifyContent: "center" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 15, fontWeight: "700" },
  danger: { backgroundColor: "#8a1c1c", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  dangerText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  dangerOutline: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  dangerOutlineText: { color: "#8a1c1c", fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
