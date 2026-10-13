import type { ChatMessage, ToolActivity } from "@talorys/shared";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react-native";
import { memo } from "react";
import { View } from "react-native";
import { friendlyChatError } from "../lib/errors";
import { firstStrongDirection, useI18n } from "../lib/i18n";
import type { StreamState } from "../lib/chat";
import type { Store } from "../lib/store";
import { useStore } from "../lib/store";
import { radii, useTheme } from "../lib/theme";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { Chip, T } from "./ui";

export function ToolChips({ tools, onChange }: { tools: ToolActivity[]; onChange?: (tool: ToolActivity) => void }) {
  const { c } = useTheme();
  if (!tools.length) return null;
  return (
    <View style={{ gap: 8, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {tools.map((tool) => (
          <Chip
            key={tool.id}
            icon={tool.status === "running" ? Loader2 : tool.status === "error" ? AlertCircle : CheckCircle2}
            label={tool.label}
            color={tool.status === "error" ? c.danger : tool.status === "running" ? c.accentText : c.fgMuted}
          />
        ))}
      </View>
      {tools
        .filter((tool) => tool.approval)
        .map((tool) => (
          <ApprovalCard key={tool.id} tool={tool} onChange={onChange ?? (() => {})} />
        ))}
    </View>
  );
}

interface RowProps {
  message: ChatMessage;
  onToolChange: (messageId: string, tool: ToolActivity) => void;
}

/** One finished message. Memoized: a row re-renders only when its own message object changes. */
export const MessageRow = memo(function MessageRow({ message, onToolChange }: RowProps) {
  const { c } = useTheme();
  const { rtl, t } = useI18n();
  if (message.role === "user") {
    const dir = firstStrongDirection(message.content, rtl ? "rtl" : "ltr");
    return (
      <View style={{ paddingHorizontal: 16, paddingVertical: 6, alignItems: "flex-end" }}>
        <View style={{ backgroundColor: c.bubbleUser, borderRadius: radii.lg, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "85%" }}>
          <T color={c.bubbleUserFg} style={{ textAlign: dir === "rtl" ? "right" : "left", writingDirection: dir }}>
            {message.content}
          </T>
        </View>
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <ToolChips tools={message.tools} onChange={(tool) => onToolChange(message.id, tool)} />
      {message.content ? <Markdown text={message.content} /> : null}
      {message.status === "cancelled" ? (
        <T size={13} muted>
          {t("m.streaming.stopped")}
        </T>
      ) : null}
      {message.status === "error" && message.error ? (
        <T size={13} color={c.danger}>
          {friendlyChatError(message.error, t)}
        </T>
      ) : null}
    </View>
  );
});

/** The reply being streamed: subscribes to the stream store itself, so tokens never touch the list. */
export const StreamingRow = memo(function StreamingRow({ stream }: { stream: Store<StreamState | null> }) {
  const { c } = useTheme();
  const { rtl, t } = useI18n();
  const st = useStore(stream);
  if (!st) return null;
  const dir = firstStrongDirection(st.text, rtl ? "rtl" : "ltr");
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <ToolChips tools={st.tools} />
      {st.text ? (
        <T style={{ textAlign: dir === "rtl" ? "right" : "left", writingDirection: dir }}>{st.text}</T>
      ) : st.error && !st.recovering ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent }} />
          <T size={13} muted>
            {st.recovering ? t("chat.recovering") : `${t("chat.thinking")}…`}
          </T>
        </View>
      )}
      {st.error && !st.recovering ? (
        <T size={13} color={c.danger}>
          {friendlyChatError(st.error, t)}
        </T>
      ) : null}
    </View>
  );
});
