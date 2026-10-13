import { View } from "react-native";
import { useTheme } from "../lib/theme";
import { T } from "./ui";

/** The placeholder "T" mark (same as the web icon) until the brand is chosen. */
export function Logo({ size = 40 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: c.accent, alignItems: "center", justifyContent: "center" }}>
      <T weight="semibold" size={size * 0.52} color={c.accentFg} style={{ lineHeight: size * 0.62 }}>
        T
      </T>
    </View>
  );
}
