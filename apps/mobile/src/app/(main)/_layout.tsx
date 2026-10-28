import { Tabs } from "expo-router";
import { FolderKanban, House, MessageCircle } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { unreadStore } from "../../lib/home";
import { useI18n } from "../../lib/i18n";
import { TAB_BAR_HEIGHT } from "../../lib/keyboard";
import { useStore } from "../../lib/store";
import { fonts, useTheme } from "../../lib/theme";

/**
 * The app shell: three bottom tabs, Home · Chat · Projects (like the Hark app). Settings is reached
 * from Home's header. Pushed screens (threads, a project, settings) open over the tabs from the
 * root stack, so Android Back returns to the tab they came from. In Hebrew the whole row mirrors.
 */
export default function TabsLayout() {
  const { c } = useTheme();
  const { t, locale } = useI18n();
  const insets = useSafeAreaInsets();
  const unread = useStore(unreadStore);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.fg,
        tabBarInactiveTintColor: c.fgFaint,
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border, height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily: fonts[locale].medium, fontSize: 12 },
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabs.home"),
          tabBarIcon: ({ color, size }) => <House color={color} size={size - 2} strokeWidth={1.9} />,
          tabBarBadge: unread > 0 ? (unread > 9 ? "9+" : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: c.accent, color: c.accentFg, fontSize: 10 },
        }}
      />
      <Tabs.Screen name="chat" options={{ title: t("tabs.chat"), tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size - 2} strokeWidth={1.9} /> }} />
      <Tabs.Screen name="projects" options={{ title: t("tabs.projects"), tabBarIcon: ({ color, size }) => <FolderKanban color={color} size={size - 2} strokeWidth={1.9} /> }} />
    </Tabs>
  );
}
