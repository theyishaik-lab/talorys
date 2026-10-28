import { createStore } from "./store";

/** Text waiting to be put in a chat's composer (a suggestion accepted on Home), by conversation id. */
export const prefillStore = createStore<{ conversationId: string; text: string } | null>(null);

export function prefill(conversationId: string, text: string): void {
  prefillStore.set({ conversationId, text });
}

/** Takes the pending text for this conversation, once. */
export function takePrefill(conversationId: string): string | null {
  const p = prefillStore.get();
  if (!p || p.conversationId !== conversationId) return null;
  prefillStore.set(null);
  return p.text;
}
