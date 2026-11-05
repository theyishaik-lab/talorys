import { TalorysLocalLlm } from "../../modules/talorys-local-llm";
import { setOfflineResponder } from "./chat";
import { offlineRequest, pickOfflineModel } from "./localModels";
import { readLocalePreference, resolveLocale } from "./i18n";

/**
 * Registers the chat's offline fallback (docs/local-models.md): when the agent is unreachable and
 * Settings → Local models → "Offline fallback" is on, the chosen downloaded model answers on the phone.
 * No-op where the native module does not exist.
 */
export function registerOfflineChat(): void {
  const native = TalorysLocalLlm;
  if (!native) return;
  setOfflineResponder(async ({ history, text, onDelta, signal }) => {
    const settings = native.getSettings();
    if (!settings.offlineFallback) return null;
    const model = pickOfflineModel(native.getModels(), settings.offlineModel);
    if (!model) return null;
    const locale = resolveLocale(await readLocalePreference());
    const req = offlineRequest(model.id, history, text, locale);
    const requestId = `offline-${Date.now()}`;
    const sub = native.addListener("onToken", (e) => {
      if (e.requestId === requestId && e.delta) onDelta(e.delta);
    });
    const onAbort = () => native.cancel(requestId);
    signal.addEventListener("abort", onAbort);
    try {
      await native.generate(requestId, model.id, req.system, req.messages, req.maxOutputTokens);
    } catch (error) {
      // A stop keeps what arrived; anything else is the reply's error.
      if (!signal.aborted) throw error;
    } finally {
      sub.remove();
      signal.removeEventListener("abort", onAbort);
    }
    return { model: model.id };
  });
}
