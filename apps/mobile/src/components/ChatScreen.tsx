import type { ChatMessage } from "@talorys/shared";
import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { router } from "expo-router";
import { Menu, SquarePen } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, View } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { useDrawer } from "../lib/drawer";
import { isNearBottom } from "../lib/keyboard";
import { cancelGeneration, createChatStores, isInFlight, loadConversation, refreshConversations, sendMessage, updateTool } from "../lib/chat";
import { useI18n } from "../lib/i18n";
import { useStore } from "../lib/store";
import { useTheme } from "../lib/theme";
import { Composer } from "./Composer";
import { HomeEmpty } from "./HomeEmpty";
import { KeyboardSpacer } from "./KeyboardSpacer";
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
  const list = useRef<FlashListRef<Row>>(null);
  // Whether the reader is at the latest message. While true, anything that shrinks the list's
  // viewport (the keyboard opening, the composer growing a line) keeps the end in view.
  const pinned = useRef(true);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    pinned.current = isNearBottom(contentOffset.y, layoutMeasurement.height, contentSize.height);
  }, []);
  const onListLayout = useCallback((_e: LayoutChangeEvent) => {
    if (pinned.current) list.current?.scrollToEnd({ animated: false });
  }, []);
  useEffect(() => {
    const sub = KeyboardEvents.addListener("keyboardDidShow", () => {
      if (pinned.current) list.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // Stores handed over mid-reply (a new chat moving to its own route) are already live.
    // Leaving the screen never aborts a reply: the agent finishes and saves it either way.
    if (conversationId && !isInFlight(stores)) loadConversation(stores, conversationId);
  }, [conversationId, stores]);

  const onSend = useCallback(
    (text: string) => {
      const controller = new AbortController();
      const startedNew = !stores.chat.get().conversationId;
      sendMessage(stores, text, controller, (id) => {
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
    const controller = stores.controller.current;
    if (controller) cancelGeneration(stores, controller).catch(() => {});
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
      {/* No KeyboardAvoidingView: edge-to-edge Android never resizes the window, so the spacer below makes the room. */}
      <View style={{ flex: 1 }}>
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
            onScroll={onScroll}
            scrollEventThrottle={32}
            onLayout={onListLayout}
            ListFooterComponent={state.quotaExceeded ? <QuotaCard message={state.quotaExceeded.message} /> : null}
          />
        )}
        <Composer agentName={auth.agentName} busy={busy} onSend={onSend} onStop={onStop} />
        <KeyboardSpacer safeBottom={insets.bottom} color={c.bg} />
      </View>
    </View>
  );
}
