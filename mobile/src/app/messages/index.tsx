import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { UrgentBanner } from "@/components/UrgentBanner";
import { ApiError, getChatPeople, getConversations, startDirect, type ChatPerson, type ConversationSummary } from "@/lib/api";

const POLL_MS = 8000;

export default function MessagesScreen() {
  const { token } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setConversations((await getConversations(token)).conversations);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your messages.");
    }
  }, [token]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function openPicker() {
    setPicking(true);
    if (!people && token) {
      try {
        setPeople((await getChatPeople(token)).people);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the list of people.");
      }
    }
  }

  async function message(person: ChatPerson) {
    if (!token) return;
    try {
      const { id } = await startDirect(token, person.id);
      setPicking(false);
      router.push({ pathname: "/messages/[id]", params: { id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start that conversation.");
    }
  }

  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading messages" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
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
      <UrgentBanner />
      <View style={styles.headerRow}>
        <Text style={styles.title} accessibilityRole="header">
          Messages
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close messages" onPress={close} style={styles.outline}>
          <Text style={styles.outlineText}>Close</Text>
        </Pressable>
      </View>

      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}

      {picking ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            Send a private message to
          </Text>
          {!people && <ActivityIndicator accessibilityLabel="Loading people" />}
          {people?.length === 0 && <Text style={styles.sub}>There is nobody else to message yet.</Text>}
          {people?.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Message ${p.name}, ${p.roleLabel}`} onPress={() => message(p)} style={styles.person}>
              <Text style={styles.personName}>{p.name}</Text>
              <Text style={styles.sub}>{p.roleLabel}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setPicking(false)} style={styles.outline}>
            <Text style={styles.outlineText}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Send a new private message" onPress={openPicker} style={styles.newButton}>
          <Text style={styles.newText}>+ New private message</Text>
        </Pressable>
      )}

      {conversations.map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          accessibilityLabel={`${c.title}${c.unread ? `, ${c.unread} new` : ""}`}
          onPress={() => router.push({ pathname: "/messages/[id]", params: { id: c.id } })}
          style={[styles.row, c.unread > 0 && styles.rowUnread]}
        >
          <View style={styles.rowTop}>
            <Text style={styles.rowTitle}>{c.title}</Text>
            {c.unread > 0 && <Text style={styles.badge}>{c.unread} new</Text>}
          </View>
          {c.subtitle && <Text style={styles.sub}>{c.subtitle}</Text>}
          <Text style={styles.preview} numberOfLines={1}>
            {c.lastMessage ? `${c.lastMessage.senderName}: ${c.lastMessage.body}` : "No messages yet"}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 60, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 26, fontWeight: "700" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  newButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  newText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: "700" },
  person: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 8, padding: 12, minHeight: 56, justifyContent: "center" },
  personName: { fontSize: 17, fontWeight: "700" },
  sub: { fontSize: 14, color: "#444" },
  row: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 4, minHeight: 72 },
  rowUnread: { borderWidth: 2, borderColor: "#0b5fff" },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  rowTitle: { fontSize: 18, fontWeight: "700", flexShrink: 1 },
  badge: { backgroundColor: "#0b5fff", color: "#fff", fontSize: 13, fontWeight: "700", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, overflow: "hidden" },
  preview: { fontSize: 15, color: "#222" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 15, fontWeight: "700" },
});
