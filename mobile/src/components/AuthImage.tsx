import { useEffect, useState } from "react";
import { Image, Platform, StyleSheet, Text, View, type ImageStyle, type StyleProp } from "react-native";

interface Props {
  uri: string;
  token: string;
  style: StyleProp<ImageStyle>;
  resizeMode?: "cover" | "contain";
  accessibilityLabel: string;
}

/**
 * An image that needs the bearer token. Phones can send the header with the
 * image request. A browser's <img> cannot, so on web the bytes are fetched
 * with the header and shown from a temporary in-memory URL (nothing is cached
 * on disk by this component).
 */
export function AuthImage({ uri, token, style, resizeMode = "cover", accessibilityLabel }: Props) {
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(uri, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(String(response.status));
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setWebUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [uri, token]);

  if (failed) {
    return (
      <View style={[styles.fallback, style as object]} accessibilityLabel={accessibilityLabel}>
        <Text style={styles.fallbackText}>Photo could not be loaded</Text>
      </View>
    );
  }

  const source = Platform.OS === "web" ? (webUrl ? { uri: webUrl } : undefined) : { uri, headers: { Authorization: `Bearer ${token}` } };
  if (!source) return <View style={[styles.fallback, style as object]} accessibilityLabel={`${accessibilityLabel}, loading`} />;

  return <Image source={source} style={style} resizeMode={resizeMode} accessibilityLabel={accessibilityLabel} />;
}

const styles = StyleSheet.create({
  fallback: { backgroundColor: "#e6e6e6", alignItems: "center", justifyContent: "center" },
  fallbackText: { fontSize: 12, color: "#444", textAlign: "center" },
});
