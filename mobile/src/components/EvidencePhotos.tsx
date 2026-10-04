import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { evidenceImageUrl, type ReviewComment, type ReviewEvidence } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { AuthImage } from "./AuthImage";
import { CommentsSection } from "./CommentsSection";

const LOCATION_TEXT: Record<string, string> = {
  VERIFIED: "location verified",
  UNVERIFIED: "location could not be verified",
  FAILED: "location was outside the apartment",
};

interface Props {
  evidence: ReviewEvidence[];
  token: string;
  timezone: string;
  /** Every comment on the task; the ones about the open photo are shown under it. */
  comments: ReviewComment[];
  onComment: (body: string, evidenceId: string) => Promise<void>;
}

/**
 * Submitted photos for a task. Always the metadata-stripped viewer copy, and
 * the image request carries the bearer token (the server refuses anyone else).
 * "Fingerprint" is the start of the photo's SHA-256, for matching against the
 * audit record; it shows the file is unchanged, not that it is truthful.
 */
export function EvidencePhotos({ evidence, token, timezone, comments, onComment }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (evidence.length === 0) return null;
  const open = evidence.find((e) => e.id === openId);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {evidence.length === 1 ? "Photo" : `${evidence.length} photos`} (tap to enlarge)
      </Text>
      <View style={styles.row}>
        {evidence.map((e, i) => (
          <Pressable
            key={e.id}
            accessibilityRole="button"
            accessibilityLabel={`${openId === e.id ? "Hide" : "Show"} photo ${i + 1} of ${evidence.length}`}
            onPress={() => setOpenId(openId === e.id ? null : e.id)}
            style={[styles.thumbWrap, openId === e.id && styles.thumbSelected]}
          >
            <AuthImage uri={evidenceImageUrl(e.id)} token={token} style={styles.thumb} resizeMode="cover" accessibilityLabel={`Photo ${i + 1}`} />
          </Pressable>
        ))}
      </View>

      {open && (
        <View style={styles.large}>
          <AuthImage uri={evidenceImageUrl(open.id)} token={token} style={styles.largeImage} resizeMode="contain" accessibilityLabel="Enlarged photo" />
          <Text style={styles.caption}>
            Accepted {formatDateTime(open.uploadAcceptedAtServer, timezone)}
            {open.locationVerification ? ` · ${LOCATION_TEXT[open.locationVerification] ?? open.locationVerification}` : ""}
            {` · fingerprint ${open.contentHashShort}`}
          </Text>
          <CommentsSection
            title="Comments on this photo"
            comments={comments.filter((c) => c.evidenceId === open.id)}
            timezone={timezone}
            addLabel="Add a comment on this photo"
            onAdd={(body) => onComment(body, open.id)}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600", color: "#333" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  thumbWrap: { borderWidth: 2, borderColor: "#c8c8c8", borderRadius: 8, overflow: "hidden" },
  thumbSelected: { borderColor: "#0b5fff" },
  thumb: { width: 96, height: 72, backgroundColor: "#e6e6e6" },
  large: { gap: 6 },
  largeImage: { width: "100%", height: 280, backgroundColor: "#111", borderRadius: 8 },
  caption: { fontSize: 14, color: "#333" },
});
