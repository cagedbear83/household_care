import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  createFoodRequest,
  FOOD_REASONS,
  getMyFoodRequests,
  recordFoodDisposal,
  reportFoodHazard,
  reportLowSupply,
  requestFoodChallenge,
  type FoodIpRequest,
} from "@/lib/api";
import { getVerifiedCoords } from "@/lib/location";
import { CameraCapture, type CapturedPhoto } from "@/components/CameraCapture";
import { Chip } from "@/components/Chip";
import { HomeBar } from "@/components/HomeBar";

type Panel = "food" | "hazard" | "low" | null;
type Target = "food" | "hazard";
interface Shot {
  photo: CapturedPhoto;
  challengeId: string;
}

const STATUS_TEXT = (r: FoodIpRequest): string => {
  switch (r.status) {
    case "PENDING":
      return r.leaveInPlace ? "No answer yet. Leave it where it is. The administrator has been told." : "Waiting for the client. Leave it where it is until they answer.";
    case "APPROVED":
      return "Approved. You can throw it away now, then tell the app it is done.";
    case "DECLINED":
      return `Declined${r.decisionNote ? `: ${r.decisionNote}` : ""}. Leave it where it is.`;
    case "DISPOSED":
      return "Thrown away and recorded.";
    case "HAZARD_REPORTED":
      return "Reported. Waiting for the client to acknowledge it.";
    case "HAZARD_ACKNOWLEDGED":
      return "The client acknowledged it.";
  }
};

async function currentCoords() {
  try {
    return await getVerifiedCoords();
  } catch {
    return null;
  }
}

export default function SuppliesScreen() {
  const { token, user } = useAuth();
  const [requests, setRequests] = useState<FoodIpRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Food to throw away
  const [item, setItem] = useState("");
  const [where, setWhere] = useState("");
  const [reasonCode, setReasonCode] = useState("past_date");
  const [reasonText, setReasonText] = useState("");
  const [dateLabel, setDateLabel] = useState("");
  const [replacement, setReplacement] = useState("");
  const [foodShot, setFoodShot] = useState<Shot | null>(null);

  // Immediate hazard
  const [hItem, setHItem] = useState("");
  const [hWhere, setHWhere] = useState("");
  const [hReason, setHReason] = useState("");
  const [hAction, setHAction] = useState("");
  const [hReplacement, setHReplacement] = useState("");
  const [hazardShot, setHazardShot] = useState<Shot | null>(null);

  // Low supply
  const [lItem, setLItem] = useState("");
  const [lLevel, setLLevel] = useState<"LOW" | "OUT">("LOW");
  const [lWhere, setLWhere] = useState("");
  const [lNote, setLNote] = useState("");

  const [capturing, setCapturing] = useState<{ target: Target; challengeId: string } | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [confirmDone, setConfirmDone] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || user?.role !== "IP") return;
    try {
      setRequests((await getMyFoodRequests(token)).requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your requests.");
    }
  }, [token, user?.role]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  // The client's answer shows up without pulling to refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  if (user && user.role !== "IP") return <Redirect href="/" />;

  function open(next: Panel) {
    setPanel(panel === next ? null : next);
    setError(null);
    setNotice(null);
  }

  async function startCapture(target: Target) {
    if (!token) return;
    setError(null);
    setCaptureError(null);
    try {
      const { challengeId } = await requestFoodChallenge(token);
      setCapturing({ target, challengeId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the camera. Check your connection and try again.");
    }
  }

  function keepPhoto(photo: CapturedPhoto) {
    if (!capturing) return;
    const shot = { photo, challengeId: capturing.challengeId };
    if (capturing.target === "food") setFoodShot(shot);
    else setHazardShot(shot);
    setCapturing(null);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHALLENGE_INVALID") {
        setFoodShot(null);
        setHazardShot(null);
      }
      setError(err instanceof ApiError ? err.message : "That did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const foodReady = item.trim() && where.trim() && foodShot && (reasonCode !== "other" || reasonText.trim());
  const hazardReady = hItem.trim() && hWhere.trim() && hReason.trim() && hAction.trim();

  const sendFood = () =>
    run(async () => {
      const coords = await currentCoords();
      await createFoodRequest(token!, {
        item: item.trim(),
        location: where.trim(),
        reasonCode,
        reasonText: reasonText.trim() || undefined,
        dateLabel: dateLabel.trim() || undefined,
        replacement: replacement.trim() || undefined,
        challengeId: foodShot!.challengeId,
        imageBase64: foodShot!.photo.base64,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        accuracyMeters: coords?.accuracyMeters ?? null,
      });
      setItem("");
      setWhere("");
      setReasonText("");
      setDateLabel("");
      setReplacement("");
      setFoodShot(null);
      setPanel(null);
      setNotice("Sent to the client. Leave the item where it is until they say yes.");
    });

  const sendHazard = () =>
    run(async () => {
      const coords = hazardShot ? await currentCoords() : null;
      await reportFoodHazard(token!, {
        item: hItem.trim(),
        location: hWhere.trim(),
        reason: hReason.trim(),
        actionTaken: hAction.trim(),
        replacement: hReplacement.trim() || undefined,
        photo: hazardShot
          ? {
              challengeId: hazardShot.challengeId,
              imageBase64: hazardShot.photo.base64,
              lat: coords?.lat ?? null,
              lng: coords?.lng ?? null,
              accuracyMeters: coords?.accuracyMeters ?? null,
            }
          : undefined,
      });
      setHItem("");
      setHWhere("");
      setHReason("");
      setHAction("");
      setHReplacement("");
      setHazardShot(null);
      setPanel(null);
      setNotice("Reported. The client and the administrator were told right away.");
    });

  const sendLow = () =>
    run(async () => {
      const result = await reportLowSupply(token!, { item: lItem.trim(), level: lLevel, location: lWhere.trim() || undefined, note: lNote.trim() || undefined });
      setLItem("");
      setLWhere("");
      setLNote("");
      setPanel(null);
      setNotice(result.added ? "Added to the shopping list. The client and administrator were told." : "That was already on the list. It was updated.");
    });

  async function markDisposed(id: string) {
    if (!token) return;
    setRowBusy(id);
    setError(null);
    try {
      await recordFoodDisposal(token, id);
      setConfirmDone(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not go through. Try again.");
    } finally {
      setRowBusy(null);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading" />
      </View>
    );
  }

  const photoBox = (shot: Shot | null, target: Target, optional: boolean) => (
    <View style={styles.photoRow}>
      {shot && <Image source={{ uri: shot.photo.uri }} style={styles.thumb} accessibilityLabel="The photo you took" />}
      <Pressable accessibilityRole="button" accessibilityLabel={shot ? "Retake the photo" : "Take a photo"} onPress={() => startCapture(target)} disabled={busy} style={styles.outline}>
        <Text style={styles.outlineText}>{shot ? "Retake photo" : `Take photo${optional ? " (optional)" : ""}`}</Text>
      </Pressable>
    </View>
  );

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <HomeBar />
        <Pressable accessibilityRole="button" accessibilityLabel="Back to today" onPress={() => router.replace("/today")} style={styles.back}>
          <Text style={styles.backText}>‹ Today</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Food and supplies
        </Text>
        <Text style={styles.help}>Ask before throwing food away, and report anything that is running low. You are not asked to do the shopping.</Text>

        {notice && (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        )}
        {error && (
          <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
            {error}
          </Text>
        )}

        {/* Food to throw away */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: panel === "food" }} accessibilityLabel="Ask to throw food away" onPress={() => open("food")} style={styles.sectionButton}>
          <Text style={styles.sectionButtonText}>Ask to throw food away</Text>
        </Pressable>
        {panel === "food" && (
          <View style={styles.card}>
            <Text style={styles.small}>Do not throw it away until the client says yes.</Text>
            <Text style={styles.label}>What is it?</Text>
            <TextInput style={styles.input} accessibilityLabel="What is the food" value={item} onChangeText={setItem} editable={!busy} />
            <Text style={styles.label}>Exactly where is it? (for example, refrigerator, top shelf, left side)</Text>
            <TextInput style={styles.input} accessibilityLabel="Exactly where it is" value={where} onChangeText={setWhere} editable={!busy} />
            <Text style={styles.label}>Why should it be thrown away?</Text>
            <View style={styles.row} accessibilityRole="radiogroup">
              {FOOD_REASONS.map((r) => (
                <Chip key={r.code} label={r.label} selected={reasonCode === r.code} onPress={() => setReasonCode(r.code)} disabled={busy} />
              ))}
            </View>
            {reasonCode === "other" && (
              <TextInput style={styles.input} accessibilityLabel="Describe the reason" placeholder="Describe the reason" value={reasonText} onChangeText={setReasonText} editable={!busy} />
            )}
            <Text style={styles.label}>Date on the label (if there is one)</Text>
            <TextInput style={styles.input} accessibilityLabel="Date on the label" placeholder="For example: use by Sep 28" value={dateLabel} onChangeText={setDateLabel} editable={!busy} />
            <Text style={styles.label}>Replacement to buy (leave empty if it is not something to restock)</Text>
            <TextInput style={styles.input} accessibilityLabel="Replacement to buy" placeholder="For example: milk, 1 gallon" value={replacement} onChangeText={setReplacement} editable={!busy} />
            <Text style={styles.label}>Photo (taken in the app)</Text>
            {photoBox(foodShot, "food", false)}
            <Pressable accessibilityRole="button" accessibilityLabel="Ask the client" onPress={sendFood} disabled={busy || !foodReady} style={[styles.primary, (busy || !foodReady) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Ask the client</Text>}
            </Pressable>
          </View>
        )}

        {/* Hazard */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: panel === "hazard" }} accessibilityLabel="Report an immediate food hazard" onPress={() => open("hazard")} style={[styles.sectionButton, styles.hazardButton]}>
          <Text style={[styles.sectionButtonText, styles.hazardText]}>Report an immediate food hazard</Text>
        </Pressable>
        {panel === "hazard" && (
          <View style={styles.card}>
            <Text style={styles.small}>Only for something obviously unsafe that could not wait for an answer, such as raw meat leaking onto other food. This is recorded as an exception and the client and administrator are told right away. For anything else, ask first.</Text>
            <Text style={styles.label}>What was it?</Text>
            <TextInput style={styles.input} accessibilityLabel="What was the food" value={hItem} onChangeText={setHItem} editable={!busy} />
            <Text style={styles.label}>Where was it?</Text>
            <TextInput style={styles.input} accessibilityLabel="Where it was" value={hWhere} onChangeText={setHWhere} editable={!busy} />
            <Text style={styles.label}>Why was it an immediate hazard?</Text>
            <TextInput style={[styles.input, styles.multiline]} accessibilityLabel="Why it was a hazard" value={hReason} onChangeText={setHReason} multiline editable={!busy} />
            <Text style={styles.label}>What did you do about it?</Text>
            <TextInput style={[styles.input, styles.multiline]} accessibilityLabel="What you did" value={hAction} onChangeText={setHAction} multiline editable={!busy} />
            <Text style={styles.label}>Replacement to buy (optional)</Text>
            <TextInput style={styles.input} accessibilityLabel="Replacement to buy" value={hReplacement} onChangeText={setHReplacement} editable={!busy} />
            <Text style={styles.label}>Photo</Text>
            {photoBox(hazardShot, "hazard", true)}
            <Pressable accessibilityRole="button" accessibilityLabel="Report the hazard" onPress={sendHazard} disabled={busy || !hazardReady} style={[styles.danger, (busy || !hazardReady) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.dangerText}>Report the hazard</Text>}
            </Pressable>
          </View>
        )}

        {/* Low supply */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: panel === "low" }} accessibilityLabel="Report something running low" onPress={() => open("low")} style={styles.sectionButton}>
          <Text style={styles.sectionButtonText}>Report something running low</Text>
        </Pressable>
        {panel === "low" && (
          <View style={styles.card}>
            <Text style={styles.label}>What is running low?</Text>
            <TextInput style={styles.input} accessibilityLabel="What is running low" placeholder="For example: eggs, dish soap" value={lItem} onChangeText={setLItem} editable={!busy} />
            <Text style={styles.label}>Is there any left?</Text>
            <View style={styles.row} accessibilityRole="radiogroup">
              <Chip label="A little left" selected={lLevel === "LOW"} onPress={() => setLLevel("LOW")} disabled={busy} />
              <Chip label="None left" selected={lLevel === "OUT"} onPress={() => setLLevel("OUT")} disabled={busy} />
            </View>
            <Text style={styles.label}>Where is it kept? (optional)</Text>
            <TextInput style={styles.input} accessibilityLabel="Where it is kept" value={lWhere} onChangeText={setLWhere} editable={!busy} />
            <Text style={styles.label}>Anything else to add? (optional)</Text>
            <TextInput style={styles.input} accessibilityLabel="Note" value={lNote} onChangeText={setLNote} editable={!busy} />
            <Pressable accessibilityRole="button" accessibilityLabel="Add to the shopping list" onPress={sendLow} disabled={busy || !lItem.trim()} style={[styles.primary, (busy || !lItem.trim()) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Add to the shopping list</Text>}
            </Pressable>
          </View>
        )}

        <Text style={styles.section} accessibilityRole="header">
          Your requests
        </Text>
        {requests.length === 0 && <Text style={styles.help}>Nothing yet.</Text>}
        {requests.map((r) => (
          <View key={r.id} style={[styles.card, r.status === "APPROVED" && styles.cardGood]}>
            <Text style={styles.cardTitle}>
              {r.item}
              {r.kind === "HAZARD" ? "  (hazard)" : ""}
            </Text>
            <Text style={styles.small}>
              {r.location}. {r.reason}
              {r.dateLabel ? `. Label: ${r.dateLabel}` : ""}
            </Text>
            <Text style={styles.status} accessibilityLiveRegion="polite">
              {STATUS_TEXT(r)}
            </Text>
            {r.status === "APPROVED" &&
              (confirmDone === r.id ? (
                <View style={styles.row}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Yes, ${r.item} has been thrown away`} onPress={() => markDisposed(r.id)} disabled={rowBusy === r.id} style={styles.primary}>
                    {rowBusy === r.id ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Yes, it is thrown away</Text>}
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Not yet" onPress={() => setConfirmDone(null)} style={styles.outline}>
                    <Text style={styles.outlineText}>Not yet</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable accessibilityRole="button" accessibilityLabel={`I threw away ${r.item}`} onPress={() => setConfirmDone(r.id)} style={styles.primary}>
                  <Text style={styles.primaryText}>I threw it away</Text>
                </Pressable>
              ))}
          </View>
        ))}
      </ScrollView>

      <Modal visible={capturing !== null} animationType="slide" onRequestClose={() => setCapturing(null)}>
        <CameraCapture
          title={capturing?.target === "hazard" ? "Photo of the hazard" : "Photo of the food"}
          ready
          busy={false}
          error={captureError}
          useLabel="Use this photo"
          onUse={keepPhoto}
          onCancel={() => {
            setCapturing(null);
            setCaptureError(null);
          }}
        />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 100, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  back: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  backText: { color: "#0b5fff", fontSize: 16, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  notice: { fontSize: 15, fontWeight: "600", color: "#157a3d", backgroundColor: "#eaf6ee", borderRadius: 8, padding: 12 },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  section: { fontSize: 20, fontWeight: "700", marginTop: 10 },
  sectionButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 14, minHeight: 52, justifyContent: "center", paddingHorizontal: 14 },
  sectionButtonText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  hazardButton: { borderColor: "#8a1c1c" },
  hazardText: { color: "#8a1c1c" },
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 8 },
  cardGood: { borderWidth: 2, borderColor: "#157a3d" },
  cardTitle: { fontSize: 18, fontWeight: "700" },
  small: { fontSize: 14, color: "#333" },
  status: { fontSize: 15, fontWeight: "600", color: "#222" },
  label: { fontSize: 14, fontWeight: "600", marginTop: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  thumb: { width: 96, height: 72, borderRadius: 8, backgroundColor: "#ddd" },
  primary: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  danger: { backgroundColor: "#8a1c1c", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48, alignItems: "center", justifyContent: "center" },
  dangerText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
});
