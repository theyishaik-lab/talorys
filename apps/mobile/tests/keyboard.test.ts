import appJson from "../app.json?raw";
import rootLayout from "../src/app/_layout.tsx?raw";
import loginScreen from "../src/app/login.tsx?raw";
import chatScreen from "../src/components/ChatScreen.tsx?raw";
import screen from "../src/components/Screen.tsx?raw";
import { describe, expect, it } from "vitest";
import { composerBottomSpace, isNearBottom } from "../src/lib/keyboard";

/**
 * Oct 13, 2026, v0.1.1 on a Pixel 9 Pro (Android 16): "when the keyboard is open you can't see the
 * text box". Android 15+ is edge-to-edge: the window is no longer resized for the keyboard, so the
 * old `KeyboardAvoidingView behavior={undefined}` left the composer under it.
 *
 * No emulator on the build box, so this lays out the chat column the way Yoga does (a column:
 * fixed header, list flex:1, composer, spacer) on a Pixel 9 Pro's screen with the keyboard's real
 * inset, and checks where the composer lands.
 */
const PIXEL_9_PRO = { height: 915, statusBar: 49 }; // dp, portrait (1280x2856 @ 3.125)
const GESTURE_NAV = 24; // dp, the gesture-pill inset
const THREE_BUTTON_NAV = 48;
const GBOARD = 336; // dp, Gboard's IME inset incl. its suggestion strip and the nav area under it

function layoutChat(keyboardInset: number, navInset: number, composerHeight = 62) {
  const header = 52;
  const spacer = composerBottomSpace(keyboardInset, navInset);
  const top = PIXEL_9_PRO.statusBar + header;
  const list = PIXEL_9_PRO.height - top - composerHeight - spacer; // the flex:1 child takes the rest
  const composerTop = top + list;
  const composerBottom = composerTop + composerHeight;
  const keyboardTop = PIXEL_9_PRO.height - keyboardInset;
  return { list, composerTop, composerBottom, keyboardTop, spacer };
}

describe("composer vs. keyboard (edge-to-edge layout)", () => {
  it.each([
    ["gesture navigation", GESTURE_NAV],
    ["3-button navigation", THREE_BUTTON_NAV],
  ])("keyboard open, %s: the composer sits flush on the keyboard", (_name, nav) => {
    const l = layoutChat(GBOARD, nav);
    expect(l.composerBottom).toBe(l.keyboardTop); // no overlap, no gap
    expect(l.list).toBeGreaterThan(200); // the latest messages stay visible above it
  });

  it.each([
    ["gesture navigation", GESTURE_NAV],
    ["3-button navigation", THREE_BUTTON_NAV],
  ])("keyboard closed, %s: the composer clears the navigation bar", (_name, nav) => {
    const l = layoutChat(0, nav);
    expect(l.composerBottom).toBe(PIXEL_9_PRO.height - nav);
  });

  it("follows the keyboard frame by frame while it animates (never under it)", () => {
    for (let inset = 0; inset <= GBOARD; inset += 12) {
      const l = layoutChat(inset, GESTURE_NAV);
      expect(l.composerBottom).toBeLessThanOrEqual(l.keyboardTop);
      expect(l.composerBottom).toBe(Math.min(l.keyboardTop, PIXEL_9_PRO.height - GESTURE_NAV));
    }
  });

  it("a growing multi-line input grows upward: the list gives up the room, the bottom stays on the keyboard", () => {
    const one = layoutChat(GBOARD, GESTURE_NAV, 62);
    const five = layoutChat(GBOARD, GESTURE_NAV, 62 + 4 * 21);
    expect(five.composerBottom).toBe(one.composerBottom);
    expect(five.composerTop).toBe(one.composerTop - 4 * 21);
    expect(five.list).toBe(one.list - 4 * 21);
  });

  it("ignores negative insets (hide animation overshoot)", () => {
    expect(composerBottomSpace(-5, 24)).toBe(24);
    expect(composerBottomSpace(0, -1)).toBe(0);
  });
});

describe("staying at the latest message", () => {
  it("near the end counts as pinned; reading older messages does not", () => {
    expect(isNearBottom(1000, 600, 1650)).toBe(true);
    expect(isNearBottom(200, 600, 1650)).toBe(false);
  });
});

describe("wiring (the parts a unit test cannot render)", () => {
  const files: Record<string, string> = {
    "app.json": appJson,
    "src/app/_layout.tsx": rootLayout,
    "src/app/login.tsx": loginScreen,
    "src/components/ChatScreen.tsx": chatScreen,
    "src/components/Screen.tsx": screen,
  };
  const src = (p: string) => files[p]!;
  it("the chat screen no longer relies on React Native's KeyboardAvoidingView", () => {
    const chat = src("src/components/ChatScreen.tsx");
    expect(chat).not.toMatch(/import\s*{[^}]*KeyboardAvoidingView[^}]*}\s*from "react-native"/);
    expect(chat).toContain("<KeyboardSpacer safeBottom={insets.bottom}");
    expect(chat).toMatch(/onLayout=\{onListLayout\}/);
  });
  it("the provider reports the full IME inset (translucent bars, edge-to-edge kept)", () => {
    expect(src("src/app/_layout.tsx")).toMatch(/<KeyboardProvider statusBarTranslucent navigationBarTranslucent preserveEdgeToEdge>/);
  });
  it("login and settings screens scroll the focused field above the keyboard", () => {
    expect(src("src/app/login.tsx")).toContain("<KeyboardAwareScrollView");
    expect(src("src/components/Screen.tsx")).toContain("<KeyboardAwareScrollView");
  });
  it("the manifest still asks for adjustResize", () => {
    const app = JSON.parse(src("app.json"));
    expect(app.expo.android.softwareKeyboardLayoutMode).toBe("resize");
  });
});
