import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import {
  addShoppingItem,
  ApiError,
  dismissShoppingItem,
  getMe,
  getShopping,
  markShoppingPurchased,
  updateShoppingItem,
  type ShoppingItem,
} from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { HomeBar } from "@/components/HomeBar";
import { Chip } from "@/components/Chip";

type Level = "NEEDED" | "LOW" | "OUT";
const LEVEL_LABEL: Record<string, string> = { NEEDED: "Needed", LOW: "Running low", OUT: "Out" };
const LEVELS: Level[] = ["NEEDED", "LOW", "OUT"];

function origin(i: ShoppingItem): string {
  switch (i.source) {
    case "IP_REPORT":
      return `Reported by ${i.addedBy ?? "the IP"}`;
    case "DISPOSAL":
      return i.note ?? "Added after something was thrown away";
    default:
      return `Added by ${i.addedBy ?? "someone"}`;
  }
}

export default function ShoppingScreen() {
  const { token, user, signOut } = useAuth();
  const staff = user?.role === "CLIENT" || user?.role === "ADMIN";
  const [timezone, setTimezone] = useState<string | null>(null);
  const [open, setOpen] = useState<ShoppingItem[] | null>(null);
  const [recent, setRecent] = useState<ShoppingItem[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [where, setWhere] = useState("");
  const [level, setLevel] = useState<Level>("NEEDED");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [eQuantity, setEQuantity] = useState("");
  const [eWhere, setEWhere] = useState("");
  const [eLevel, setELevel] = useState<Level>("NEEDED");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !staff) return;
    (async () => {
      try {
        setTimezone((await getMe(token)).household.timezone);
      } catch {
        setTimezone("America/Chicago");
      }
    })();
  }, [token, staff]);

  const load = useCallback(async () => {
    if (!token || !staff) return;
    try {
      const result = await getShopping(token);
      setOpen(result.open);
      setRecent(result.recent);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the shopping list.");
    }
  }, [token, staff]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Items the IP reports show up without a refresh.
  useEffect(() => {
    const timer = setInterval(() => {
      load();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  if (user && !staff) return <Redirect href="/" />;

  if (!open || !timezone) {
    return (
      <View style={styles.center}>
        {loadError ? <Text style={styles.error}>{loadError}</Text> : <ActivityIndicator size="large" accessibilityLabel="Loading the shopping list" />}
      </View>
    );
  }

  async function add() {
    setFormBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await addShoppingItem(token!, { name: name.trim(), quantity: quantity.trim() || undefined, storageLocation: where.trim() || undefined, status: level });
      setNotice(result.merged ? "That was already on the list, so it was updated." : "Added to the list.");
      setName("");
      setQuantity("");
      setWhere("");
      setLevel("NEEDED");
      setAdding(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not add it. Check your connection and try again.");
    } finally {
      setFormBusy(false);
    }
  }

  async function rowAction(id: string, action: () => Promise<unknown>) {
    setRowBusy(id);
    setRowError(null);
    try {
      await action();
      setEditing(null);
      setConfirmRemove(null);
      await load();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "That did not go through. Try again.");
      await load();
    } finally {
      setRowBusy(null);
    }
  }

  function startEdit(i: ShoppingItem) {
    setEditing(i.id);
    setEQuantity(i.quantity ?? "");
    setEWhere(i.storageLocation ?? "");
    setELevel(i.status as Level);
    setRowError(null);
  }

  return (
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
      <Text style={styles.title} accessibilityRole="header">
        Shopping list
      </Text>
      <Text style={styles.help}>Things the household needs. The IP can report what is running low, and it appears here by itself. The IP is not asked to do the shopping.</Text>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}
      {notice && (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      )}

      {adding ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            Add an item
          </Text>
          <Text style={styles.label}>Item</Text>
          <TextInput style={styles.input} accessibilityLabel="Item" value={name} onChangeText={setName} editable={!formBusy} />
          <Text style={styles.label}>How much (optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="How much" placeholder="For example: 2 dozen" value={quantity} onChangeText={setQuantity} editable={!formBusy} />
          <Text style={styles.label}>Where it is kept (optional)</Text>
          <TextInput style={styles.input} accessibilityLabel="Where it is kept" value={where} onChangeText={setWhere} editable={!formBusy} />
          <Text style={styles.label}>How urgent</Text>
          <View style={styles.row} accessibilityRole="radiogroup">
            {LEVELS.map((l) => (
              <Chip key={l} label={LEVEL_LABEL[l]!} selected={level === l} onPress={() => setLevel(l)} disabled={formBusy} />
            ))}
          </View>
          {formError && (
            <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">
              {formError}
            </Text>
          )}
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Add to the list" onPress={add} disabled={formBusy || !name.trim()} style={[styles.primary, (formBusy || !name.trim()) && styles.disabled]}>
              {formBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Add to the list</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setAdding(false)} disabled={formBusy} style={styles.outline}>
              <Text style={styles.outlineText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Add an item to the shopping list" onPress={() => { setAdding(true); setNotice(null); }} style={styles.addButton}>
          <Text style={styles.addText}>+ Add an item</Text>
        </Pressable>
      )}

      <Text style={styles.section} accessibilityRole="header">
        To buy ({open.length})
      </Text>
      {open.length === 0 && <Text style={styles.empty}>Nothing on the list.</Text>}
      {open.map((i) => (
        <View key={i.id} style={[styles.card, i.status === "OUT" && styles.cardOut]}>
          <View style={styles.titleRow}>
            <Text style={styles.cardTitle}>{i.name}</Text>
            <Text style={[styles.badge, i.status === "OUT" && styles.badgeOut]}>{LEVEL_LABEL[i.status]}</Text>
          </View>
          {(i.quantity || i.storageLocation) && (
            <Text style={styles.line}>
              {i.quantity ? `Amount: ${i.quantity}` : ""}
              {i.quantity && i.storageLocation ? ". " : ""}
              {i.storageLocation ? `Kept: ${i.storageLocation}` : ""}
            </Text>
          )}
          <Text style={styles.meta}>
            {origin(i)} · {formatDateTime(i.addedAt, timezone)}
            {i.reportCount > 1 ? ` · mentioned ${i.reportCount} times` : ""}
          </Text>
          {i.note && i.source !== "DISPOSAL" && <Text style={styles.meta}>Note: {i.note}</Text>}

          {rowError && (editing === i.id || confirmRemove === i.id) && (
            <Text style={styles.error} role="alert">
              {rowError}
            </Text>
          )}

          {editing === i.id ? (
            <View style={styles.form}>
              <Text style={styles.label}>How much</Text>
              <TextInput style={styles.input} accessibilityLabel={`How much ${i.name}`} value={eQuantity} onChangeText={setEQuantity} editable={rowBusy !== i.id} />
              <Text style={styles.label}>Where it is kept</Text>
              <TextInput style={styles.input} accessibilityLabel={`Where ${i.name} is kept`} value={eWhere} onChangeText={setEWhere} editable={rowBusy !== i.id} />
              <View style={styles.row} accessibilityRole="radiogroup">
                {LEVELS.map((l) => (
                  <Chip key={l} label={LEVEL_LABEL[l]!} selected={eLevel === l} onPress={() => setELevel(l)} disabled={rowBusy === i.id} />
                ))}
              </View>
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Save changes to ${i.name}`}
                  onPress={() => rowAction(i.id, () => updateShoppingItem(token!, i.id, { quantity: eQuantity.trim() || null, storageLocation: eWhere.trim() || null, status: eLevel }))}
                  disabled={rowBusy === i.id}
                  style={styles.primary}
                >
                  <Text style={styles.primaryText}>Save</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setEditing(null)} style={styles.outline}>
                  <Text style={styles.outlineText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : confirmRemove === i.id ? (
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Yes, remove ${i.name}`} onPress={() => rowAction(i.id, () => dismissShoppingItem(token!, i.id))} disabled={rowBusy === i.id} style={styles.danger}>
                <Text style={styles.dangerText}>Yes, remove it</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Keep it on the list" onPress={() => setConfirmRemove(null)} style={styles.outline}>
                <Text style={styles.outlineText}>Keep it</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel={`${i.name} was bought or restocked`} onPress={() => rowAction(i.id, () => markShoppingPurchased(token!, i.id))} disabled={rowBusy === i.id} style={[styles.primary, rowBusy === i.id && styles.disabled]}>
                {rowBusy === i.id ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Bought / restocked</Text>}
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${i.name}`} onPress={() => startEdit(i)} style={styles.outline}>
                <Text style={styles.outlineText}>Edit</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${i.name} from the list`} onPress={() => { setConfirmRemove(i.id); setRowError(null); }} style={styles.dangerOutline}>
                <Text style={styles.dangerOutlineText}>Remove</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}

      {recent.length > 0 && (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showRecent }} accessibilityLabel={`${showRecent ? "Hide" : "Show"} the last 30 days of bought and removed items`} onPress={() => setShowRecent(!showRecent)} style={styles.linkButton}>
            <Text style={styles.link}>
              {showRecent ? "Hide" : "Show"} bought and removed in the last 30 days ({recent.length})
            </Text>
          </Pressable>
          {showRecent &&
            recent.map((i) => (
              <View key={i.id} style={[styles.card, styles.dim]}>
                <Text style={styles.cardTitle}>{i.name}</Text>
                <Text style={styles.meta}>
                  {i.status === "PURCHASED" ? "Bought / restocked" : "Removed"} by {i.closedBy ?? "someone"}
                  {i.closedAt ? ` · ${formatDateTime(i.closedAt, timezone)}` : ""}
                </Text>
              </View>
            ))}
        </>
      )}

      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => signOut().then(() => router.replace("/login"))} style={styles.signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20, paddingBottom: 100, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { fontSize: 26, fontWeight: "700" },
  help: { fontSize: 15, color: "#333" },
  section: { fontSize: 20, fontWeight: "700", marginTop: 10 },
  empty: { fontSize: 15, color: "#444" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  notice: { fontSize: 15, fontWeight: "600", color: "#157a3d", backgroundColor: "#eaf6ee", borderRadius: 8, padding: 12 },
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 6 },
  cardOut: { borderWidth: 2, borderColor: "#8a1c1c" },
  dim: { backgroundColor: "#f2f2f2" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: "700", flexShrink: 1 },
  badge: { fontSize: 13, fontWeight: "700", borderWidth: 2, borderColor: "#8a5a00", color: "#8a5a00", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  badgeOut: { borderColor: "#8a1c1c", color: "#8a1c1c" },
  line: { fontSize: 15, color: "#111" },
  meta: { fontSize: 14, color: "#444" },
  label: { fontSize: 14, fontWeight: "600", marginTop: 4 },
  input: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, padding: 12, fontSize: 17, minHeight: 48, backgroundColor: "#fff" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  form: { gap: 8 },
  addButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  addText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  primary: { backgroundColor: "#157a3d", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: "center", alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  outline: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 15, fontWeight: "700" },
  danger: { backgroundColor: "#8a1c1c", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  dangerText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  dangerOutline: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  dangerOutlineText: { color: "#8a1c1c", fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  linkButton: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  link: { color: "#0b5fff", fontSize: 15, fontWeight: "600", textDecorationLine: "underline" },
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
