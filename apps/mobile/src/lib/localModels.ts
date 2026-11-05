import type { ChainRef, ChatMessage } from "@talorys/shared";
import type { LocalChatMessage, LocalModelStatus } from "../../modules/talorys-local-llm";
import { fitDevicePrompt, deviceModelSpec, settingsPatchForChain } from "./shared";

/**
 * Local models (docs/local-models.md), app side: the pure rules the "Local models" screen and the
 * chat's offline fallback follow, plus the device bridge's lifecycle. Everything native is in
 * modules/talorys-local-llm; everything here is unit-tested (tests/local-models.test.ts).
 */

/** "1.8 GB", "640 MB". */
export function formatBytes(n: number): string {
  if (!(n > 0)) return "0 MB";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

/** 0–100, for the progress bar. */
export function progressPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

/**
 * The chain with a device model switched on or off. On appends it at the END (the existing order is
 * never touched; the owner can move it in Settings → Model chain); off removes it. Returns null when
 * nothing changes.
 */
export function chainWithDeviceModel(list: readonly ChainRef[], model: string, on: boolean): ChainRef[] | null {
  const has = list.some((r) => r.provider === "device" && r.model === model);
  if (on === has) return null;
  if (on) return [...list, { provider: "device", model }];
  const next = list.filter((r) => !(r.provider === "device" && r.model === model));
  return next.length > 0 ? next : null;
}

/** The PATCH /api/settings body that stores `list` (the same split the chain screens use). */
export function chainSettingsPatch(list: readonly ChainRef[]) {
  return settingsPatchForChain(list);
}

/** A model the phone can answer with right now (downloaded or loaded, not blocked for RAM). */
export function isUsable(m: Pick<LocalModelStatus, "state" | "ram">): boolean {
  return (m.state === "downloaded" || m.state === "ready") && m.ram !== "block";
}

/** The model for the offline fallback: the chosen one when usable, else the first usable one. */
export function pickOfflineModel(models: readonly LocalModelStatus[], preferred: string): LocalModelStatus | null {
  const chosen = models.find((m) => m.id === preferred && isUsable(m));
  return chosen ?? models.find(isUsable) ?? null;
}

/**
 * Whether a failed send means "the agent cannot be reached" (so the phone may answer on its own):
 * a network failure, or the edge / Pages proxy answering 502–504 or 52x, before the agent started the
 * turn. An answer from the agent itself (an AI error, a conflict, a 401) never qualifies.
 */
export function isAgentUnreachable(error: { status?: number; code?: string } | null | undefined, started: boolean): boolean {
  if (!error || started) return false;
  if (error.code === "NETWORK" || error.status === 0) return true;
  const s = error.status ?? 0;
  const proxy = s === 502 || s === 504 || (s >= 520 && s <= 527) || (s === 503 && !String(error.code ?? "").startsWith("AI_"));
  return proxy && error.code !== "UNAUTHORIZED";
}

const OFFLINE_SYSTEM = {
  en: "You are Talorys, the owner's personal assistant, running offline on their phone. The server is unreachable, so you have no tools, memory or internet. Answer briefly and helpfully from the conversation. If the request needs the server (tasks, reminders, notes, accounts), say it will work again once the connection is back.",
  he: "את/ה Talorys, העוזר האישי של הבעלים, ורץ כרגע במצב לא מקוון על הטלפון. השרת לא זמין, אז אין כלים, זיכרון או אינטרנט. ענה בקצרה ובעזרה מתוך השיחה. אם הבקשה דורשת את השרת (משימות, תזכורות, פתקים, חשבונות), אמור שזה יעבוד שוב כשהחיבור יחזור. ענה בעברית.",
} as const;

/** The offline prompt: a short system text and the most recent turns that fit the model's budget. */
export function offlineRequest(modelId: string, history: readonly Pick<ChatMessage, "role" | "content" | "status">[], text: string, locale: "en" | "he"): { system: string; messages: LocalChatMessage[]; maxOutputTokens: number } {
  const spec = deviceModelSpec(modelId);
  const budget = spec?.promptBudgetTokens ?? 1024;
  const turns: LocalChatMessage[] = history.filter((m) => m.status !== "error" && m.content.trim()).map((m) => ({ role: m.role, content: m.content }));
  turns.push({ role: "user", content: text });
  const fitted = fitDevicePrompt(OFFLINE_SYSTEM[locale], turns, budget);
  return { system: fitted.system, messages: fitted.messages, maxOutputTokens: spec?.maxOutputTokens ?? 1024 };
}
