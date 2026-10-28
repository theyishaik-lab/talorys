import { router, useFocusEffect } from "expo-router";
import { Archive, ArchiveRestore, ChevronDown, ChevronLeft, ChevronRight, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, PromptDialog } from "../../components/Sheets";
import { Icon, IconButton, Press, T } from "../../components/ui";
import { useI18n } from "../../lib/i18n";
import { type ProjectRow, createProject, deleteProject, loadProjects, updateProject } from "../../lib/projects";
import { radii, useTheme } from "../../lib/theme";

/** Projects: each one is its own chat (it knows the project's tasks and notes) plus tasks and notes. */
export default function ProjectsTab() {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<ProjectRow | null>(null);
  const [renaming, setRenaming] = useState<ProjectRow | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems(await loadProjects());
      setError(false);
    } catch {
      setError(true);
      setItems((p) => p ?? []);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      Promise.resolve().then(reload);
    }, [reload]),
  );

  const active = (items ?? []).filter((p) => p.status !== "archived");
  const archived = (items ?? []).filter((p) => p.status === "archived");
  const open = (p: ProjectRow) => router.push({ pathname: "/projects/[id]", params: { id: p.id } });
  const remove = (p: ProjectRow) =>
    Alert.alert(t("projects.delete"), t("projects.deleteConfirm", { name: p.name }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => { await deleteProject(p.id).catch(() => {}); reload(); } },
    ]);

  const row = (p: ProjectRow, last: boolean) => (
    <Press key={p.id} onPress={() => open(p)} onLongPress={() => setMenu(p)} delayLongPress={350} scale={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: p.status === "archived" ? c.surface2 : c.accentSoft, alignItems: "center", justifyContent: "center" }}>
        <Icon icon={FolderKanban} size={18} color={p.status === "archived" ? c.fgMuted : c.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="medium" numberOfLines={1}>
          {p.name}
        </T>
        <T size={12} muted numberOfLines={1}>
          {[t(`projects.status.${p.status}` as "projects.status.active"), t("projects.openTasks", { count: p.openTasks }), p.description].filter(Boolean).join(" · ")}
        </T>
      </View>
      <Icon icon={rtl ? ChevronLeft : ChevronRight} size={18} color={c.fgFaint} />
    </Press>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 16 }}>
        <T weight="semibold" size={22} style={{ flex: 1 }}>
          {t("projects.title")}
        </T>
        <IconButton icon={Plus} onPress={() => setCreating(true)} label={t("projects.new")} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 8, gap: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={c.fgMuted} onRefresh={async () => { setRefreshing(true); await reload(); setRefreshing(false); }} />}
      >
        {items === null ? null : active.length === 0 ? (
          <View style={{ alignItems: "center", gap: 12, paddingTop: 48, paddingHorizontal: 24 }}>
            <Icon icon={FolderKanban} size={36} color={c.fgFaint} />
            <T muted center>
              {error ? t("home.loadFailed") : t("projects.empty")}
            </T>
            <Press onPress={() => setCreating(true)} haptic style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: c.fg }}>
              <Icon icon={Plus} size={16} color={c.bg} />
              <T size={14} weight="medium" color={c.bg}>
                {t("projects.new")}
              </T>
            </Press>
          </View>
        ) : (
          <View style={{ backgroundColor: c.surface, borderRadius: radii.lg, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{active.map((p, i) => row(p, i === active.length - 1))}</View>
        )}
        {archived.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Press onPress={() => setShowArchived((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingVertical: 6 }}>
              <Icon icon={showArchived ? ChevronDown : rtl ? ChevronLeft : ChevronRight} size={16} color={c.fgMuted} />
              <T size={12} weight="medium" muted style={{ textTransform: "uppercase", letterSpacing: 0.6 }}>
                {t("projects.archived")} ({archived.length})
              </T>
            </Press>
            {showArchived ? (
              <View style={{ backgroundColor: c.surface, borderRadius: radii.lg, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{archived.map((p, i) => row(p, i === archived.length - 1))}</View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <PromptDialog
        visible={creating}
        title={t("projects.new")}
        label={t("projects.name")}
        secondLabel={t("projects.description")}
        confirm={t("projects.create")}
        onClose={() => setCreating(false)}
        onConfirm={async (name, description) => {
          const { project } = await createProject(name, description);
          await reload();
          router.push({ pathname: "/projects/[id]", params: { id: project.id } });
        }}
      />
      <PromptDialog
        visible={!!renaming}
        title={t("projects.rename")}
        label={t("projects.name")}
        initial={renaming?.name ?? ""}
        confirm={t("common.save")}
        onClose={() => setRenaming(null)}
        onConfirm={async (name) => {
          if (renaming) await updateProject(renaming.id, { name });
          await reload();
        }}
      />
      <ActionSheet
        visible={!!menu}
        title={menu?.name}
        onClose={() => setMenu(null)}
        actions={
          menu
            ? [
                { label: t("projects.rename"), icon: Pencil, onPress: () => setRenaming(menu) },
                menu.status === "archived"
                  ? { label: t("projects.unarchive"), icon: ArchiveRestore, onPress: async () => { await updateProject(menu.id, { status: "active" }).catch(() => {}); reload(); } }
                  : { label: t("projects.archive"), icon: Archive, onPress: async () => { await updateProject(menu.id, { status: "archived" }).catch(() => {}); reload(); } },
                { label: t("projects.delete"), icon: Trash2, danger: true, onPress: () => remove(menu) },
              ]
            : []
        }
      />
    </View>
  );
}
