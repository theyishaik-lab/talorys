import type { Notification, Suggestion } from "@talorys/shared";
import { router, useFocusEffect } from "expo-router";
import { AlarmClock, Bell, Brain, CheckCircle2, Circle, Link2, ListTodo, Settings, Sparkles, StickyNote, Timer, X } from "lucide-react-native";
import { type ReactNode, useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WeatherCard } from "../../components/WeatherCard";
import { Button, Icon, IconButton, Press, T } from "../../components/ui";
import { api } from "../../lib/api";
import { type UpcomingItem, loadNotifications, loadSuggestions, loadUpcoming, markRead, setSuggestionStatus } from "../../lib/home";
import { useI18n } from "../../lib/i18n";
import { prefill } from "../../lib/prefill";
import { radii, useTheme } from "../../lib/theme";
import { MAIN_THREAD_ID, notificationThreadId } from "../../lib/threads";

const NOTIFICATIONS_FOLDED = 4;

type Loaded<T> = { data: T; error: false } | { data: null; error: true } | null;

async function settle<T>(p: Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await p, error: false };
  } catch {
    return { data: null, error: true };
  }
}

/** Home: weather, notifications, today & upcoming, suggestions, and the way into everything else. */
export default function HomeScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [notes, setNotes] = useState<Loaded<{ notifications: Notification[]; unread: number }>>(null);
  const [upcoming, setUpcoming] = useState<Loaded<UpcomingItem[]>>(null);
  const [suggestions, setSuggestions] = useState<Loaded<Suggestion[]>>(null);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [weatherKey, setWeatherKey] = useState(0);
  const [now, setNow] = useState(0);

  const reload = useCallback(async () => {
    const at = Date.now();
    const [n, u, s] = await Promise.all([settle(loadNotifications()), settle(loadUpcoming(at)), settle(loadSuggestions())]);
    setNow(at);
    setNotes(n);
    setUpcoming(u);
    setSuggestions(s);
  }, []);

  useFocusEffect(
    useCallback(() => {
      Promise.resolve().then(reload);
    }, [reload]),
  );

  const hour = new Date().getHours();
  const greeting = hour < 5 ? t("m.goodNight") : hour < 12 ? t("chat.goodMorning") : hour < 18 ? t("chat.goodAfternoon") : t("chat.goodEvening");

  const openNotification = (n: Notification) => {
    if (!n.read_at) {
      markRead(n.id).catch(() => {});
      setNotes((cur) => (cur?.data ? { ...cur, data: { unread: Math.max(0, cur.data.unread - 1), notifications: cur.data.notifications.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) } } : cur));
    }
    router.push({ pathname: "/chat/[id]", params: { id: notificationThreadId(n.automation_id) } });
  };
  const markAll = async () => {
    await markRead().catch(() => {});
    reload();
  };
  const openUpcoming = (item: UpcomingItem) => {
    if (item.kind === "reminder") router.push("/automations");
    else if (item.task.project_id) router.push({ pathname: "/projects/[id]", params: { id: item.task.project_id, tab: "tasks" } });
    else router.push("/tasks");
  };
  const toggleTask = async (item: UpcomingItem) => {
    if (item.kind !== "task") return;
    await api(`/tasks/${item.task.id}`, { method: "PATCH", body: { status: "done" } }).catch(() => {});
    reload();
  };
  const accept = async (s: Suggestion) => {
    setSuggestions((cur) => (cur?.data ? { ...cur, data: cur.data.filter((x) => x.id !== s.id) } : cur));
    await setSuggestionStatus(s.id, "accepted").catch(() => {});
    prefill(MAIN_THREAD_ID, `${s.title}\n${s.body}`.trim());
    router.navigate("/chat");
  };
  const dismiss = async (s: Suggestion) => {
    setSuggestions((cur) => (cur?.data ? { ...cur, data: cur.data.filter((x) => x.id !== s.id) } : cur));
    await setSuggestionStatus(s.id, "dismissed").catch(() => {});
  };

  const notifications = notes?.data?.notifications ?? [];
  const shown = expanded ? notifications.slice(0, 30) : notifications.slice(0, NOTIFICATIONS_FOLDED);
  const shortcuts = [
    { icon: ListTodo, label: t("nav.tasks"), path: "/tasks" },
    { icon: StickyNote, label: t("nav.notes"), path: "/notes" },
    { icon: Brain, label: t("nav.memory"), path: "/memory" },
    { icon: Timer, label: t("nav.automations"), path: "/automations" },
    { icon: Link2, label: t("nav.connections"), path: "/settings/connections" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 8 }}>
        <View style={{ flex: 1 }}>
          <T weight="semibold" size={22} numberOfLines={1}>
            {greeting}
          </T>
          <T size={12} muted>
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          </T>
        </View>
        <IconButton icon={Settings} onPress={() => router.push("/settings")} label={t("home.settings")} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 8, gap: 18, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.fgMuted}
            onRefresh={async () => {
              setRefreshing(true);
              setWeatherKey((k) => k + 1);
              await reload();
              setRefreshing(false);
            }}
          />
        }
      >
        <WeatherCard refreshKey={weatherKey} />

        <Section
          icon={Bell}
          title={t("home.notifications")}
          action={notes?.data && notes.data.unread > 0 ? <Button title={t("home.markAllRead")} small variant="ghost" onPress={markAll} /> : null}
        >
          {notes === null ? null : notes.error ? (
            <Empty text={t("home.loadFailed")} />
          ) : notifications.length === 0 ? (
            <Empty text={t("home.noNotifications")} />
          ) : (
            <>
              {shown.map((n, i) => (
                <Item key={n.id} last={i === shown.length - 1 && notifications.length <= NOTIFICATIONS_FOLDED} onPress={() => openNotification(n)}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: n.read_at ? "transparent" : c.accent }} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <T weight={n.read_at ? "regular" : "medium"} size={14} numberOfLines={1} style={{ flex: 1 }}>
                        {n.title}
                      </T>
                      <T size={12} muted>
                        {relative(n.created_at, now, t)}
                      </T>
                    </View>
                    {n.body ? (
                      <T size={13} muted numberOfLines={2}>
                        {n.body}
                      </T>
                    ) : null}
                  </View>
                </Item>
              ))}
              {notifications.length > NOTIFICATIONS_FOLDED ? (
                <Press onPress={() => setExpanded((e) => !e)} style={{ paddingVertical: 10, alignItems: "center" }}>
                  <T size={13} color={c.accentText} weight="medium">
                    {expanded ? t("home.showLess") : t("home.showAll", { count: notifications.length })}
                  </T>
                </Press>
              ) : null}
            </>
          )}
        </Section>

        <Section icon={AlarmClock} title={t("home.upcoming")}>
          {upcoming === null ? null : upcoming.error ? (
            <Empty text={t("home.loadFailed")} />
          ) : upcoming.data.length === 0 ? (
            <Empty text={t("home.noUpcoming")} />
          ) : (
            upcoming.data.slice(0, 12).map((item, i, all) => (
              <Item key={item.id} last={i === all.length - 1} onPress={() => openUpcoming(item)}>
                {item.kind === "task" ? (
                  <Press onPress={() => toggleTask(item)} hitSlop={8} accessibilityLabel={t("m.tasks.markDone")}>
                    <Icon icon={item.task.status === "done" ? CheckCircle2 : Circle} size={20} color={c.fgMuted} />
                  </Press>
                ) : (
                  <Icon icon={AlarmClock} size={20} color={c.accentText} />
                )}
                <View style={{ flex: 1, gap: 1 }}>
                  <T size={14} numberOfLines={2}>
                    {item.title}
                  </T>
                  <T size={12} color={item.kind === "task" && item.overdue ? c.danger : c.fgMuted}>
                    {item.kind === "reminder" ? `${t("home.reminder")} · ${clock(item.at)}` : item.overdue ? `${t("home.overdue")}${item.at ? ` · ${day(item.at)}` : ""}` : item.at ? `${t("home.dueToday")} · ${clock(item.at)}` : t("home.dueToday")}
                  </T>
                </View>
              </Item>
            ))
          )}
        </Section>

        {suggestions?.data && suggestions.data.length > 0 ? (
          <Section icon={Sparkles} title={t("home.suggestions")}>
            {suggestions.data.map((s, i, all) => (
              <View key={s.id} style={{ paddingVertical: 12, gap: 8, borderBottomWidth: i === all.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T weight="medium" size={14}>
                      {s.title}
                    </T>
                    {s.body ? (
                      <T size={13} muted>
                        {s.body}
                      </T>
                    ) : null}
                  </View>
                  <Press onPress={() => dismiss(s)} hitSlop={8} accessibilityLabel={t("home.dismiss")}>
                    <Icon icon={X} size={16} color={c.fgFaint} />
                  </Press>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button title={t("home.accept")} small onPress={() => accept(s)} />
                  <Button title={t("home.dismiss")} small variant="secondary" onPress={() => dismiss(s)} />
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        <View style={{ gap: 8 }}>
          <T size={12} weight="medium" muted style={{ paddingHorizontal: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
            {t("home.shortcuts")}
          </T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {shortcuts.map((s) => (
              <Press key={s.path} onPress={() => router.push(s.path as never)} haptic style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
                <Icon icon={s.icon} size={16} />
                <T size={13}>{s.label}</T>
              </Press>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ icon, title, action, children }: { icon: typeof Bell; title: string; action?: ReactNode; children: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, minHeight: 32 }}>
        <Icon icon={icon} size={16} color={c.fgMuted} />
        <T size={12} weight="medium" muted style={{ flex: 1, textTransform: "uppercase", letterSpacing: 0.6 }}>
          {title}
        </T>
        {action}
      </View>
      <View style={{ backgroundColor: c.surface, borderRadius: radii.lg, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{children}</View>
    </View>
  );
}

function Item({ children, onPress, last }: { children: ReactNode; onPress: () => void; last?: boolean }) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} scale={0.99} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 12, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
      {children}
    </Press>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <T size={13} muted style={{ paddingVertical: 14 }}>
      {text}
    </T>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

function relative(iso: string, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  const d = new Date(iso);
  if (!now) return clock(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? clock(iso) : now - d.getTime() < 6 * 86_400_000 ? d.toLocaleDateString([], { weekday: "short" }) : day(iso) || t("common.loading");
}
