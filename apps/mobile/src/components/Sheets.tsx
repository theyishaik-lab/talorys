import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { radii, useTheme } from "../lib/theme";
import { Button, Icon, Press, T, useFont } from "./ui";

/** A bottom sheet of actions (Android's Alert takes at most three buttons). */
export function ActionSheet({ visible, title, actions, onClose }: { visible: boolean; title?: string; actions: { label: string; icon?: LucideIcon; danger?: boolean; onPress: () => void }[]; onClose: () => void }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: c.scrim, justifyContent: "flex-end" }} onPress={onClose}>
        <Pressable style={{ backgroundColor: c.elev, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, paddingTop: 8, paddingBottom: insets.bottom + 8, paddingHorizontal: 8 }}>
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: 8 }} />
          {title ? (
            <T size={13} muted weight="medium" style={{ paddingHorizontal: 12, paddingBottom: 6 }} numberOfLines={1}>
              {title}
            </T>
          ) : null}
          {actions.map((a) => (
            <Press
              key={a.label}
              onPress={() => {
                onClose();
                a.onPress();
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 14, borderRadius: radii.sm }}
            >
              {a.icon ? <Icon icon={a.icon} size={20} color={a.danger ? c.danger : c.fg2} /> : null}
              <T size={15} color={a.danger ? c.danger : c.fg}>
                {a.label}
              </T>
            </Press>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A small dialog with one or two text fields (create / rename; Alert.prompt is iOS-only). */
export function PromptDialog({
  visible,
  title,
  label,
  initial = "",
  secondLabel,
  secondInitial = "",
  secondMax = 5000,
  confirm,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  label: string;
  initial?: string;
  secondLabel?: string;
  secondInitial?: string;
  secondMax?: number;
  confirm: string;
  onConfirm: (value: string, second: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const [value, setValue] = useState(initial);
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const input = { fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.surface, borderRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, textAlign: rtl ? ("right" as const) : ("left" as const) };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onShow={() => { setValue(initial); setSecond(secondInitial); }} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: c.scrim, justifyContent: "flex-start", padding: 24, paddingTop: 120 }} onPress={onClose}>
        <Pressable style={{ backgroundColor: c.elev, borderRadius: radii.lg, padding: 18, gap: 12 }}>
          <T weight="semibold" size={17}>
            {title}
          </T>
          <TextInput value={value} onChangeText={setValue} placeholder={label} placeholderTextColor={c.fgFaint} autoFocus maxLength={200} style={input} accessibilityLabel={label} />
          {secondLabel ? <TextInput value={second} onChangeText={setSecond} placeholder={secondLabel} placeholderTextColor={c.fgFaint} multiline maxLength={secondMax} style={[input, { minHeight: 72, textAlignVertical: "top" }]} accessibilityLabel={secondLabel} /> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button title={t("common.cancel")} small variant="ghost" onPress={onClose} />
            <Button
              title={confirm}
              small
              loading={busy}
              disabled={!value.trim()}
              onPress={async () => {
                setBusy(true);
                try {
                  await onConfirm(value.trim(), second.trim());
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
