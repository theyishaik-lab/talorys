import { useLocalSearchParams } from "expo-router";
import { ChatScreen } from "../../../components/ChatScreen";

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatScreen key={id} conversationId={id} />;
}
