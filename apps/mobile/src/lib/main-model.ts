import { api } from "./api";
import { createStore } from "./store";

/** The main model from settings (the chain's first entry): what the chat header shows before any reply. */
export const mainModelStore = createStore<{ provider: string; model: string } | null>(null);

/** Refreshes it; keeps the last known value when the agent cannot be reached. */
export async function loadMainModel(): Promise<void> {
  try {
    const r = await api<{ settings: { modelProvider?: string; model?: string } }>("/settings");
    const { modelProvider, model } = r.settings ?? {};
    if (model) mainModelStore.set((prev) => (prev?.model === model && prev.provider === (modelProvider ?? "") ? prev : { provider: modelProvider ?? "", model }));
  } catch {
    /* the header falls back to the last reply's model */
  }
}
