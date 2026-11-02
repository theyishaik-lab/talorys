import type { Services } from "../services/container";

export const DREAM_AUTOMATION_NAME = "Talorys memory dreaming";
/** Owner-local time of the nightly pass (Settings → timezone). */
export const DREAM_TIME = "03:00";

/**
 * Keeps one managed nightly automation in line with Settings → AI → "Learn overnight"
 * (memoryHistory.dreaming, default on). Mirrors proactive/schedule.ts.
 */
export async function syncDreamSchedule(services: Services): Promise<void> {
  const enabled = services.settings.get().memoryHistory.dreaming;
  const managed = services.automations.list().filter((a) => a.kind === "memory_dream" && a.name === DREAM_AUTOMATION_NAME);
  const [existing, ...duplicates] = managed;
  for (const duplicate of duplicates) await services.automations.delete(duplicate.id);
  if (!enabled) {
    if (existing?.enabled) await services.automations.update(existing.id, { enabled: false });
    return;
  }
  const schedule = { type: "daily" as const, time: DREAM_TIME };
  if (!existing) {
    await services.automations.create({ name: DREAM_AUTOMATION_NAME, kind: "memory_dream", message: "", enabled: true, schedule });
  } else if (!existing.enabled || existing.schedule.type !== "daily" || existing.schedule.time !== DREAM_TIME) {
    await services.automations.update(existing.id, { enabled: true, schedule });
  }
}

/** The next nightly pass (ISO), when scheduled. */
export function nextDreamRun(services: Services): string | null {
  const a = services.automations.list().find((x) => x.kind === "memory_dream" && x.name === DREAM_AUTOMATION_NAME && x.enabled);
  return a?.next_run ?? null;
}
