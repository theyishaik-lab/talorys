import { useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { composerBottomSpace } from "../lib/keyboard";

/**
 * The bottom spacer under the chat composer. Follows the keyboard frame by frame (on the UI thread,
 * driven by the IME inset animation), so the composer rides directly on top of the keyboard on
 * Android 15+ edge-to-edge, where the window no longer shrinks for the keyboard.
 */
export function KeyboardSpacer({ safeBottom, color, offset = 0 }: { safeBottom: number; color: string; offset?: number }) {
  const keyboard = useSharedValue(0);
  useKeyboardHandler(
    {
      onMove: (e) => {
        "worklet";
        keyboard.set(e.height);
      },
      onInteractive: (e) => {
        "worklet";
        keyboard.set(e.height);
      },
      onEnd: (e) => {
        "worklet";
        keyboard.set(e.height);
      },
    },
    [],
  );
  const style = useAnimatedStyle(() => ({ height: composerBottomSpace(keyboard.get(), safeBottom, offset) }), [safeBottom, offset]);
  return <Animated.View style={[{ backgroundColor: color }, style]} />;
}
