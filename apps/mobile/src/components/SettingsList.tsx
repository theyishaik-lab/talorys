import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { radii, useTheme } from "../lib/theme";
import { Icon, Press, T } from "./ui";

/** Grouped native-style settings list (title above a rounded group of rows). */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {title ? (
        <T size={12} weight="medium" muted style={{ paddingHorizontal: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>
          {title}
        </T>
      ) : null}
      <View style={{ backgroundColor: c.surface, borderRadius: radii.md, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{children}</View>
      {footer ? (
        <T size={12} muted style={{ paddingHorizontal: 12 }}>
          {footer}
        </T>
      ) : null}
    </View>
  );
}

export function Row({
  icon,
  title,
  subtitle,
  value,
  onPress,
  chevron,
  right,
  danger,
  last,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  right?: ReactNode;
  danger?: boolean;
  last?: boolean;
}) {
  const { c } = useTheme();
  const { rtl } = useI18n();
  return (
    <Press onPress={onPress} disabled={!onPress} scale={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border, minHeight: 52 }}>
      {icon ? <Icon icon={icon} size={20} color={danger ? c.danger : c.fg2} /> : null}
      <View style={{ flex: 1, gap: 1 }}>
        <T size={15} color={danger ? c.danger : c.fg}>
          {title}
        </T>
        {subtitle ? (
          <T size={12} muted>
            {subtitle}
          </T>
        ) : null}
      </View>
      {value ? (
        <T size={14} muted numberOfLines={1} style={{ maxWidth: 150 }}>
          {value}
        </T>
      ) : null}
      {right}
      {chevron ? <Icon icon={rtl ? ChevronLeft : ChevronRight} size={18} color={c.fgFaint} /> : null}
    </Press>
  );
}

export function ToggleRow({ title, subtitle, value, onChange, disabled, last }: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; last?: boolean }) {
  const { c } = useTheme();
  return <Row title={title} subtitle={subtitle} last={last} right={<Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: c.accent, false: c.borderStrong }} thumbColor={c.bg} />} />;
}

export function RadioRow({ title, subtitle, selected, onPress, last }: { title: string; subtitle?: string; selected: boolean; onPress: () => void; last?: boolean }) {
  const { c } = useTheme();
  return (
    <Row
      title={title}
      subtitle={subtitle}
      onPress={onPress}
      last={last}
      right={
        <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: selected ? 6 : 1.5, borderColor: selected ? c.accent : c.borderStrong, backgroundColor: c.bg }} />
      }
    />
  );
}
