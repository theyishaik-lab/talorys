import type { ChatMessage, Notification } from "@talorys/shared";
import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { ArrowLeft, ArrowRight, Bell } from "lucide-react-native";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, StyleSheet, View } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { cancelGeneration, createChatStores, isInFlight, loadConversation, refreshConversations, sendMessage, updateTool } from "../lib/chat";
import { loadNotifications, markRead } from "../lib/home";
import { useI18n } from "../lib/i18n";
import { TAB_BAR_HEIGHT, isNearBottom } from "../lib/keyboard";
import { useStore } from "../lib/store";
import { radii, useTheme } from "../lib/theme";
import { MAIN_THREAD_ID, type NoticeRow, isUpdatesThread, mergeNotices, notificationThreadId } from "../lib/threads";
import { Composer } from "./Composer";
import { HomeEmpty } from "./HomeEmpty";
import { KeyboardSpacer } from "./KeyboardSpacer";
import { MessageRow, StreamingRow } from "./MessageRow";
import { QuotaCard } from "./QuotaCard";
import { Button, Icon, IconButton, Press, T } from "./ui";

type Row = ChatMessage | NoticeRow | { id: "__stream__"; role: "stream" };

/**
 * One chat thread.
 * - `tab`: the main chat (the Chat tab): one continuous conversation, notifications shown inline,
 *   sits above the bottom tab bar.
 * - `thread`: a pushed screen with Back (an `updates-*` thread a push tap opens).
 * - `embedded`: inside another screen that draws its own header (a project's chat).
 */
export function ChatScreen({ conversationId, variant, empty }: { conversationId: string; variant: "tab" | "thread" | "embedded"; empty?: ReactNode }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const stores = useMemo(() => createChatStores(conversationId), [conversationId]);
  const state = useStore(stores.chat);
  const list = useRef<FlashListRef<Row>>(null);
  const inline = variant === "tab" && conversationId === MAIN_THREAD_ID;
  const [notices, setNotices] = useState<Notification[]>([]);
  // "Now" for the inline window, taken when notifications load (a render must stay pure).
  const [loadedAt, setLoadedAt] = useState(0);

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

  const reloadNotices = useCallback(async () => {
    if (!inline) return;
    try {
      const r = await loadNotifications();
      setLoadedAt(Date.now());
      setNotices(r.notifications);
    } catch {
      /* the chat works without them */
    }
  }, [inline]);

  // Coming back to the tab (or the screen) picks up what happened meanwhile: a reply finished in the
  // background, a notification that arrived. Leaving never aborts a reply.
  useFocusEffect(
    useCallback(() => {
      if (!isInFlight(stores)) Promise.resolve().then(() => loadConversation(stores, conversationId));
      Promise.resolve().then(reloadNotices);
    }, [stores, conversationId, reloadNotices]),
  );

  const onSend = useCallback(
    (text: string) => {
      const controller = new AbortController();
      pinned.current = true;
      sendMessage(stores, text, controller).finally(() => refreshConversations().catch(() => {}));
    },
    [stores],
  );
  const onStop = useCallback(() => {
    const controller = stores.controller.current;
    if (controller) cancelGeneration(stores, controller).catch(() => {});
  }, [stores]);
  const onToolChange = useCallback((messageId: string, tool: Parameters<typeof updateTool>[2]) => updateTool(stores, messageId, tool), [stores]);

  const openNotice = useCallback((n: Notification) => {
    if (!n.read_at) markRead(n.id).catch(() => {});
    setNotices((all) => all.map((x) => (x.id === n.id ? { ...x, read_at: x.read_at ?? new Date().toISOString() } : x)));
    router.push({ pathname: "/chat/[id]", params: { id: notificationThreadId(n.automation_id) } });
  }, []);

  const rows = useMemo<Row[]>(() => {
    const base: Row[] = inline ? mergeNotices(state.messages, notices, loadedAt) : state.messages;
    return state.streamingId ? [...base, { id: "__stream__", role: "stream" }] : base;
  }, [state.messages, state.streamingId, inline, notices, loadedAt]);

  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) =>
      item.role === "stream" ? (
        <StreamingRow stream={stores.stream} />
      ) : item.role === "notice" ? (
        <NoticeBubble notice={(item as NoticeRow).notification} onPress={openNotice} />
      ) : (
        <MessageRow message={item as ChatMessage} onToolChange={onToolChange} />
      ),
    [stores, onToolChange, openNotice],
  );

  const busy = state.streamingId !== null;
  const showEmpty = !state.loading && !state.loadError && rows.length === 0;
  const tabOffset = variant === "tab" ? TAB_BAR_HEIGHT + insets.bottom : 0;
  const title = variant === "tab" ? t("mainchat.title") : isUpdatesThread(conversationId) ? state.title || t("thread.updates") : state.title || "";

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: variant === "embedded" ? 0 : insets.top }}>
      {variant === "embedded" ? null : (
        <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: variant === "thread" ? 8 : 16, gap: 4 }}>
          {variant === "thread" ? (
            <IconButton icon={rtl ? ArrowRight : ArrowLeft} onPress={() => (router.canGoBack() ? router.back() : router.replace("/chat"))} label={t("settings.back")} />
          ) : null}
          <T weight="semibold" size={variant === "tab" ? 20 : 17} style={{ flex: 1 }} numberOfLines={1}>
            {title}
          </T>
        </View>
      )}
      {/* No KeyboardAvoidingView: edge-to-edge Android never resizes the window, so the spacer below makes the room. */}
      <View style={{ flex: 1 }}>
        {showEmpty ? (
          (empty ?? <HomeEmpty agentName={auth.agentName} onPick={onSend} />)
        ) : state.loadError && rows.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
            <T muted center>
              {t("chat.loadFailed")}
            </T>
            <Button title={t("common.retry")} variant="secondary" small onPress={() => loadConversation(stores, conversationId)} />
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
        <Composer agentName={auth.agentName} busy={busy} onSend={onSend} onStop={onStop} conversationId={conversationId} />
        <KeyboardSpacer safeBottom={variant === "tab" ? 0 : insets.bottom} offset={tabOffset} color={c.bg} />
      </View>
    </View>
  );
}

/** A notification shown inline in the main chat; a tap opens its full text (its updates thread). */
function NoticeBubble({ notice, onPress }: { notice: Notification; onPress: (n: Notification) => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
      <Press
        onPress={() => onPress(notice)}
        accessibilityRole="button"
        accessibilityLabel={`${t("mainchat.notice")}: ${notice.title}`}
        style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: notice.read_at ? c.surface : c.accentSoft, borderRadius: radii.md, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: notice.read_at ? c.border : "transparent" }}
      >
        <Icon icon={Bell} size={16} color={c.accentText} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={12} muted>
            {t("mainchat.notice")} · {new Date(notice.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </T>
          <T weight="medium" size={14}>
            {notice.title}
          </T>
          {notice.body ? (
            <T size={13} muted numberOfLines={3}>
              {notice.body}
            </T>
          ) : null}
        </View>
      </Press>
    </View>
  );
}
