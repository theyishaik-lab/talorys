import type { Note, Project, Task } from "@talorys/shared";
import * as Haptics from "expo-haptics";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, CheckCircle2, Circle, Ellipsis, Pencil, Plus, StickyNote, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatScreen } from "../../components/ChatScreen";
import { ActionSheet, PromptDialog } from "../../components/Sheets";
import { Card, Icon, IconButton, Press, T, useFont } from "../../components/ui";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { deleteProject, loadProject, updateProject } from "../../lib/projects";
import { radii, useTheme } from "../../lib/theme";
import { projectThreadId } from "../../lib/threads";

type Tab = "chat" | "tasks" | "notes";

/** One project: its own chat (thread project-<id>, whose context is the project's tasks and notes), tasks and notes. */
export default function ProjectScreen() {
  const { id, tab: initialTab } = useLocalSearchParams<{ id: string; tab?: Tab }>();
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>(initialTab === "tasks" || initialTab === "notes" ? initialTab : "chat");
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [missing, setMissing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await loadProject(id);
      setProject(r.project);
      setTasks(r.tasks);
      setNotes(r.notes);
    } catch (e) {
      if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) setMissing(true);
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      Promise.resolve().then(reload);
    }, [reload]),
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace("/projects"));
  const remove = () =>
    project &&
    Alert.alert(t("projects.delete"), t("projects.deleteConfirm", { name: project.name }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => { await deleteProject(project.id).catch(() => {}); back(); } },
    ]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "chat", label: t("projects.tab.chat") },
    { key: "tasks", label: `${t("projects.tab.tasks")}${tasks.filter((x) => x.status !== "done").length ? ` · ${tasks.filter((x) => x.status !== "done").length}` : ""}` },
    { key: "notes", label: `${t("projects.tab.notes")}${notes.length ? ` · ${notes.length}` : ""}` },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 4 }}>
        <IconButton icon={rtl ? ArrowRight : ArrowLeft} onPress={back} label={t("settings.back")} />
        <T weight="semibold" size={17} style={{ flex: 1 }} numberOfLines={1}>
          {project?.name ?? ""}
        </T>
        {project ? <IconButton icon={Ellipsis} onPress={() => setMenu(true)} label={t("projects.rename")} /> : null}
      </View>
      {missing ? (
        <T muted center style={{ padding: 32 }}>
          {t("projects.notFound")}
        </T>
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingBottom: 8 }}>
            {tabs.map((x) => (
              <Press key={x.key} onPress={() => setTab(x.key)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: tab === x.key ? c.fg : c.surface }}>
                <T size={13} weight="medium" color={tab === x.key ? c.bg : c.fg}>
                  {x.label}
                </T>
              </Press>
            ))}
          </View>
          {tab === "chat" ? (
            <ChatScreen
              conversationId={projectThreadId(id)}
              variant="embedded"
              empty={
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
                  <T muted center>
                    {t("projects.chatEmpty")}
                  </T>
                </View>
              }
            />
          ) : tab === "tasks" ? (
            <TasksPane projectId={id} tasks={tasks} reload={reload} />
          ) : (
            <NotesPane projectId={id} notes={notes} reload={reload} />
          )}
        </>
      )}
      <PromptDialog
        visible={renaming}
        title={t("projects.rename")}
        label={t("projects.name")}
        initial={project?.name ?? ""}
        secondLabel={t("projects.description")}
        secondInitial={project?.description ?? ""}
        confirm={t("common.save")}
        onClose={() => setRenaming(false)}
        onConfirm={async (name, description) => {
          await updateProject(id, { name, description });
          await reload();
        }}
      />
      <ActionSheet
        visible={menu}
        title={project?.name}
        onClose={() => setMenu(false)}
        actions={
          project
            ? [
                { label: t("projects.rename"), icon: Pencil, onPress: () => setRenaming(true) },
                project.status === "archived"
                  ? { label: t("projects.unarchive"), icon: ArchiveRestore, onPress: async () => { await updateProject(id, { status: "active" }).catch(() => {}); reload(); } }
                  : { label: t("projects.archive"), icon: Archive, onPress: async () => { await updateProject(id, { status: "archived" }).catch(() => {}); reload(); } },
                { label: t("projects.delete"), icon: Trash2, danger: true, onPress: remove },
              ]
            : []
        }
      />
    </View>
  );
}

function TasksPane({ projectId, tasks, reload }: { projectId: string; tasks: Task[]; reload: () => Promise<void> }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const add = async () => {
    const v = title.trim();
    if (!v) return;
    setTitle("");
    await api("/tasks", { method: "POST", body: { title: v, project_id: projectId } }).catch(() => {});
    reload();
  };
  const toggle = async (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "done" ? "todo" : "done" } }).catch(() => {});
    reload();
  };
  const remove = (task: Task) =>
    Alert.alert(t("m.deleteConfirm", { title: task.title }), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => { await api(`/tasks/${task.id}`, { method: "DELETE" }).catch(() => {}); reload(); } },
    ]);
  const ordered = [...tasks.filter((x) => x.status !== "done"), ...tasks.filter((x) => x.status === "done")];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 8, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 12 }}>
        <Icon icon={Plus} size={18} color={c.fgMuted} />
        <TextInput value={title} onChangeText={setTitle} onSubmitEditing={add} returnKeyType="done" placeholder={t("projects.addTask")} placeholderTextColor={c.fgFaint} maxLength={300} style={{ flex: 1, fontFamily: font, fontSize: 15, color: c.fg, paddingVertical: 12, textAlign: rtl ? "right" : "left" }} />
      </View>
      {ordered.length === 0 ? (
        <T muted center style={{ paddingTop: 32 }}>
          {t("projects.noTasks")}
        </T>
      ) : (
        ordered.map((task) => {
          const done = task.status === "done";
          return (
            <Card key={task.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Press onPress={() => toggle(task)} hitSlop={8} accessibilityLabel={done ? t("m.tasks.reopen") : t("m.tasks.markDone")}>
                <Icon icon={done ? CheckCircle2 : Circle} size={22} color={done ? c.success : c.fgMuted} />
              </Press>
              <Press onLongPress={() => remove(task)} style={{ flex: 1, gap: 2 }}>
                <T style={{ textDecorationLine: done ? "line-through" : "none" }} color={done ? c.fgMuted : c.fg}>
                  {task.title}
                </T>
                {task.due_at ? (
                  <T size={12} muted>
                    {new Date(task.due_at).toLocaleString()}
                  </T>
                ) : null}
              </Press>
              <Press onPress={() => remove(task)} hitSlop={8} accessibilityLabel={t("common.delete")}>
                <Icon icon={Trash2} size={16} color={c.fgFaint} />
              </Press>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

function NotesPane({ projectId, notes, reload }: { projectId: string; notes: Note[]; reload: () => Promise<void> }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const current = editing && editing !== "new" ? editing : null;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 8, paddingBottom: insets.bottom + 24 }}>
      <Press onPress={() => setEditing("new")} haptic style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
        <Icon icon={Plus} size={16} />
        <T size={14}>{t("projects.addNote")}</T>
      </Press>
      {notes.length === 0 ? (
        <T muted center style={{ paddingTop: 32 }}>
          {t("projects.noNotes")}
        </T>
      ) : (
        notes.map((note) => (
          <Press key={note.id} onPress={() => setEditing(note)} onLongPress={() =>
            Alert.alert(t("m.deleteConfirm", { title: note.title }), undefined, [
              { text: t("common.cancel"), style: "cancel" },
              { text: t("common.delete"), style: "destructive", onPress: async () => { await api(`/notes/${note.id}`, { method: "DELETE" }).catch(() => {}); reload(); } },
            ])
          } scale={0.99}>
            <Card style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Icon icon={StickyNote} size={16} color={c.fgMuted} />
                <T weight="medium" numberOfLines={1} style={{ flex: 1 }}>
                  {note.title}
                </T>
              </View>
              {note.content ? (
                <T size={13} muted numberOfLines={4}>
                  {note.content}
                </T>
              ) : null}
            </Card>
          </Press>
        ))
      )}
      <PromptDialog
        visible={editing !== null}
        title={current ? current.title : t("projects.addNote")}
        label={t("projects.noteTitle")}
        initial={current?.title ?? ""}
        secondLabel={t("projects.noteContent")}
        secondInitial={current?.content ?? ""}
        secondMax={200_000}
        confirm={t("common.save")}
        onClose={() => setEditing(null)}
        onConfirm={async (title, content) => {
          if (current) await api(`/notes/${current.id}`, { method: "PATCH", body: { title, content } });
          else await api("/notes", { method: "POST", body: { title, content, project_id: projectId } });
          await reload();
        }}
      />
    </ScrollView>
  );
}
