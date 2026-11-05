/**
 * On-device models (docs/local-models.md): the models the Android app can download and run with
 * Google's LiteRT-LM runtime, and the wire protocol of the device bridge — the WebSocket between the
 * phone and the agent's Durable Object that lets a chain entry `{ provider: "device", model }` be
 * answered by the phone.
 *
 * This file has NO runtime imports: the mobile app imports it directly (apps/mobile/src/lib/shared.ts).
 */

/** Ids of the on-device models, as used in the chain (`{ provider: "device", model: <id> }`). */
export const DEVICE_MODEL_IDS = ["spark-x2.5-1.7b", "gemma-4-e4b"] as const;
export type DeviceModelId = (typeof DEVICE_MODEL_IDS)[number];

export interface DeviceModelSpec {
  id: DeviceModelId;
  /** "Spark-X2.5 1.7B" */
  name: string;
  /** Short English description for the pickers. */
  description: string;
  /** Hugging Face repository and the pinned revision the file is downloaded from. */
  repo: string;
  revision: string;
  file: string;
  /** Direct download URL (Hugging Face `resolve` at the pinned revision; redirects to the CDN, supports Range). */
  url: string;
  /** Exact file size in bytes and its SHA-256 (from the Hugging Face API, LFS metadata). */
  sizeBytes: number;
  sha256: string;
  license: string;
  /** Total RAM (GB, as Android reports it) below which the app refuses to load the model. */
  minRamGb: number;
  /** Total RAM (GB) below which the app warns that the model may be slow or be killed. */
  recommendedRamGb: number;
  /** KV-cache size the engine is created with (prompt + answer, in tokens). */
  contextTokens: number;
  /** Largest prompt (estimated tokens) the agent sends; older turns are dropped to fit. */
  promptBudgetTokens: number;
  /** Answer budget (for a reasoning model this includes its hidden thinking). */
  maxOutputTokens: number;
  /** Reasoning model: thinks inside <think>…</think> before it answers. */
  reasoning: boolean;
  /** Cap on thinking tokens (reasoning models; -1 = no cap). */
  thinkingBudgetTokens: number;
  /** Backend tried first; the app falls back to CPU when it fails to start. */
  preferredBackend: "gpu" | "cpu";
}

/**
 * Verified Nov 5, 2026 against https://huggingface.co/api/models/<repo>?blobs=true:
 *  - litert-community/Spark-X2.5-1.7B @ 3e8a954e: Spark-X2.5-1.7B_int8.litertlm, 1,834,713,088 B (the
 *    model card's recommended file; int4 is 1.26 GB). KV budget 4096 tokens; reasoning model, needs a
 *    generous answer budget (card: ≥ 2048, 3584 for math). Its GPU path needs LiteRT-LM ≥ 0.19.0.
 *  - litert-community/gemma-4-E4B-it-litert-lm @ 71064b01: gemma-4-E4B-it.litertlm, 3,659,530,240 B.
 *    Card: ~3.3 GB CPU / ~0.7 GB GPU working memory on an S26 Ultra; supports up to 32k context.
 */
export const DEVICE_MODELS: readonly DeviceModelSpec[] = [
  {
    id: "spark-x2.5-1.7b",
    name: "Spark-X2.5 1.7B",
    description: "Small reasoning model (iFLYTEK), int8. Thinks before it answers; 4k context.",
    repo: "litert-community/Spark-X2.5-1.7B",
    revision: "3e8a954ea1cf4ab1aa7873ef6e7fe153334d5225",
    file: "Spark-X2.5-1.7B_int8.litertlm",
    url: "https://huggingface.co/litert-community/Spark-X2.5-1.7B/resolve/3e8a954ea1cf4ab1aa7873ef6e7fe153334d5225/Spark-X2.5-1.7B_int8.litertlm",
    sizeBytes: 1_834_713_088,
    sha256: "81c32f0f319fbcbd7cce5695204f7a9cef90c3481f4ac545762087943932a0c0",
    license: "Apache-2.0",
    minRamGb: 3,
    recommendedRamGb: 4,
    contextTokens: 4096,
    // 1024 + 3072 = the bundle's 4096-token KV budget.
    promptBudgetTokens: 1024,
    maxOutputTokens: 3072,
    reasoning: true,
    thinkingBudgetTokens: 1536,
    preferredBackend: "gpu",
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    description: "Google Gemma 4 E4B instruct. Better quality and multilingual; needs about 6 GB of RAM.",
    repo: "litert-community/gemma-4-E4B-it-litert-lm",
    revision: "71064b01bd5e2bfd9a5f9dd52df86ae4800138c1",
    file: "gemma-4-E4B-it.litertlm",
    url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/71064b01bd5e2bfd9a5f9dd52df86ae4800138c1/gemma-4-E4B-it.litertlm",
    sizeBytes: 3_659_530_240,
    sha256: "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
    license: "Apache-2.0",
    minRamGb: 6,
    recommendedRamGb: 8,
    contextTokens: 8192,
    promptBudgetTokens: 6000,
    maxOutputTokens: 2048,
    reasoning: false,
    thinkingBudgetTokens: 0,
    preferredBackend: "gpu",
  },
];

export function isDeviceModelId(id: string): id is DeviceModelId {
  return (DEVICE_MODEL_IDS as readonly string[]).includes(id);
}

export function deviceModelSpec(id: string): DeviceModelSpec | undefined {
  return DEVICE_MODELS.find((m) => m.id === id);
}

/**
 * RAM verdict for a model on a phone with `totalRamBytes` (ActivityManager.MemoryInfo.totalMem, which
 * reports a little less than the marketed size: a "6 GB" phone shows ~5.5 GB, so 0.5 GB of slack).
 */
export function ramVerdict(spec: Pick<DeviceModelSpec, "minRamGb" | "recommendedRamGb">, totalRamBytes: number): "ok" | "warn" | "block" {
  const gb = totalRamBytes / 1024 ** 3 + 0.5;
  if (gb < spec.minRamGb) return "block";
  if (gb < spec.recommendedRamGb) return "warn";
  return "ok";
}

// ---------- Device bridge protocol (JSON text frames over one WebSocket) ----------

/** Bumped on an incompatible change; the agent closes a socket that speaks another major. */
export const DEVICE_BRIDGE_PROTOCOL = 1;
/** Path of the bridge WebSocket (same origin as the API; `Authorization: Bearer <native token>`). */
export const DEVICE_BRIDGE_PATH = "/api/device/bridge";

/** How a model stands on the phone. "ready" = loaded in memory; "downloaded" = on disk, loads on demand. */
export type DeviceModelState = "not_downloaded" | "downloading" | "downloaded" | "loading" | "ready" | "error";

export interface DeviceModelReport {
  id: string;
  state: DeviceModelState;
  /** The owner switched "Use in chain" on for this model in the app. */
  use_in_chain: boolean;
  /** "gpu" | "cpu" once loaded. */
  backend?: "gpu" | "cpu" | null;
  /** The phone's RAM verdict for this model. */
  ram?: "ok" | "warn" | "block";
}

/** Commands a device declares it can run. Only "generate" exists today; "device_read_screen" / "device_act" are reserved. */
export type DeviceCapability = "generate" | "device_read_screen" | "device_act";

export interface DeviceHello {
  type: "hello";
  protocol: number;
  /** Stable per install (random UUID kept by the app). */
  device_id: string;
  /** "Pixel 9 Pro" */
  device_name?: string;
  app_version?: string;
  ram_bytes?: number;
  capabilities: DeviceCapability[];
  models: DeviceModelReport[];
}

export interface DeviceChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Agent → phone. */
export type BridgeServerMessage =
  | { type: "welcome"; protocol: number; server_time: string }
  | {
      type: "generate";
      id: string;
      model: string;
      system: string;
      messages: DeviceChatMessage[];
      max_output_tokens: number;
      temperature?: number;
    }
  | { type: "cancel"; id: string }
  | { type: "ping"; t: number }
  /** Reserved for the computer-use queue (device_read_screen / device_act); a phone without the capability answers `result` with ok:false. */
  | { type: "command"; id: string; name: string; args: Record<string, unknown> };

/** Phone → agent. */
export type BridgeClientMessage =
  | DeviceHello
  | { type: "status"; models: DeviceModelReport[] }
  /** The phone took a generate request (it is loading the model or prefilling). */
  | { type: "accepted"; id: string }
  /** Still working (loading / thinking): keeps the first-token watchdog from firing on a reasoning model. */
  | { type: "progress"; id: string; phase: "loading" | "prefill" | "thinking" }
  | { type: "token"; id: string; delta: string }
  | { type: "done"; id: string; usage?: { input_tokens?: number; output_tokens?: number }; backend?: "gpu" | "cpu" }
  | { type: "error"; id: string; code: DeviceErrorCode; message: string }
  | { type: "pong"; t: number }
  | { type: "result"; id: string; ok: boolean; data?: unknown; error?: string };

export type DeviceErrorCode = "not_downloaded" | "not_allowed" | "busy" | "low_memory" | "cancelled" | "load_failed" | "error";

/** Parses one client frame; null when it is not a well-formed bridge message. */
export function parseBridgeClientMessage(raw: string): BridgeClientMessage | null {
  if (raw.length > 256 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === "string";
  switch (m.type) {
    case "hello":
      return typeof m.protocol === "number" && str("device_id") && Array.isArray(m.models) && Array.isArray(m.capabilities) ? ({ ...m, models: cleanReports(m.models) } as DeviceHello) : null;
    case "status":
      return Array.isArray(m.models) ? { type: "status", models: cleanReports(m.models) } : null;
    case "accepted":
      return str("id") ? { type: "accepted", id: m.id as string } : null;
    case "progress":
      return str("id") ? { type: "progress", id: m.id as string, phase: m.phase === "loading" || m.phase === "prefill" ? m.phase : "thinking" } : null;
    case "token":
      return str("id") && str("delta") ? { type: "token", id: m.id as string, delta: m.delta as string } : null;
    case "done":
      return str("id") ? (m as BridgeClientMessage) : null;
    case "error":
      return str("id") ? { type: "error", id: m.id as string, code: (str("code") ? m.code : "error") as DeviceErrorCode, message: str("message") ? (m.message as string).slice(0, 500) : "" } : null;
    case "pong":
      return { type: "pong", t: typeof m.t === "number" ? m.t : 0 };
    case "result":
      return str("id") ? ({ type: "result", id: m.id as string, ok: m.ok === true, data: m.data, error: str("error") ? (m.error as string) : undefined } as BridgeClientMessage) : null;
    default:
      return null;
  }
}

function cleanReports(list: unknown[]): DeviceModelReport[] {
  const states: DeviceModelState[] = ["not_downloaded", "downloading", "downloaded", "loading", "ready", "error"];
  const out: DeviceModelReport[] = [];
  for (const r of list.slice(0, 16)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    out.push({
      id: o.id.slice(0, 64),
      state: states.includes(o.state as DeviceModelState) ? (o.state as DeviceModelState) : "error",
      use_in_chain: o.use_in_chain === true,
      backend: o.backend === "gpu" || o.backend === "cpu" ? o.backend : null,
      ram: o.ram === "ok" || o.ram === "warn" || o.ram === "block" ? o.ram : undefined,
    });
  }
  return out;
}

/**
 * Whether a phone's report lets the agent send it a turn for `model`, and why not:
 * "ok" | "not_downloaded" (or still downloading / failed) | "not_allowed" (Use in chain is off) |
 * "low_memory" (the phone blocks it for RAM).
 */
export function modelReadiness(report: DeviceModelReport | undefined): "ok" | "not_downloaded" | "not_allowed" | "low_memory" {
  if (!report || report.state === "not_downloaded" || report.state === "downloading" || report.state === "error") return "not_downloaded";
  if (report.ram === "block") return "low_memory";
  if (!report.use_in_chain) return "not_allowed";
  return "ok";
}

// ---------- Reasoning output ----------

/**
 * Removes `<think>…</think>` blocks from a streamed answer. LiteRT-LM routes Spark's reasoning to its
 * "thought" channel, so the answer normally has none; this guards against a runtime or a bundle that
 * leaks it (an unterminated block at the end is dropped too). Feed deltas in order; `push` returns the
 * text that is safe to show now, `end` whatever is left.
 */
export class ThinkStripper {
  private buf = "";
  private inThink = false;
  /** True once any visible character was returned. */
  started = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf("</think>");
        if (end === -1) {
          // Keep only a tail that could be the start of "</think>".
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          break;
        }
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = this.buf.indexOf("<think>");
      if (start === -1) {
        // Hold back a tail that could be the start of "<think>".
        const hold = partialTagTail(this.buf, "<think>");
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      out += this.buf.slice(0, start);
      this.buf = this.buf.slice(start + 7);
      this.inThink = true;
    }
    // A stray closing tag (the runtime pre-filled the opener) and the whitespace after a block.
    out = out.replace(/<\/think>/g, "");
    if (!this.started) out = out.replace(/^\s+/, "");
    if (out) this.started = true;
    return out;
  }

  end(): string {
    const rest = this.inThink ? "" : this.buf.replace(/<\/think>/g, "");
    this.buf = "";
    return this.started ? rest : rest.replace(/^\s+/, "");
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTagTail(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n;
  return 0;
}

/** Strips every <think> block from a whole answer. */
export function stripThinking(text: string): string {
  const s = new ThinkStripper();
  return (s.push(text) + s.end()).trim();
}

/**
 * Fits a conversation into a device model's prompt budget: keeps the system text (cut to a third of
 * the budget) and as many of the most recent messages as fit, always the last one (cut from the
 * front when it alone is too long). Tokens are estimated at 3 characters each — Hebrew tokenizes
 * denser than English, so this errs on the short side.
 */
export function fitDevicePrompt(system: string, messages: readonly DeviceChatMessage[], budgetTokens: number): { system: string; messages: DeviceChatMessage[]; dropped: number } {
  const est = (s: string) => Math.ceil(s.length / 3);
  const sys = est(system) > budgetTokens / 3 ? system.slice(0, Math.floor((budgetTokens / 3) * 3)) : system;
  let left = budgetTokens - est(sys);
  const kept: DeviceChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as DeviceChatMessage;
    const cost = est(m.content) + 4;
    if (cost <= left) {
      kept.unshift(m);
      left -= cost;
      continue;
    }
    if (kept.length === 0) kept.unshift({ role: m.role, content: m.content.slice(-Math.max(1, left * 3)) });
    break;
  }
  // A conversation handed to the runtime starts with the owner.
  while (kept.length > 1 && kept[0]?.role === "assistant") kept.shift();
  return { system: sys, messages: kept, dropped: messages.length - kept.length };
}
