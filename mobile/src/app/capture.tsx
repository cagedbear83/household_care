import { useCallback, useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, requestEvidenceChallenge, uploadEvidence } from "@/lib/api";
import { getVerifiedCoords } from "@/lib/location";
import { CameraCapture, type CapturedPhoto } from "@/components/CameraCapture";

/** The task photo (for example, the clean sink): take it in the app, then it is sent against the ticket the server issued for this task. */
export default function CaptureScreen() {
  const { token } = useAuth();
  const { taskId, title } = useLocalSearchParams<{ taskId: string; title?: string }>();

  const [challengeId, setChallengeId] = useState<string | null>(null);
  // Bumped to start the camera over (a new ticket needs a new photo).
  const [attempt, setAttempt] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const obtainChallenge = useCallback(async () => {
    if (!token || !taskId) return;
    try {
      const result = await requestEvidenceChallenge(token, taskId);
      setChallengeId(result.challengeId);
      setError(null);
    } catch (err) {
      setChallengeId(null);
      setError(err instanceof ApiError ? err.message : "Could not start the camera. Check your connection and try again.");
    }
  }, [token, taskId]);

  useEffect(() => {
    (async () => {
      await obtainChallenge();
    })();
  }, [obtainChallenge]);

  async function usePhoto(photo: CapturedPhoto) {
    if (!token || !taskId || !challengeId) return;
    setUploading(true);
    setError(null);
    try {
      // A fresh location fix is recorded with the photo. If it fails, the
      // photo is still sent and the server records the location as unverified.
      let coords: Awaited<ReturnType<typeof getVerifiedCoords>> | null = null;
      try {
        coords = await getVerifiedCoords();
      } catch {
        coords = null;
      }
      await uploadEvidence(token, taskId, {
        challengeId,
        imageBase64: photo.base64,
        capturedAtDevice: photo.at,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        accuracyMeters: coords?.accuracyMeters ?? null,
      });
      router.back();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHALLENGE_INVALID") {
        // The ticket expired or was used: get a new one and ask for a fresh photo.
        setAttempt((n) => n + 1);
        await obtainChallenge();
      }
      setError(err instanceof ApiError ? err.message : "The photo could not be sent. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <CameraCapture
      key={attempt}
      title={title ?? "Take photo"}
      ready={challengeId !== null}
      busy={uploading}
      error={error}
      onUse={usePhoto}
      onCancel={() => router.back()}
    />
  );
}
