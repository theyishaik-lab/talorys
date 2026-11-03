import * as Notifications from "expo-notifications";
import { router, useFocusEffect } from "expo-router";
import { CheckCircle2, Circle, ClipboardList, Download, Minus, Plus, RefreshCw, ScanText, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, RadioRow, Row, ToggleRow } from "../../components/SettingsList";
import { Button, IconButton, T } from "../../components/ui";
import { type DictionaryStatus, type KeyboardConstants, type KeyboardPreferences, type KeyboardStatus, TalorysKeyboard } from "../../../modules/talorys-keyboard";
import { useI18n } from "../../lib/i18n";
import { KEY_HEIGHT_LABELS, dictionarySummary, expiryLabel, hapticLabel, isReady, keyHeightPresetIndex, setupSteps, stepKeyHeight, stepVolume } from "../../lib/keyboardSettings";
import { useTheme } from "../../lib/theme";

/** Settings → Keyboard: setup checklist and every preference of the built-in Android keyboard. */
export default function KeyboardSettingsScreen() {
  const { t } = useI18n();
  const native = TalorysKeyboard;
  if (!native) {
    return (
      <Screen title={t("kb.title")}>
        <T muted>{t("kb.unavailable")}</T>
      </Screen>
    );
  }
  return <KeyboardSettings native={native} />;
}

function KeyboardSettings({ native }: { native: NonNullable<typeof TalorysKeyboard> }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const [constants] = useState<KeyboardConstants>(() => native.getConstants());
  const [status, setStatus] = useState<KeyboardStatus>(() => native.getStatus());
  const [prefs, setPrefs] = useState<KeyboardPreferences>(() => native.getPreferences());
  const [dict, setDict] = useState<DictionaryStatus>(() => native.getDictionaryStatus());
  const [busy, setBusy] = useState<"sync" | "restore" | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(() => {
    setStatus(native.getStatus());
    setPrefs(native.getPreferences());
    setDict(native.getDictionaryStatus());
  }, [native]);

  // Back from the system keyboard list / picker / accessibility page: re-read the setup state.
  useFocusEffect(refresh);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const set = (values: Partial<KeyboardPreferences>) => setPrefs(native.setPreferences(values));

  const setAlwaysOn = async (on: boolean) => {
    // The foreground companion shows a (silent) notification; ask once, it runs either way.
    if (on) await Notifications.requestPermissionsAsync().catch(() => null);
    set({ alwaysOn: on });
  };

  const setScreenLearning = (on: boolean) => {
    if (!on) return set({ screenLearning: false });
    Alert.alert(t("kb.screen.enable"), t("kb.screen.confirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("kb.screen.confirmOk"), onPress: () => set({ screenLearning: true }) },
    ]);
  };

  const runDict = async (kind: "sync" | "restore") => {
    setBusy(kind);
    setNote(null);
    try {
      const d = kind === "sync" ? await native.syncDictionary() : await native.restoreDictionary();
      setDict(d);
      setNote({ text: kind === "sync" ? t("kb.words.syncOk") : t("kb.words.restoreOk", { n: d.learnedWords }), ok: true });
    } catch (e) {
      setNote({ text: t("kb.words.failed", { error: e instanceof Error ? e.message : "?" }), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const clearLearned = () =>
    Alert.alert(t("kb.words.clear"), t("kb.words.clearConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("kb.words.clear"),
        style: "destructive",
        onPress: () => {
          native.clearLearnedWords();
          setDict(native.getDictionaryStatus());
        },
      },
    ]);

  const steps = setupSteps(status);
  const presetIndex = keyHeightPresetIndex(prefs.keyHeightDp, constants.keyHeightPresets);
  const haptic = hapticLabel(prefs.hapticStrength);
  const summary = dictionarySummary(dict);

  return (
    <Screen title={t("kb.title")}>
      <Group title={t("kb.setup")} footer={status.signedIn ? (isReady(status) ? t("kb.setup.ready") : t("kb.setup.footer")) : t("kb.setup.signedOut")}>
        {steps.map((s, i) => (
          <Row
            key={s.key}
            icon={s.done ? CheckCircle2 : Circle}
            title={t(s.title) + (s.optional ? ` · ${t("kb.optional")}` : "")}
            subtitle={t(s.hint)}
            last={i === steps.length - 1}
            right={
              s.done && s.key !== "select" ? undefined : (
                <Button small variant={s.done ? "ghost" : "secondary"} title={t(s.actionLabel)} disabled={!s.actionEnabled} onPress={() => native[s.action]()} />
              )
            }
          />
        ))}
      </Group>

      <Group title={t("kb.typing")}>
        <ToggleRow title={t("kb.wordSuggestions")} value={prefs.wordSuggestions} onChange={(v) => set({ wordSuggestions: v })} />
        <ToggleRow title={t("kb.autocorrect")} subtitle={t("kb.autocorrectHint")} value={prefs.autocorrect} onChange={(v) => set({ autocorrect: v })} />
        <ToggleRow title={t("kb.emojiSuggestions")} value={prefs.emojiSuggestions} onChange={(v) => set({ emojiSuggestions: v })} />
        <ToggleRow title={t("kb.swipe")} subtitle={t("kb.swipeHint")} value={prefs.swipe} onChange={(v) => set({ swipe: v })} />
        <ToggleRow title={t("kb.keyPreviews")} value={prefs.keyPreviews} onChange={(v) => set({ keyPreviews: v })} />
        <ToggleRow title={t("kb.showHints")} subtitle={t("kb.showHintsHint")} value={prefs.showHints} onChange={(v) => set({ showHints: v })} last />
      </Group>

      <Group title={t("kb.language")} footer={t("kb.languageHint")}>
        <RadioRow title={t("kb.language.system")} selected={prefs.language === ""} onPress={() => set({ language: "" })} />
        <RadioRow title="English" selected={prefs.language === "en"} onPress={() => set({ language: "en" })} />
        <RadioRow title="עברית" selected={prefs.language === "he"} onPress={() => set({ language: "he" })} last />
      </Group>

      <Group title={t("kb.keyHeight")} footer={t("kb.keyHeightHint")}>
        {constants.keyHeightPresets.map((h, i) => (
          <RadioRow key={h} title={t(KEY_HEIGHT_LABELS[i] ?? "kb.keyHeight.normal")} subtitle={t("kb.dp", { n: h })} selected={presetIndex === i} onPress={() => set({ keyHeightDp: h })} />
        ))}
        <Row
          title={t("kb.keyHeight.custom")}
          value={t("kb.dp", { n: Math.round(prefs.keyHeightDp) })}
          last
          right={
            <View style={{ flexDirection: "row" }}>
              <IconButton icon={Minus} label={t("kb.decrease")} onPress={() => set({ keyHeightDp: stepKeyHeight(prefs.keyHeightDp, -1, constants.minKeyHeight, constants.maxKeyHeight) })} />
              <IconButton icon={Plus} label={t("kb.increase")} onPress={() => set({ keyHeightDp: stepKeyHeight(prefs.keyHeightDp, 1, constants.minKeyHeight, constants.maxKeyHeight) })} />
            </View>
          }
        />
      </Group>

      <Group title={t("kb.look")}>
        <RadioRow title={t("settings.theme.auto")} selected={prefs.theme === "system"} onPress={() => set({ theme: "system" })} />
        <RadioRow title={t("settings.theme.light")} selected={prefs.theme === "light"} onPress={() => set({ theme: "light" })} />
        <RadioRow title={t("settings.theme.dark")} selected={prefs.theme === "dark"} onPress={() => set({ theme: "dark" })} />
        <ToggleRow title={t("kb.dynamicColor")} subtitle={constants.dynamicColorAvailable ? t("kb.dynamicColorHint") : t("kb.dynamicColorUnavailable")} value={prefs.dynamicColor && constants.dynamicColorAvailable} disabled={!constants.dynamicColorAvailable} onChange={(v) => set({ dynamicColor: v })} last />
      </Group>

      <Group title={t("kb.oneHanded")}>
        <RadioRow title={t("kb.oneHanded.off")} selected={prefs.oneHanded === 0} onPress={() => set({ oneHanded: 0 })} />
        <RadioRow title={t("kb.oneHanded.left")} selected={prefs.oneHanded === -1} onPress={() => set({ oneHanded: -1 })} />
        <RadioRow title={t("kb.oneHanded.right")} selected={prefs.oneHanded === 1} onPress={() => set({ oneHanded: 1 })} last />
      </Group>

      <Group title={t("kb.feedback")}>
        <Row
          title={t("kb.haptics")}
          value={t(haptic.key, { n: haptic.level })}
          right={
            <View style={{ flexDirection: "row" }}>
              <IconButton icon={Minus} label={t("kb.decrease")} onPress={() => set({ hapticStrength: Math.max(0, prefs.hapticStrength - 1) })} />
              <IconButton icon={Plus} label={t("kb.increase")} onPress={() => set({ hapticStrength: Math.min(5, prefs.hapticStrength + 1) })} />
            </View>
          }
        />
        <ToggleRow title={t("kb.hapticSystem")} subtitle={t("kb.hapticSystemHint")} value={prefs.hapticSystem} onChange={(v) => set({ hapticSystem: v })} />
        <ToggleRow title={t("kb.sound")} value={prefs.sound} onChange={(v) => set({ sound: v })} />
        <Row
          title={t("kb.soundVolume")}
          value={`${Math.round(prefs.soundVolume * 100)}%`}
          last
          right={
            <View style={{ flexDirection: "row", opacity: prefs.sound ? 1 : 0.4 }}>
              <IconButton icon={Minus} label={t("kb.decrease")} onPress={() => set({ soundVolume: stepVolume(prefs.soundVolume, -0.1) })} />
              <IconButton icon={Plus} label={t("kb.increase")} onPress={() => set({ soundVolume: stepVolume(prefs.soundVolume, 0.1) })} />
            </View>
          }
        />
      </Group>

      <Group title={t("kb.clip")} footer={t("kb.clip.hint")}>
        <ToggleRow title={t("kb.clip.history")} value={prefs.clipboardHistory} onChange={(v) => set({ clipboardHistory: v })} />
        {prefs.clipboardHistory
          ? constants.clipboardExpiryChoices.map((ms) => (
              <RadioRow key={ms} title={t("kb.clip.keep", { time: t(expiryLabel(ms)) })} selected={prefs.clipboardExpiryMs === ms} onPress={() => set({ clipboardExpiryMs: ms })} />
            ))
          : null}
        <Row icon={ClipboardList} title={t("kb.clip.view")} chevron last onPress={() => router.push("/settings/keyboard-clipboard")} />
      </Group>

      <Group title={t("kb.words")} footer={t(summary.key, summary.vars)}>
        <ToggleRow title={t("kb.words.backup")} subtitle={t("kb.words.backupHint")} value={prefs.cloudBackup} disabled={!dict.signedIn} onChange={(v) => set({ cloudBackup: v })} />
        <Row icon={RefreshCw} title={t("kb.words.syncNow")} onPress={dict.signedIn && prefs.cloudBackup && !busy ? () => runDict("sync") : undefined} />
        <Row icon={Download} title={t("kb.words.restore")} subtitle={t("kb.words.restoreHint")} onPress={dict.signedIn && !busy ? () => runDict("restore") : undefined} />
        <Row icon={Trash2} title={t("kb.words.clear")} danger last onPress={clearLearned} />
      </Group>
      {note ? (
        <T size={13} color={note.ok ? c.success : c.danger}>
          {note.text}
        </T>
      ) : null}

      <Group title={t("kb.screen")} footer={!prefs.screenLearning ? t("kb.screen.statusOff") : status.accessibilityEnabled ? t("kb.screen.statusOn") : t("kb.screen.statusNeedsService")}>
        <ToggleRow title={t("kb.screen.enable")} subtitle={t("kb.screen.privacy")} value={prefs.screenLearning} onChange={setScreenLearning} />
        <ToggleRow title={t("kb.screen.backup")} subtitle={t("kb.screen.backupHint")} value={prefs.screenBackup} onChange={(v) => set({ screenBackup: v })} />
        <Row icon={ScanText} title={t("kb.screen.manage")} subtitle={t("kb.screen.manageHint")} chevron last onPress={() => router.push("/settings/keyboard-words")} />
      </Group>

      <Group title={t("kb.agent")} footer={t("kb.alwaysOnHint")}>
        <ToggleRow title={t("kb.alwaysOn")} value={prefs.alwaysOn} onChange={setAlwaysOn} last />
      </Group>
    </Screen>
  );
}
