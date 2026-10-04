import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { ApiError, createTemplate, listTemplates, updateTemplate, type TemplateDto, type TemplateFields } from "@/lib/api";
import { HomeBar } from "@/components/HomeBar";
import { Chip } from "@/components/Chip";
import { FREQUENCY_LABELS, TemplateForm } from "@/components/TemplateForm";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;

export default function TemplatesScreen() {
  const { token, user, signOut } = useAuth();
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || user?.role === "IP" || user?.role === "FAMILY") return;
    try {
      const result = await listTemplates(token);
      setTemplates(result.templates);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load task templates.");
    }
  }, [token, user?.role]);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  const visible = useMemo(() => templates.filter((t) => showInactive || t.active), [templates, showInactive]);
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const t of visible) if (!order.includes(t.groupName)) order.push(t.groupName);
    return order;
  }, [visible]);
  const allGroups = useMemo(() => [...new Set(templates.map((t) => t.groupName))], [templates]);
  const nextSortOrder = useMemo(() => templates.reduce((max, t) => Math.max(max, t.sortOrder), 0) + 1, [templates]);
  const inactiveCount = templates.filter((t) => !t.active).length;

  if (user && (user.role === "IP" || user.role === "FAMILY")) return <Redirect href={user.role === "IP" ? "/home" : "/review"} />;

  async function run(action: () => Promise<unknown>) {
    if (!token) return;
    setBusy(true);
    setFormError(null);
    try {
      await action();
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const onCreate = (value: TemplateFields) => run(() => createTemplate(token!, value));
  const onEdit = (id: string, value: TemplateFields) => run(() => updateTemplate(token!, id, value));
  const onToggleActive = (t: TemplateDto) => run(() => updateTemplate(token!, t.id, { active: !t.active }));

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" accessibilityLabel="Loading task templates" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <HomeBar />

      <Text style={styles.title} accessibilityRole="header">
        Task templates
      </Text>
      <Text style={styles.help}>
        These are the tasks assigned to the IP. Changes apply to future shifts only. Tasks already assigned keep their original wording, and every change is recorded.
      </Text>

      {loadError && (
        <Text style={styles.error} role="alert">
          {loadError}
        </Text>
      )}

      {editing?.kind === "new" ? (
        <View style={styles.card}>
          <TemplateForm
            heading="New task"
            groups={allGroups}
            sortOrder={nextSortOrder}
            busy={busy}
            error={formError}
            onSubmit={onCreate}
            onCancel={() => {
              setEditing(null);
              setFormError(null);
            }}
          />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a new task"
          onPress={() => {
            setEditing({ kind: "new" });
            setFormError(null);
          }}
          style={styles.addButton}
        >
          <Text style={styles.addText}>+ Add a task</Text>
        </Pressable>
      )}

      {inactiveCount > 0 && (
        <View style={styles.row} accessibilityRole="radiogroup">
          <Chip label="Active only" selected={!showInactive} onPress={() => setShowInactive(false)} />
          <Chip label={`Include ${inactiveCount} inactive`} selected={showInactive} onPress={() => setShowInactive(true)} />
        </View>
      )}

      {groups.map((group) => (
        <View key={group} style={styles.group}>
          <Text style={styles.groupName} accessibilityRole="header">
            {group}
          </Text>
          {visible
            .filter((t) => t.groupName === group)
            .map((t) => {
              const isEditing = editing?.kind === "edit" && editing.id === t.id;
              return (
                <View key={t.id} style={[styles.card, !t.active && styles.inactive]}>
                  {isEditing ? (
                    <TemplateForm
                      heading={`Edit: ${t.title}`}
                      initial={t}
                      groups={allGroups}
                      sortOrder={t.sortOrder}
                      busy={busy}
                      error={formError}
                      onSubmit={(v) => onEdit(t.id, v)}
                      onCancel={() => {
                        setEditing(null);
                        setFormError(null);
                      }}
                    />
                  ) : (
                    <>
                      <Text style={styles.taskTitle}>{t.title}</Text>
                      <Text style={styles.badges}>
                        {FREQUENCY_LABELS[t.frequency]}
                        {t.requiresPhoto ? "  •  Photo required" : ""}
                        {!t.active ? "  •  Inactive" : ""}
                      </Text>
                      <Text style={styles.instructions}>{t.instructions}</Text>
                      <View style={styles.row}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Edit ${t.title}`}
                          onPress={() => {
                            setEditing({ kind: "edit", id: t.id });
                            setFormError(null);
                          }}
                          style={styles.outlineButton}
                        >
                          <Text style={styles.outlineText}>Edit</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${t.active ? "Deactivate" : "Reactivate"} ${t.title}`}
                          onPress={() => onToggleActive(t)}
                          disabled={busy}
                          style={t.active ? styles.dangerOutline : styles.outlineButton}
                        >
                          <Text style={t.active ? styles.dangerOutlineText : styles.outlineText}>{t.active ? "Deactivate" : "Reactivate"}</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
        </View>
      ))}

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
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  group: { gap: 8, marginTop: 8 },
  groupName: { fontSize: 20, fontWeight: "700" },
  card: { borderWidth: 1, borderColor: "#c8c8c8", borderRadius: 10, padding: 14, gap: 6 },
  inactive: { backgroundColor: "#f2f2f2", opacity: 0.85 },
  taskTitle: { fontSize: 17, fontWeight: "700" },
  badges: { fontSize: 14, fontWeight: "600", color: "#0b5fff" },
  instructions: { fontSize: 15, color: "#333" },
  addButton: { borderWidth: 2, borderColor: "#0b5fff", borderRadius: 8, paddingVertical: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  addText: { color: "#0b5fff", fontSize: 17, fontWeight: "700" },
  outlineButton: { borderWidth: 2, borderColor: "#1a1a1a", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },
  outlineText: { fontSize: 16, fontWeight: "700" },
  dangerOutline: { borderWidth: 2, borderColor: "#8a1c1c", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20, minHeight: 44, justifyContent: "center" },
  dangerOutlineText: { color: "#8a1c1c", fontSize: 16, fontWeight: "700" },
  error: { color: "#b00020", fontSize: 15, fontWeight: "600" },
  signOut: { marginTop: 24, alignItems: "center", minHeight: 44, justifyContent: "center" },
  signOutText: { color: "#555", fontSize: 15 },
});
