import { TalorysKeyboard } from "../../modules/talorys-keyboard";
import { keyboardSession } from "./keyboardSettings";
import { onSessionChange } from "./session";

/**
 * One login: the Android keyboard (IME, Ask sheet, companion, dictionary backup) uses exactly the
 * app's session. Every load / sign-in / sign-out / 401 is pushed to the native module, which keeps
 * it in the keyboard's encrypted preferences. No-op where the module does not exist (iOS, Expo Go).
 */
export function connectKeyboardSession(): () => void {
  const native = TalorysKeyboard;
  if (!native) return () => {};
  return onSessionChange((s) => {
    const { server, token } = keyboardSession(s);
    native.setSession(server, token);
  });
}
