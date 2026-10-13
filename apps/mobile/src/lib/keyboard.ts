/**
 * Keyboard layout math, kept free of native imports so it is unit-testable.
 *
 * Android 15+ (and every Expo SDK 57 build) draws edge-to-edge: the window is NOT resized when the
 * keyboard opens, whatever `windowSoftInputMode` says — the keyboard is drawn on top of the app and
 * reported only as an IME inset. So the app has to make room itself. The chat column is
 * `[header][list flex:1][composer][spacer]`; the spacer's height is the one number that decides
 * where the composer sits.
 *
 * `keyboardHeight` is the IME inset measured from the bottom edge of the screen (the
 * KeyboardProvider is told the navigation bar is translucent, so it reports the full inset, which
 * already covers the gesture pill / 3-button bar). `safeBottom` is the navigation-bar inset.
 * Keyboard closed → the composer clears the navigation bar; keyboard open → it sits flush on the
 * keyboard's top edge, no gap and no overlap.
 */
export function composerBottomSpace(keyboardHeight: number, safeBottom: number): number {
  "worklet";
  const kb = keyboardHeight > 0 ? keyboardHeight : 0;
  const nav = safeBottom > 0 ? safeBottom : 0;
  return kb > nav ? kb : nav;
}

/** How close (dp) to the end of the chat counts as "reading the latest message" — keep it pinned. */
export const STICK_TO_BOTTOM_DP = 96;

/** True when the list is scrolled to (or within `threshold` of) its end. */
export function isNearBottom(offsetY: number, viewportHeight: number, contentHeight: number, threshold = STICK_TO_BOTTOM_DP): boolean {
  return contentHeight - (offsetY + viewportHeight) <= threshold;
}
