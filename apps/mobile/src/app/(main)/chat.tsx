import { ChatScreen } from "../../components/ChatScreen";
import { MAIN_THREAD_ID } from "../../lib/threads";

/** The one continuous chat (agent thread "main"). */
export default function MainChatTab() {
  return <ChatScreen conversationId={MAIN_THREAD_ID} variant="tab" />;
}
