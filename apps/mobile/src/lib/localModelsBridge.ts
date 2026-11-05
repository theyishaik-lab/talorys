import { AppState } from "react-native";
import { TalorysLocalLlm } from "../../modules/talorys-local-llm";
import { onSessionChange } from "./session";

/**
 * Keeps the native module in step with the app: the session (for the device bridge) and whether the
 * app is in the foreground (the bridge stays open only then, unless the background option is on).
 * No-op where the module does not exist.
 */
export function connectLocalModels(): () => void {
  const native = TalorysLocalLlm;
  if (!native) return () => {};
  const off = onSessionChange((s) => {
    native.setSession(s.token ? s.server : null, s.token);
  });
  native.setForeground(AppState.currentState === "active");
  const sub = AppState.addEventListener("change", (state) => native.setForeground(state === "active"));
  return () => {
    off();
    sub.remove();
  };
}
