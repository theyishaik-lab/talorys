import type { Services } from "../services/container";

const SCAN_NAME = "Talorys proactive scan";

/** Synchronize the owner's opt-in with one managed, durable scan schedule. */
export async function syncProactiveSchedule(services: Services): Promise<void> {
  const config = services.settings.get().proactive;
  const managed = services.automations.list().filter((a) => a.kind === "proactive_scan" && a.name === SCAN_NAME);
  const [existing, ...duplicates] = managed;
  for (const duplicate of duplicates) await services.automations.delete(duplicate.id);
  if (!config.enabled) {
    if (existing?.enabled) await services.automations.update(existing.id, { enabled: false });
    return;
  }
  const minutes = config.scanEveryHours * 60;
  if (!existing) {
    await services.automations.create({ name: SCAN_NAME, kind: "proactive_scan", message: "", enabled: true, schedule: { type: "interval", minutes } });
  } else if (!existing.enabled || existing.schedule.type !== "interval" || existing.schedule.minutes !== minutes) {
    await services.automations.update(existing.id, { enabled: true, schedule: { type: "interval", minutes } });
  }
}
