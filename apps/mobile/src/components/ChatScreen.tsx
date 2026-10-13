import type { ChatMessage } from "@talorys/shared";
import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { router } from "expo-router";
import { Menu, SquarePen } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { useDrawer } from "../lib/drawer";
import { cancelGeneration, createChatStores, loadConversation, refreshConversations, sendMessage, updateTool } from "../lib/chat";
import { useI18n } from "../lib/i18n";
import { useStore } from "../lib/store";
import { useTheme } from "../lib/theme";
import { Composer } from "./Composer";
import { HomeEmpty } from "./HomeEmpty";
import { MessageRow, StreamingRow } from "./MessageRow";
import { QuotaCard } from "./QuotaCard";
import { Button, IconButton, T } from "./ui";

type Row = ChatMessage | { id: "__stream__"; role: "stream" };

/** One chat (or the empty home when `conversationId` is null). */
export function ChatScreen({ conversationId }: { conversationId: string | null }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const auth = useAuth();
  const drawer = useDrawer();
  const insets = useSafeAreaInsets();
  const stores = useMemo(() => createChatStores(conversationId), [conversationId]);
  const state = useStore(stores.chat);
  const controller = useRef<AbortController | null>(null);
  const list = useRef<FlashListRef<Row>>(null);

  useEffect(() => {
    if (conversationId) loadConversation(stores, conversationId);
    return () => controller.current?.abort();
  }, [conversationId, stores]);

  const onSend = useCallback(
    (text: string) => {
      controller.current = new AbortController();
      const startedNew = !stores.chat.get().conversationId;
      sendMessage(stores, text, controller.current, (id) => {
        if (startedNew) {
          refreshConversations().catch(() => {});
          // The new chat gets its own route (so Back and the drawer behave), without a visible transition.
          router.replace({ pathname: "/chat/[id]", params: { id } });
        }
      }).finally(() => refreshConversations().catch(() => {}));
    },
    [stores],
  );
  const onStop = useCallback(() => {
    if (controller.current) cancelGeneration(stores, controller.current).catch(() => {});
  }, [stores]);
  const onToolChange = useCallback((messageId: string, tool: Parameters<typeof updateTool>[2]) => updateTool(stores, messageId, tool), [stores]);

  const rows = useMemo<Row[]>(() => (state.streamingId ? [...state.messages, { id: "__stream__", role: "stream" }] : state.messages), [state.messages, state.streamingId]);

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => (item.role === "stream" ? <StreamingRow stream={stores.stream} /> : <MessageRow message={item} onToolChange={onToolChange} />),
    [stores, onToolChange],
  );

  const busy = state.streamingId !== null;
  const empty = !conversationId && rows.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 }}>
        <IconButton icon={Menu} onPress={drawer.open} label={t("drawer.menu")} />
        <T weight="semibold" size={15} style={{ letterSpacing: 2 }}>
          TALORYS
        </T>
        <IconButton icon={SquarePen} onPress={() => router.replace("/")} label={t("chat.new")} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {empty ? (
          <HomeEmpty agentName={auth.agentName} onPick={onSend} />
        ) : state.loadError ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
            <T muted center>
              {t("chat.loadFailed")}
            </T>
            <Button title={t("common.retry")} variant="secondary" small onPress={() => conversationId && loadConversation(stores, conversationId)} />
          </View>
        ) : (
          <FlashList
            ref={list}
            data={rows}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            getItemType={(item) => item.role}
            maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true }}
            contentContainerStyle={{ paddingVertical: 8 }}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={state.quotaExceeded ? <QuotaCard message={state.quotaExceeded.message} /> : null}
          />
        )}
        <Composer agentName={auth.agentName} busy={busy} onSend={onSend} onStop={onStop} />
        <View style={{ height: insets.bottom }} />
      </KeyboardAvoidingView>
    </View>
  );
}
