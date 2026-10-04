import { useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

export interface CapturedPhoto {
  uri: string;
  base64: string;
  /** When the phone says the photo was taken. A claim, not proof. */
  at: string;
}

interface Props {
  title: string;
  /** False until the server has issued the one-use photo ticket; taking a photo waits for it. */
  ready: boolean;
  /** True while the parent is sending the photo. */
  busy: boolean;
  error: string | null;
  onUse: (photo: CapturedPhoto) => void;
  onCancel: () => void;
  useLabel?: string;
}

/**
 * The in-app camera. There is deliberately no gallery or file picker, so a
 * photo must be taken now, inside the app, against a ticket the server issued.
 * (This reduces reuse of old photos; it cannot prove a photo is truthful.)
 */
export function CameraCapture({ title, ready, busy, error, onUse, onCancel, useLabel = "Use this photo" }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  const [taking, setTaking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function takePhoto() {
    if (!cameraRef.current) return;
    setTaking(true);
    setLocalError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.7, exif: false });
      if (!photo?.base64) throw new Error("no image data");
      setCaptured({ uri: photo.uri, base64: photo.base64, at: new Date().toISOString() });
    } catch {
      setLocalError("The photo could not be taken. Try again.");
    } finally {
      setTaking(false);
    }
  }

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Checking camera permission" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading} accessibilityRole="header">
          Camera access needed
        </Text>
        <Text style={styles.body}>This photo has to be taken inside the app. The camera is used only for required photos.</Text>
        {!permission.canAskAgain && <Text style={styles.body}>Camera access was turned off. Turn it on for this app in your device settings, then come back.</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="Allow camera" onPress={requestPermission} style={styles.primary}>
          <Text style={styles.primaryText}>Allow camera</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={onCancel} style={styles.secondary}>
          <Text style={styles.secondaryText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const shownError = error ?? localError;

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        {title}
      </Text>

      {captured ? (
        <Image source={{ uri: captured.uri }} style={styles.preview} accessibilityLabel="Preview of the photo you just took" resizeMode="contain" />
      ) : (
        <CameraView ref={cameraRef} style={styles.camera} facing="back" onCameraReady={() => setCameraReady(true)} />
      )}

      {shownError && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {shownError}
        </Text>
      )}

      {captured ? (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={useLabel}
            onPress={() => onUse(captured)}
            disabled={busy || !ready}
            style={[styles.primary, (busy || !ready) && styles.disabled]}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{useLabel}</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Retake the photo" onPress={() => setCaptured(null)} disabled={busy} style={styles.secondary}>
            <Text style={styles.secondaryText}>Retake</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            onPress={takePhoto}
            disabled={taking || !cameraReady || !ready}
            style={[styles.primary, (taking || !cameraReady || !ready) && styles.disabled]}
          >
            {taking ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Take photo</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} style={styles.secondary}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {!captured && !ready && !shownError && <Text style={styles.body}>Getting ready…</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  center: { flex: 1, padding: 24, gap: 14, alignItems: "stretch", justifyContent: "center", backgroundColor: "#fff" },
  heading: { fontSize: 22, fontWeight: "700" },
  body: { fontSize: 16, color: "#333" },
  camera: { flex: 1, borderRadius: 12, overflow: "hidden", backgroundColor: "#000" },
  preview: { flex: 1, borderRadius: 12, backgroundColor: "#000" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  primary: { flexGrow: 1, backgroundColor: "#0b5fff", borderRadius: 10, paddingVertical: 16, minHeight: 56, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  secondary: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingVertical: 14, paddingHorizontal: 22, minHeight: 56, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 17, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  error: { color: "#b00020", fontSize: 16, fontWeight: "600" },
});
