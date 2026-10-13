import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, type PressableProps, StyleSheet, Text as RNText, type TextProps, type TextStyle, View, type ViewStyle } from "react-native";
import { useI18n } from "../lib/i18n";
import { fonts, radii, useTheme } from "../lib/theme";

type Weight = "regular" | "medium" | "semibold";

export function useFont(weight: Weight = "regular"): string {
  const { locale } = useI18n();
  return fonts[locale][weight];
}

export interface TProps extends TextProps {
  weight?: Weight;
  size?: number;
  color?: string;
  muted?: boolean;
  center?: boolean;
  children?: ReactNode;
}

/** Text in the locale's font (Inter / Heebo) and the theme's colours. */
export function T({ weight = "regular", size = 15, color, muted, center, style, children, ...rest }: TProps) {
  const { c } = useTheme();
  const family = useFont(weight);
  return (
    <RNText
      {...rest}
      style={[{ fontFamily: family, fontSize: size, color: color ?? (muted ? c.fgMuted : c.fg), lineHeight: Math.round(size * 1.45), textAlign: center ? "center" : undefined }, style]}
    >
      {children}
    </RNText>
  );
}

export function Icon({ icon: I, size = 20, color, strokeWidth = 1.75 }: { icon: LucideIcon; size?: number; color?: string; strokeWidth?: number }) {
  const { c } = useTheme();
  return <I size={size} color={color ?? c.fg2} strokeWidth={strokeWidth} />;
}

interface PressProps extends PressableProps {
  haptic?: boolean | Haptics.ImpactFeedbackStyle;
  scale?: number;
  style?: ViewStyle | ViewStyle[];
  children?: ReactNode;
}

/** A pressable that shrinks slightly while pressed (the mockups' press-scale) and can tick the haptics. */
export function Press({ haptic, scale = 0.97, style, onPress, children, ...rest }: PressProps) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => {
        if (haptic) Haptics.impactAsync(typeof haptic === "boolean" ? Haptics.ImpactFeedbackStyle.Light : haptic).catch(() => {});
        onPress?.(e);
      }}
      style={({ pressed }) => [style, pressed ? { transform: [{ scale }], opacity: 0.9 } : null]}
      android_ripple={undefined}
    >
      {children}
    </Pressable>
  );
}

export function IconButton({ icon, onPress, label, color, size = 40 }: { icon: LucideIcon; onPress?: () => void; label: string; color?: string; size?: number }) {
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label} scale={0.92} style={{ width: size, height: size, borderRadius: 12, alignItems: "center", justifyContent: "center" }} hitSlop={6}>
      <Icon icon={icon} color={color} />
    </Press>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  icon,
  loading,
  disabled,
  style,
  small,
}: {
  title: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  small?: boolean;
}) {
  const { c } = useTheme();
  const bg = variant === "primary" ? c.fg : variant === "secondary" ? c.surface : variant === "danger" ? c.dangerSoft : "transparent";
  const fg = variant === "primary" ? c.bg : variant === "danger" ? c.danger : c.fg;
  return (
    <Press
      onPress={onPress}
      disabled={disabled || loading}
      haptic
      accessibilityRole="button"
      style={[
        {
          backgroundColor: bg,
          borderRadius: 999,
          paddingVertical: small ? 8 : 12,
          paddingHorizontal: small ? 14 : 18,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: disabled ? 0.5 : 1,
          borderWidth: variant === "secondary" ? StyleSheet.hairlineWidth : 0,
          borderColor: c.border,
        },
        style ?? {},
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Icon icon={icon} size={small ? 16 : 18} color={fg} strokeWidth={2} /> : null}
      <T weight="medium" size={small ? 14 : 15} color={fg}>
        {title}
      </T>
    </Press>
  );
}

export function Card({ children, style, accent }: { children: ReactNode; style?: ViewStyle; accent?: boolean }) {
  const { c } = useTheme();
  return <View style={[{ backgroundColor: accent ? c.accentSoft : c.surface, borderRadius: radii.lg, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: accent ? "transparent" : c.border }, style]}>{children}</View>;
}

export function Chip({ icon, label, color, bg }: { icon?: LucideIcon; label: string; color?: string; bg?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: bg ?? c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, alignSelf: "flex-start" }}>
      {icon ? <Icon icon={icon} size={14} color={color ?? c.fgMuted} /> : null}
      <T size={13} color={color ?? c.fgMuted}>
        {label}
      </T>
    </View>
  );
}

export function Separator() {
  const { c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>{children}</View>;
}

export const textStyles = StyleSheet.create({ title: { fontSize: 16 } satisfies TextStyle });
