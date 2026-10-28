import { ArrowUp, Square } from "lucide-react-native";
import { memo, useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { prefillStore, takePrefill } from "../lib/prefill";
import { useTheme } from "../lib/theme";
import { Icon, Press, useFont } from "./ui";

interface Props {
  agentName: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Text queued for this conversation (a suggestion accepted on Home) lands in the field. */
  conversationId?: string;
}

/** The pill composer from the mockups: grows with the text, send is the dark round button. */
export const Composer = memo(function Composer({ agentName, busy, onSend, onStop, conversationId }: Props) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const [text, setText] = useState("");
  useEffect(() => {
    if (!conversationId) return;
    const take = () => {
      const queued = takePrefill(conversationId);
      if (queued) setText(queued);
    };
    Promise.resolve().then(take);
    return prefillStore.subscribe(take);
  }, [conversationId]);
  const canSend = text.trim().length > 0 && !busy;
  const send = () => {
    if (!canSend) return;
    const v = text.trim();
    setText("");
    onSend(v);
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, backgroundColor: c.bg }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: 24, padding: 6 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t("chat.placeholder", { name: agentName })}
          placeholderTextColor={c.fgFaint}
          multiline
          maxLength={8000}
          accessibilityLabel={t("chat.message")}
          style={{ flex: 1, fontFamily: font, fontSize: 15, lineHeight: 21, color: c.fg, paddingHorizontal: 8, paddingVertical: 8, maxHeight: 140, textAlign: rtl ? "right" : "left" }}
          textAlignVertical="center"
        />
        {busy ? (
          <Press onPress={onStop} haptic accessibilityRole="button" accessibilityLabel={t("chat.stop")} scale={0.9} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.fg, alignItems: "center", justifyContent: "center" }}>
            <Icon icon={Square} size={14} color={c.bg} strokeWidth={2.5} />
          </Press>
        ) : (
          <Press
            onPress={send}
            disabled={!canSend}
            haptic
            accessibilityRole="button"
            accessibilityLabel={t("chat.send")}
            scale={0.9}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: canSend ? c.fg : c.surface2, alignItems: "center", justifyContent: "center" }}
          >
            <Icon icon={ArrowUp} size={18} color={canSend ? c.bg : c.fgFaint} strokeWidth={2.2} />
          </Press>
        )}
      </View>
    </View>
  );
});
