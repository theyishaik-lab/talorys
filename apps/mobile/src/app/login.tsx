import { Eye, EyeOff, Lock } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { normalizeServer } from "../lib/session";
import { radii, useTheme } from "../lib/theme";
import { Button, Icon, Press, T, useFont } from "../components/ui";
import { Logo } from "../components/Logo";

export default function LoginScreen() {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const font = useFont();
  const [server, setServer] = useState(auth.server);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(!auth.server);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(normalizeServer(server), password);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setError(t("m.wrongPassword"));
      else if (e instanceof ApiError && e.status === 429) setError(t("login.rateLimited"));
      else if (e instanceof ApiError && e.status === 0) setError(t("m.cantReach"));
      else setError(e instanceof Error ? e.message : t("login.failed"));
    } finally {
      setBusy(false);
    }
  };

  const input = { fontFamily: font, fontSize: 16, color: c.fg, backgroundColor: c.surface, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: c.border, textAlign: rtl ? ("right" as const) : ("left" as const) };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", gap: 10, marginBottom: 16 }}>
          <Logo size={64} />
          <T weight="semibold" size={22} style={{ letterSpacing: 2 }}>
            TALORYS
          </T>
          <T muted center>
            {t("login.tagline")}
          </T>
        </View>
        {showServer ? (
          <View style={{ gap: 6 }}>
            <T size={13} muted>
              {t("m.serverUrl")}
            </T>
            <TextInput value={server} onChangeText={setServer} placeholder="https://your-talorys.pages.dev" placeholderTextColor={c.fgFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={input} />
            <T size={12} muted>
              {t("m.serverHint")}
            </T>
          </View>
        ) : (
          <Press onPress={() => setShowServer(true)} style={{ alignSelf: "center" }}>
            <T size={13} muted>
              {server.replace(/^https?:\/\//, "")}
            </T>
          </Press>
        )}
        <View style={{ gap: 6 }}>
          <T size={13} muted>
            {t("login.password")}
          </T>
          <View style={{ position: "relative" }}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={t("login.placeholder")}
              placeholderTextColor={c.fgFaint}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              onSubmitEditing={submit}
              returnKeyType="go"
              style={[input, { paddingEnd: 48 }]}
            />
            <Press onPress={() => setShow((s) => !s)} accessibilityLabel={show ? t("login.hide") : t("login.show")} style={{ position: "absolute", insetInlineEnd: 8, top: 0, bottom: 0, width: 40, alignItems: "center", justifyContent: "center" }}>
              <Icon icon={show ? EyeOff : Eye} size={18} />
            </Press>
          </View>
        </View>
        {error ? (
          <T size={14} color={c.danger}>
            {error}
          </T>
        ) : null}
        <Button title={busy ? t("m.signingIn") : t("login.unlock")} icon={Lock} onPress={submit} loading={busy} disabled={!password} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export const styles = StyleSheet.create({});
