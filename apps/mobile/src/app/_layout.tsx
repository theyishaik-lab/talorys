import { NavigationBar } from "expo-navigation-bar";
import * as Notifications from "expo-notifications";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ErrorBoundary, GlobalErrorOverlay } from "../components/ErrorScreen";
import { AuthProvider, useAuth } from "../lib/auth";
import { AppProviders, useAppPreferences } from "../lib/providers";
import { ensureChannels, targetOf } from "../lib/push";
import { palettes, useTheme } from "../lib/theme";

SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 250, fade: true });
// Whatever happens in JS, the splash never stays up for more than a few seconds.
const SPLASH_MAX_MS = 4000;
setTimeout(() => SplashScreen.hideAsync().catch(() => {}), SPLASH_MAX_MS);

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Root />
      <GlobalErrorOverlay />
    </ErrorBoundary>
  );
}

function Root() {
  const prefs = useAppPreferences();
  if (!prefs.ready) {
    // Plain, visible, and short-lived: useAppPreferences gives up on the stores after a timeout.
    return (
      <View style={{ flex: 1, backgroundColor: palettes.light.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#6B6B76", fontSize: 14 }}>Talorys…</Text>
      </View>
    );
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* Edge-to-edge: the bars are translucent, so keyboard heights are the full IME inset from the screen edge. */}
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent preserveEdgeToEdge>
        <AppProviders themeMode={prefs.themeMode} setThemeMode={prefs.setThemeMode} localePref={prefs.localePref} setLocalePref={prefs.setLocalePref}>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </AppProviders>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell() {
  const { c, scheme } = useTheme();
  const auth = useAuth();

  useEffect(() => {
    if (auth.ready) SplashScreen.hideAsync().catch(() => {});
  }, [auth.ready]);

  // A tap on a notification opens the chat it is about.
  useEffect(() => {
    ensureChannels().catch(() => {});
    const open = (response: Notifications.NotificationResponse) => {
      const { conversationId } = targetOf(response.notification.request.content.data as Record<string, unknown>);
      if (conversationId) router.push({ pathname: "/chat/[id]", params: { id: conversationId } });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync().then((r) => r && open(r)).catch(() => {});
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {Platform.OS === "android" ? <NavigationBar style={scheme === "dark" ? "light" : "dark"} /> : null}
      <Stack screenOptions={{ headerShown: false, animation: "slide_from_right", animationDuration: 220, contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Protected guard={auth.ready && !auth.authenticated}>
          <Stack.Screen name="login" options={{ animation: "fade" }} />
        </Stack.Protected>
        <Stack.Protected guard={auth.ready && auth.authenticated}>
          <Stack.Screen name="(main)" options={{ animation: "fade" }} />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/model" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/connections" />
          <Stack.Screen name="settings/account" />
          <Stack.Screen name="settings/about" />
          <Stack.Screen name="memory" />
          <Stack.Screen name="tasks" />
          <Stack.Screen name="notes" />
          <Stack.Screen name="automations" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
