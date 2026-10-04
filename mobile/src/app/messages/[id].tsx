import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  getConversations,
  getMe,
  getMessages,
  markConversationRead,
  sendChatMessage,
  type ChatMessage,
  type ConversationSummary,
} from "@/lib/api";
import { formatDay, formatTime, localDateOf } from "@/lib/dates";
import { UrgentBanner } from "@/components/UrgentBanner";

const POLL_MS = 4000;

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const scroller = useRef<ScrollView>(null);

  const [timezone, setTimezone] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesRef = useRef<ChatMessage[]>([]);

  // Fetches anything newer than the last message we have and marks the thread read.
  const refresh = useCallback(async () => {
    if (!token || !id) return;
    try {
      const last = messagesRef.current.at(-1);
      const { messages: fresh } = await getMessages(token, id, last?.id);
      if (fresh.length > 0) {
        messagesRef.current = [...messagesRef.current, ...fresh];
        setMessages(messagesRef.current);
        if (fresh.some((m) => !m.mine)) await markConversationRead(token, id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load new messages.");
    }
  }, [token, id]);

  useEffect(() => {
    if (!token || !id) return;
    (async () => {
      try {
        const [me, convs, first] = await Promise.all([getMe(token), getConversations(token), getMessages(token, id)]);
        setTimezone(me.household.timezone);
        setConversation(convs.conversations.find((c) => c.id === id) ?? null);
        messagesRef.current = first.messages;
        setMessages(first.messages);
        await markConversationRead(token, id);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not open this conversation.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token, id]);

  useEffect(() => {
    const timer = setInterval(() => {
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function send() {
    if (!token || !id || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await sendChatMessage(token, id, text.trim());
      setText("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The message did not send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  const back = () => (router.canGoBack() ? router.back() : router.replace("/messages"));

  if (loading || !timezone) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator size="large" accessibilityLabel="Opening conversation" />}
      </View>
    );
  }

  const isGroup = conversation?.kind === "GROUP";
  const canSend = conversation?.canSend ?? true;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <UrgentBanner />
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to all messages" onPress={back} style={styles.back}>
          <Text style={styles.backText}>‹ All messages</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          {conversation?.title ?? "Conversation"}
        </Text>
        {conversation?.subtitle && <Text style={styles.sub}>{conversation.subtitle}</Text>}
      </View>

      <ScrollView ref={scroller} style={styles.list} contentContainerStyle={styles.listContent} onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}>
        {messages.length === 0 && <Text style={styles.empty}>No messages yet. Say hello.</Text>}
        {messages.map((m, i) => {
          const day = localDateOf(m.at, timezone);
          const showDay = i === 0 || day !== localDateOf(messages[i - 1]!.at, timezone);
          return (
            <View key={m.id}>
              {showDay && <Text style={styles.day}>{formatDay(day)}</Text>}
              <View style={[styles.bubbleRow, m.mine && styles.bubbleRowMine]}>
                <View style={[styles.bubble, m.mine ? styles.bubbleMine : styles.bubbleOther]} accessible accessibilityLabel={`${m.mine ? "You" : m.senderName}, ${formatTime(m.at, timezone)}: ${m.body}`}>
                  {!m.mine && (
                    <Text style={styles.sender}>
                      {m.senderName}
                      {isGroup ? <Text style={styles.senderRole}> · {m.senderRoleLabel}</Text> : null}
                    </Text>
                  )}
                  <Text style={[styles.body, m.mine && styles.bodyMine]}>{m.body}</Text>
                  <Text style={[styles.time, m.mine && styles.timeMine]}>{formatTime(m.at, timezone)}</Text>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
          {error}
        </Text>
      )}

      {canSend ? (
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            accessibilityLabel="Type a message"
            value={text}
            onChangeText={setText}
            placeholder="Type a message"
            multiline
            maxLength={2000}
            editable={!sending}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Send message" onPress={send} disabled={sending || !text.trim()} style={[styles.send, (sending || !text.trim()) && styles.disabled]}>
            {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>Send</Text>}
          </Pressable>
        </View>
      ) : (
        <Text style={styles.empty}>This person can no longer receive messages.</Text>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  header: { padding: 14, gap: 2, borderBottomWidth: 1, borderBottomColor: "#ddd" },
  back: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  backText: { color: "#0b5fff", fontSize: 16, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "700" },
  sub: { fontSize: 14, color: "#444" },
  list: { flex: 1 },
  listContent: { padding: 14, gap: 8 },
  empty: { fontSize: 15, color: "#444", padding: 14 },
  day: { alignSelf: "center", fontSize: 13, fontWeight: "700", color: "#555", marginVertical: 8 },
  bubbleRow: { flexDirection: "row", justifyContent: "flex-start" },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubble: { maxWidth: "82%", borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12, gap: 2 },
  bubbleMine: { backgroundColor: "#0b5fff" },
  bubbleOther: { backgroundColor: "#eceff3" },
  sender: { fontSize: 13, fontWeight: "700", color: "#222" },
  senderRole: { fontWeight: "400", color: "#555" },
  body: { fontSize: 16, color: "#111" },
  bodyMine: { color: "#fff" },
  time: { fontSize: 12, color: "#555", alignSelf: "flex-end" },
  timeMine: { color: "#dbe6ff" },
  error: { color: "#b00020", fontSize: 14, fontWeight: "600", paddingHorizontal: 14 },
  composer: { flexDirection: "row", gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: "#ddd", alignItems: "flex-end" },
  input: { flex: 1, borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48, maxHeight: 120 },
  send: { backgroundColor: "#0b5fff", borderRadius: 10, paddingHorizontal: 20, minHeight: 48, justifyContent: "center" },
  sendText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
});
