import type { Conversation } from "@talorys/shared";
import { router, usePathname } from "expo-router";
import { Brain, ListTodo, MessageSquarePlus, Settings, StickyNote, Timer, Trash2 } from "lucide-react-native";
import { memo, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../lib/api";
import { conversationsStore, refreshConversations } from "../lib/chat";
import { useI18n } from "../lib/i18n";
import { useStore } from "../lib/store";
import { radii, useTheme } from "../lib/theme";
import { Icon, Press, Separator, T, useFont } from "./ui";

function groupOf(iso: string, now: Date, t: ReturnType<typeof useI18n>["t"]): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return t("drawer.today");
  if (diff === 1) return t("drawer.yesterday");
  if (diff < 7) return t("drawer.thisWeek");
  return t("drawer.earlier");
}

type Row = { type: "header"; id: string; title: string } | { type: "chat"; id: string; chat: Conversation };

/** Chat history + the four pages + settings, in the drawer (replaces the old bottom nav). */
export const DrawerContent = memo(function DrawerContent({ onClose }: { onClose: () => void }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const insets = useSafeAreaInsets();
  const font = useFont();
  const conversations = useStore(conversationsStore);
  const pathname = usePathname();
  const [q, setQ] = useState("");

  useEffect(() => {
    refreshConversations().catch(() => {});
  }, []);

  const rows = useMemo<Row[]>(() => {
    const now = new Date();
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    let group = "";
    for (const chat of conversations.filter((x) => !needle || x.title.toLowerCase().includes(needle))) {
      const g = groupOf(chat.updated_at, now, t);
      if (g !== group) {
        group = g;
        out.push({ type: "header", id: `h-${g}`, title: g });
      }
      out.push({ type: "chat", id: chat.id, chat });
    }
    return out;
  }, [conversations, q, t]);

  const go = (path: string) => {
    onClose();
    router.push(path as never);
  };
  const openChat = (id: string) => {
    onClose();
    router.replace({ pathname: "/chat/[id]", params: { id } });
  };
  const remove = (chat: Conversation) => {
    Alert.alert(t("chat.deleteTitle"), t("chat.deleteMessage", { title: chat.title }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          await api(`/conversations/${chat.id}`, { method: "DELETE" }).catch(() => {});
          conversationsStore.set((list) => list.filter((x) => x.id !== chat.id));
          if (pathname.endsWith(chat.id)) router.replace("/");
        },
      },
    ]);
  };

  const pages = [
    { icon: Brain, label: t("nav.memory"), path: "/memory" },
    { icon: ListTodo, label: t("nav.tasks"), path: "/tasks" },
    { icon: StickyNote, label: t("nav.notes"), path: "/notes" },
    { icon: Timer, label: t("nav.automations"), path: "/automations" },
  ];

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}>
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <Press onPress={() => go("/")} haptic style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: c.bg, borderRadius: radii.md, paddingHorizontal: 12, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
          <Icon icon={MessageSquarePlus} size={18} />
          <T weight="medium">{t("chat.new")}</T>
        </Press>
        <TextInput value={q} onChangeText={setQ} placeholder={t("drawer.search")} placeholderTextColor={c.fgFaint} style={{ fontFamily: font, fontSize: 14, color: c.fg, backgroundColor: c.surface2, borderRadius: radii.sm, paddingHorizontal: 12, paddingVertical: 8, textAlign: rtl ? "right" : "left" }} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        style={{ flex: 1, marginTop: 8 }}
        contentContainerStyle={{ paddingHorizontal: 8 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <T size={13} muted style={{ padding: 12 }}>
            {q ? t("chat.noMatches") : t("chat.noConversations")}
          </T>
        }
        renderItem={({ item }) =>
          item.type === "header" ? (
            <T size={12} muted weight="medium" style={{ paddingHorizontal: 8, paddingTop: 12, paddingBottom: 4 }}>
              {item.title}
            </T>
          ) : (
            <Press onPress={() => openChat(item.id)} onLongPress={() => remove(item.chat)} delayLongPress={350} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 9, borderRadius: radii.sm, backgroundColor: pathname.endsWith(item.id) ? c.surface2 : "transparent" }}>
              <T size={14} numberOfLines={1} style={{ flex: 1 }}>
                {item.chat.title || t("chat.newConversation")}
              </T>
              {pathname.endsWith(item.id) ? (
                <Press onPress={() => remove(item.chat)} hitSlop={8} accessibilityLabel={t("common.delete")}>
                  <Icon icon={Trash2} size={15} color={c.fgMuted} />
                </Press>
              ) : null}
            </Press>
          )
        }
      />
      <Separator />
      <View style={{ paddingHorizontal: 8, paddingTop: 8, gap: 2 }}>
        {pages.map((p) => (
          <Press key={p.path} onPress={() => go(p.path)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: radii.sm }}>
            <Icon icon={p.icon} size={18} />
            <T size={14}>{p.label}</T>
          </Press>
        ))}
        <Press onPress={() => go("/settings")} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: radii.sm }}>
          <Icon icon={Settings} size={18} />
          <T size={14}>{t("nav.settings")}</T>
        </Press>
      </View>
    </View>
  );
});
