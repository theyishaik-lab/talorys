import { DEFAULT_DEVICE_SETTINGS, type DeviceChatMessage, deviceModelSpec, fitDevicePrompt, ThinkStripper } from "@talorys/shared";
import { AppError } from "../api/errors";
import type { BridgeRequest, BridgeStreamEvent, DeviceBridge } from "../device/bridge";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest, Usage } from "./provider";

/**
 * A chain entry `{ provider: "device", model }`: the owner's phone answers through the device bridge
 * (src/device/bridge.ts, docs/local-models.md).
 *
 * On-device models get NO tools: a turn that reaches this entry is answered in plain text from the
 * conversation (the tool list is ignored, and the model is told so). Every way the phone cannot answer
 * before its first word is a fallback reason (AI_UNAVAILABLE), so the chain moves on exactly as it
 * does for a quota or an overload:
 *  - no phone connected → reason "device_offline" (never paused: the next turn checks again);
 *  - the phone has not downloaded the model, or "Use in chain" is off for it → "not_downloaded";
 *  - the phone did not take the request (or show it is loading / thinking) within the first-token
 *    timeout (Settings: device.firstTokenTimeoutS, 20 s) → "timeout";
 *  - the phone reported an error, or its socket closed → "error" / "device_offline".
 * Once text has streamed the turn is committed to the phone (FallbackProvider), and the overall
 * timeout (device.overallTimeoutS, 240 s) ends a reply that never finishes.
 */
export interface DeviceTimeouts {
  firstTokenTimeoutMs: number;
  overallTimeoutMs: number;
}

const NO_TOOLS_NOTE = "\n\n(You are running on the owner's phone without tools or internet access in this reply. Answer directly from the conversation, briefly, in the owner's language. Do not claim to have done anything.)";

export class DeviceProvider implements AIProvider {
  readonly id = "device" as const;
  readonly modelId: string;
  /** The chain's watchdog defers to this provider's own timeouts (see FallbackProvider.attempt). */
  readonly firstEventWaitMs: number;
  /** On-device models never call tools. */
  readonly toolCalling = false;

  constructor(
    model: string,
    private readonly bridge: Pick<DeviceBridge, "availability" | "generate">,
    private readonly timeouts: DeviceTimeouts = { firstTokenTimeoutMs: DEFAULT_DEVICE_SETTINGS.firstTokenTimeoutS * 1000, overallTimeoutMs: DEFAULT_DEVICE_SETTINGS.overallTimeoutS * 1000 },
  ) {
    this.modelId = model;
    this.firstEventWaitMs = timeouts.overallTimeoutMs + 5_000;
  }

  async generate(req: GenerateRequest): Promise<{ text: string; usage: Usage; model?: string }> {
    let text = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    for await (const e of this.run(req)) {
      if (e.type === "text") text += e.delta;
      else if (e.type === "usage") usage = e.usage;
    }
    return { text, usage, model: `device/${this.modelId}` };
  }

  stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    return this.run(req);
  }

  generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    return this.run(req);
  }

  private fail(reason: "device_offline" | "not_downloaded" | "timeout" | "overloaded" | "error", message: string, extra: Record<string, unknown> = {}): AppError {
    return new AppError("AI_UNAVAILABLE", message, { provider: "device", model: this.modelId, reason, ...extra });
  }

  private async *run(req: GenerateRequest): AsyncGenerator<AgentEvent> {
    const spec = deviceModelSpec(this.modelId);
    if (!spec) throw this.fail("not_downloaded", `Unknown on-device model ${this.modelId}.`);
    const where = this.bridge.availability(this.modelId);
    if (!where.ok) {
      if (where.reason === "device_offline") throw this.fail("device_offline", `${spec.name}: no phone is connected to Talorys right now; switched to the next model.`);
      const why =
        where.reason === "not_allowed"
          ? `"Use in chain" is off for ${spec.name} on the phone`
          : where.reason === "low_memory"
            ? `the phone does not have enough memory for ${spec.name}`
            : `${spec.name} is not downloaded on the phone`;
      throw this.fail("not_downloaded", `${why}; switched to the next model.`, { device_reason: where.reason });
    }

    const history: DeviceChatMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const fitted = fitDevicePrompt(req.system, history, spec.promptBudgetTokens);
    // A reasoning model needs its whole budget (thinking counts against it); others take what the turn asks.
    const maxOutputTokens = spec.reasoning ? spec.maxOutputTokens : Math.max(256, Math.min(spec.maxOutputTokens, req.maxOutputTokens));
    const request: BridgeRequest = this.bridge.generate(where.socket, {
      model: this.modelId,
      system: fitted.system + NO_TOOLS_NOTE,
      messages: fitted.messages,
      maxOutputTokens,
      temperature: req.temperature,
    });

    let finished = false;
    const onAbort = () => request.cancel();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const strip = new ThinkStripper();
      let alive = false;
      let spoke = false;
      const deadline = Date.now() + this.timeouts.overallTimeoutMs;
      for (;;) {
        if (req.signal?.aborted) throw new AppError("AI_UNAVAILABLE", "The response was cancelled.", { provider: "device", model: this.modelId, reason: "error" });
        const wait: number = alive ? deadline - Date.now() : Math.min(this.timeouts.firstTokenTimeoutMs, deadline - Date.now());
        const e: BridgeStreamEvent | "timeout" = wait > 0 ? await request.next(wait) : "timeout";
        if (e === "timeout") {
          const s = Math.round((alive ? this.timeouts.overallTimeoutMs : this.timeouts.firstTokenTimeoutMs) / 1000);
          throw this.fail("timeout", alive ? `${spec.name} on the phone did not finish within ${s} s.` : `No answer from ${spec.name} on the phone within ${s} s; switched to the next model.`, { timeout_s: s });
        }
        switch (e.kind) {
          case "accepted":
          case "progress":
            alive = true;
            continue;
          case "token": {
            alive = true;
            const text = strip.push(e.delta);
            if (text) {
              spoke = true;
              yield { type: "text", delta: text };
            }
            continue;
          }
          case "done": {
            finished = true;
            const rest = strip.end();
            if (rest) {
              spoke = true;
              yield { type: "text", delta: rest };
            }
            if (!spoke) throw this.fail("error", `${spec.name} on the phone returned an empty answer.`);
            yield { type: "usage", usage: { inputTokens: e.usage?.input_tokens ?? 0, outputTokens: e.usage?.output_tokens ?? 0 } };
            return;
          }
          case "error": {
            finished = true;
            if (e.code === "cancelled" && req.signal?.aborted) throw new AppError("AI_UNAVAILABLE", "The response was cancelled.", { provider: "device", model: this.modelId, reason: "error" });
            if (e.code === "not_downloaded" || e.code === "not_allowed") throw this.fail("not_downloaded", `${spec.name}: ${e.message || "not available on the phone"}; switched to the next model.`, { device_reason: e.code });
            if (e.code === "busy") throw this.fail("overloaded", `${spec.name}: the phone is busy with another answer.`);
            throw this.fail("error", `${spec.name} on the phone failed: ${e.message || e.code}`.slice(0, 300), { device_reason: e.code });
          }
          case "closed":
            finished = true;
            throw this.fail("device_offline", `The phone disconnected while ${spec.name} was answering.`);
        }
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (!finished) request.cancel();
    }
  }
}
