import type { Memory, MemoryCategory } from "@talorys/shared";
import { Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, TextInput, ToastAndroid, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ListScreen } from "../components/ListScreen";
import { Button, Card, Chip, Icon, IconButton, Press, T, useFont } from "../components/ui";
import { api } from "../lib/api";
import { firstStrongDirection, useI18n } from "../lib/i18n";
import { canSaveMemory, initialMemoryDraft, MEMORY_MAX_CHARS, type MemoryEditTarget, type MemoryWriteResponse, memorySaveRequest, memoryWriteMessage } from "../lib/memoryEdit";
import { MEMORY_CATEGORIES } from "../lib/shared";
import { radii, useTheme } from "../lib/theme";

const MemoryRow = memo(function MemoryRow({ memory, reload, onEdit }: { memory: Memory; reload: () => void; onEdit: (m: Memory) => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const remove = () =>
    Alert.alert(t("m.deleteConfirm", { title: memory.content.slice(0, 40) }), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => {
          await api(`/memories/${memory.id}`, { method: "DELETE" }).catch(() => {});
          reload();
        },
      },
    ]);
  // Core memory (always shown to the AI) is changed only by the owner; a full core memory answers with an error.
  const togglePin = async () => {
    try {
      await api(`/memories/${memory.id}/pin`, { method: "POST", body: { pinned: !memory.pinned } });
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : "Failed");
    }
    reload();
  };
  return (
    <Press onPress={() => onEdit(memory)} scale={0.99} accessibilityRole="button" accessibilityHint={t("m.memory.editHint")}>
      <Card style={{ gap: 8 }}>
        <T>{memory.content}</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {memory.pinned ? <Chip label={t("m.memory.core")} color={c.accent} /> : null}
          <Chip label={t(`m.memory.cat.${memory.category}` as "m.memory.cat.other")} />
          {memory.status !== "active" ? <Chip label={t(`m.memory.status.${memory.status}` as "m.memory.status.historical")} color={c.warning} /> : null}
          {memory.source === "dream" ? <Chip label={t("m.memory.learned")} /> : null}
          <View style={{ flex: 1 }} />
          <Press onPress={() => onEdit(memory)} hitSlop={8} accessibilityLabel={t("m.memory.edit")}>
            <Icon icon={Pencil} size={16} color={c.fgFaint} />
          </Press>
          <Press onPress={togglePin} hitSlop={8} accessibilityLabel={memory.pinned ? t("m.memory.unpin") : t("m.memory.pin")}>
            <Icon icon={memory.pinned ? PinOff : Pin} size={16} color={memory.pinned ? c.accent : c.fgFaint} />
          </Press>
          <Press onPress={remove} hitSlop={8} accessibilityLabel={t("common.delete")}>
            <Icon icon={Trash2} size={16} color={c.fgFaint} />
          </Press>
        </View>
      </Card>
    </Press>
  );
});

/** Add / edit sheet: multiline text + category, saved with POST /memories or PATCH /memories/:id (same as the web editor). */
function MemoryEditor({ target, onClose, onSaved }: { target: MemoryEditTarget | null; onClose: () => void; onSaved: () => void }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("preference");
  const [busy, setBusy] = useState(false);
  const reset = () => {
    if (!target) return;
    const draft = initialMemoryDraft(target);
    setContent(draft.content);
    setCategory(draft.category);
  };
  const save = async () => {
    if (!target || !canSaveMemory(target, content, category)) return;
    const req = memorySaveRequest(target, content, category);
    setBusy(true);
    try {
      const r = await api<MemoryWriteResponse>(req.path, { method: req.method, body: req.body });
      const msg = memoryWriteMessage(r, t);
      // A possible conflict needs the owner's attention, so it gets a dialog rather than a passing toast.
      if (r.reviews) Alert.alert(msg);
      else ToastAndroid.show(msg, ToastAndroid.SHORT);
      onSaved();
      onClose();
    } catch (e) {
      Alert.alert(t("m.memory.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  const dir = firstStrongDirection(content, rtl ? "rtl" : "ltr");
  const ok = !!target && canSaveMemory(target, content, category);
  return (
    <Modal visible={!!target} animationType="slide" onRequestClose={onClose} onShow={reset} presentationStyle="pageSheet">
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
        <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 }}>
          <T weight="semibold" size={17} style={{ flex: 1 }} numberOfLines={1}>
            {target === "new" ? t("m.memory.add") : t("m.memory.edit")}
          </T>
          <Button title={t("common.cancel")} small variant="ghost" onPress={onClose} />
          <Button title={t("common.save")} small loading={busy} disabled={!ok} onPress={save} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}>
          <View style={{ gap: 6 }}>
            <T size={13} muted weight="medium">
              {t("m.memory.whatRemember")}
            </T>
            <TextInput
              value={content}
              onChangeText={setContent}
              placeholder={t("m.memory.placeholder")}
              placeholderTextColor={c.fgFaint}
              multiline
              autoFocus
              maxLength={MEMORY_MAX_CHARS}
              accessibilityLabel={t("m.memory.whatRemember")}
              style={{
                fontFamily: font,
                fontSize: 16,
                lineHeight: 24,
                color: c.fg,
                backgroundColor: c.surface,
                borderRadius: radii.sm,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: c.border,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 120,
                textAlignVertical: "top",
                textAlign: dir === "rtl" ? "right" : "left",
                writingDirection: dir,
              }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              {target && target !== "new" ? (
                <T size={12} muted style={{ flex: 1 }}>
                  {t("m.memory.typoHint")}
                </T>
              ) : (
                <View style={{ flex: 1 }} />
              )}
              <T size={12} muted>
                {t("m.memory.chars", { n: content.length, max: MEMORY_MAX_CHARS })}
              </T>
            </View>
          </View>
          <View style={{ gap: 8 }}>
            <T size={13} muted weight="medium">
              {t("m.memory.category")}
            </T>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
              {MEMORY_CATEGORIES.map((cat) => {
                const on = cat === category;
                return (
                  <Press
                    key={cat}
                    onPress={() => setCategory(cat)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: on ? c.fg : c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: on ? c.fg : c.border }}
                  >
                    <T size={13} weight="medium" color={on ? c.bg : c.fg}>
                      {t(`m.memory.cat.${cat}` as "m.memory.cat.other")}
                    </T>
                  </Press>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

export default function MemoryScreen() {
  const { t } = useI18n();
  const [editing, setEditing] = useState<MemoryEditTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const load = useCallback(async () => {
    const { memories } = await api<{ memories: Memory[] }>("/memories?status=active");
    // Core memory first, then the rest in the server's order.
    return [...memories.filter((m) => m.pinned), ...memories.filter((m) => !m.pinned)];
  }, []);
  return (
    <>
      <ListScreen<Memory>
        title={t("nav.memory")}
        load={load}
        empty={t("m.memory.empty")}
        refreshKey={refreshKey}
        right={<IconButton icon={Plus} onPress={() => setEditing("new")} label={t("m.memory.add")} />}
        render={(m, reload) => <MemoryRow memory={m} reload={reload} onEdit={setEditing} />}
      />
      <MemoryEditor target={editing} onClose={() => setEditing(null)} onSaved={() => setRefreshKey((k) => k + 1)} />
    </>
  );
}
