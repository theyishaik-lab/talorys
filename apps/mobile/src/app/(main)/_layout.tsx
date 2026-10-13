import { Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Drawer } from "react-native-drawer-layout";
import { DrawerContent } from "../../components/DrawerContent";
import { DrawerContext } from "../../lib/drawer";
import { useI18n } from "../../lib/i18n";
import { useTheme } from "../../lib/theme";

/**
 * The chat shell: a native gesture drawer (chat history + pages) around the chat stack.
 * It opens from the start edge, which is the right in Hebrew (the whole app is RTL then).
 */
export default function MainLayout() {
  const { c } = useTheme();
  const { rtl } = useI18n();
  const [open, setOpen] = useState(false);
  const api = useMemo(() => ({ open: () => setOpen(true), close: () => setOpen(false) }), []);
  const render = useCallback(() => <DrawerContent onClose={api.close} />, [api]);
  return (
    <DrawerContext.Provider value={api}>
      <Drawer
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        renderDrawerContent={render}
        drawerPosition={rtl ? "right" : "left"}
        drawerType="front"
        drawerStyle={{ width: 300, backgroundColor: c.surface }}
        overlayStyle={{ backgroundColor: c.scrim }}
        swipeEdgeWidth={48}
      >
        <Stack screenOptions={{ headerShown: false, animation: "fade", animationDuration: 150, contentStyle: { backgroundColor: c.bg } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="chat/[id]" />
        </Stack>
      </Drawer>
    </DrawerContext.Provider>
  );
}
