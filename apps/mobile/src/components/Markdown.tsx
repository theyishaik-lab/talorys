import { memo } from "react";
import MarkdownDisplay from "react-native-markdown-display";
import { Linking, StyleSheet } from "react-native";
import { useI18n } from "../lib/i18n";
import { fonts, radii, useTheme } from "../lib/theme";

/**
 * Assistant replies as plain, readable text (the mockups: no bubble for the assistant).
 * Rendered only for finished messages; the reply being streamed is plain Text (see MessageRow).
 */
export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const { c } = useTheme();
  const { locale, rtl } = useI18n();
  const f = fonts[locale];
  const fg = color ?? c.fg;
  const styles = StyleSheet.create({
    body: { color: fg, fontFamily: f.regular, fontSize: 15, lineHeight: 22, textAlign: rtl ? "right" : "left", writingDirection: rtl ? "rtl" : "ltr" },
    paragraph: { marginTop: 0, marginBottom: 10 },
    heading1: { fontFamily: f.semibold, fontSize: 20, lineHeight: 28, marginBottom: 8, color: fg },
    heading2: { fontFamily: f.semibold, fontSize: 18, lineHeight: 26, marginBottom: 6, color: fg },
    heading3: { fontFamily: f.semibold, fontSize: 16, lineHeight: 24, marginBottom: 6, color: fg },
    strong: { fontFamily: f.semibold },
    em: { fontStyle: "italic" },
    link: { color: c.accentText },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    list_item: { marginBottom: 4, flexDirection: rtl ? "row-reverse" : "row" },
    code_inline: { fontFamily: "monospace", backgroundColor: c.surface2, color: fg, borderRadius: 6, paddingHorizontal: 4, fontSize: 13 },
    code_block: { fontFamily: "monospace", backgroundColor: c.surface, color: fg, borderRadius: radii.sm, padding: 10, fontSize: 13, borderWidth: 0 },
    fence: { fontFamily: "monospace", backgroundColor: c.surface, color: fg, borderRadius: radii.sm, padding: 10, fontSize: 13, borderWidth: 0 },
    blockquote: { backgroundColor: c.surface, borderLeftColor: c.border, borderLeftWidth: 3, paddingHorizontal: 10, borderRadius: radii.sm },
    hr: { backgroundColor: c.border, height: StyleSheet.hairlineWidth, marginVertical: 10 },
    table: { borderColor: c.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm },
    th: { padding: 6, fontFamily: f.semibold },
    td: { padding: 6 },
    tr: { borderColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
  });
  return (
    <MarkdownDisplay style={styles} onLinkPress={(url) => {
        Linking.openURL(url).catch(() => {});
        return false;
      }}>
      {text}
    </MarkdownDisplay>
  );
});
