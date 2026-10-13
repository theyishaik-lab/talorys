import { router } from "expo-router";
import { ArrowLeft, ArrowRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { IconButton, T } from "./ui";

/** A pushed screen: top bar with Back (mirrored in RTL), then content. Android's back button pops it too. */
export function Screen({ title, children, scroll = true, right, contentStyle }: { title: string; children: ReactNode; scroll?: boolean; right?: ReactNode; contentStyle?: ViewStyle }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const insets = useSafeAreaInsets();
  const body = scroll ? (
    // Keyboard-aware: a focused field (Settings → Model's API keys) is scrolled above the keyboard.
    <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={[{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }, contentStyle]} keyboardShouldPersistTaps="handled">
      {children}
    </KeyboardAwareScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 4 }}>
        <IconButton icon={rtl ? ArrowRight : ArrowLeft} onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} label={t("settings.back")} />
        <T weight="semibold" size={17} style={{ flex: 1 }} numberOfLines={1}>
          {title}
        </T>
        {right}
      </View>
      {body}
    </View>
  );
}
