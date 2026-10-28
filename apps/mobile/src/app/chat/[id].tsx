import { Redirect, useLocalSearchParams } from "expo-router";
import { ChatScreen } from "../../components/ChatScreen";
import { MAIN_THREAD_ID } from "../../lib/threads";

/** A thread opened by itself: a notification's updates thread (push tap), or an older conversation. */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (id === MAIN_THREAD_ID) return <Redirect href="/chat" />;
  return <ChatScreen key={id} conversationId={id} variant="thread" />;
}
