import type { Note } from "@talorys/shared";
import { memo, useCallback, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ListScreen } from "../components/ListScreen";
import { Markdown } from "../components/Markdown";
import { Button, Card, Press, T } from "../components/ui";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";

const NoteRow = memo(function NoteRow({ note, onOpen }: { note: Note; onOpen: (n: Note) => void }) {
  return (
    <Press onPress={() => onOpen(note)}>
      <Card style={{ gap: 4 }}>
        <T weight="medium">{note.title}</T>
        <T size={13} muted numberOfLines={2}>
          {note.content.replace(/\s+/g, " ").slice(0, 160)}
        </T>
      </Card>
    </Press>
  );
});

export default function NotesScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<Note | null>(null);
  const load = useCallback(async () => (await api<{ notes: Note[] }>("/notes")).notes, []);
  return (
    <>
      <ListScreen<Note> title={t("nav.notes")} load={load} empty={t("m.notes.empty")} render={(n) => <NoteRow note={n} onOpen={setOpen} />} />
      <Modal visible={!!open} animationType="slide" onRequestClose={() => setOpen(null)} presentationStyle="pageSheet">
        <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: insets.bottom + 24 }}>
            <T weight="semibold" size={22}>
              {open?.title}
            </T>
            <Markdown text={open?.content ?? ""} />
            <Button title={t("common.close")} variant="secondary" onPress={() => setOpen(null)} />
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
