import { describe, expect, it } from "vitest";
import { chainFromSettings, DEFAULT_FALLBACK, type DeviceModelReport, settingsPatchForChain } from "@talorys/shared";
import { DeviceProvider } from "../src/ai/device";
import { FallbackProvider } from "../src/ai/fallback";
import { cooldownFor, ModelCooldowns } from "../src/ai/cooldown";
import { chainStatus } from "../src/ai/chain-status";
import { deviceCatalogProvider } from "../src/ai/catalog";
import { attemptOf } from "../src/ai/attribution";
import { AppError } from "../src/api/errors";
import { type BridgeConnState, type BridgeSocket, DeviceBridge } from "../src/device/bridge";
import type { AgentEvent, AIProvider, ToolRequest } from "../src/ai/provider";

/** A fake phone socket: records frames the agent sends, keeps its state like an Agents SDK connection. */
class FakeSocket implements BridgeSocket {
  sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  state: BridgeConnState | null = null;
  onSend: ((msg: any) => void) | null = null;
  constructor(readonly id: string) {}
  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    this.onSend?.(msg);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  setState(s: BridgeConnState) {
    this.state = s;
  }
}

const report = (id: string, extra: Partial<DeviceModelReport> = {}): DeviceModelReport => ({ id, state: "downloaded", use_in_chain: true, ram: "ok", ...extra });

function phone(bridge: DeviceBridge, id = "s1", models: DeviceModelReport[] = [report("gemma-4-e4b")]): FakeSocket {
  const s = new FakeSocket(id);
  bridge.opened(s);
  bridge.message(s, JSON.stringify({ type: "hello", protocol: 1, device_id: `dev-${id}`, device_name: "Pixel", capabilities: ["generate"], models }));
  return s;
}

function bridgeWith(...sockets: FakeSocket[]): DeviceBridge {
  const b = new DeviceBridge();
  b.attach(() => sockets);
  return b;
}

const req = (extra: Partial<ToolRequest> = {}): ToolRequest => ({
  system: "You are Talorys.",
  messages: [{ role: "user", content: "שלום" }],
  maxOutputTokens: 1024,
  tools: [],
  maxIterations: 4,
  toolBudgetExhausted: () => false,
  ...extra,
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected a failure");
}

describe("DeviceBridge", () => {
  it("welcomes an authenticated phone and records its hello on the socket (survives hibernation)", () => {
    const sockets: FakeSocket[] = [];
    const b = bridgeWith();
    b.attach(() => sockets);
    const s = phone(b);
    sockets.push(s);
    expect(s.sent[0]).toMatchObject({ type: "welcome", protocol: 1 });
    expect(s.state).toMatchObject({ authed: true, device_id: "dev-s1", capabilities: ["generate"] });
    expect(b.devices()).toHaveLength(1);
    expect(b.devices()[0]!.models[0]).toMatchObject({ id: "gemma-4-e4b", state: "downloaded" });
  });

  it("ignores frames from a socket that never authenticated, and malformed frames", () => {
    const s = new FakeSocket("x");
    const b = bridgeWith(s);
    b.message(s, JSON.stringify({ type: "hello", protocol: 1, device_id: "d", capabilities: ["generate"], models: [] }));
    expect(s.state).toBeNull();
    b.opened(s);
    b.message(s, "{not json");
    b.message(s, JSON.stringify({ type: "evil" }));
    expect(s.state?.device_id).toBeUndefined();
    expect(b.availability("gemma-4-e4b")).toEqual({ ok: false, reason: "device_offline" });
  });

  it("closes a phone that speaks another protocol version", () => {
    const s = new FakeSocket("x");
    const b = bridgeWith(s);
    b.opened(s);
    b.message(s, JSON.stringify({ type: "hello", protocol: 99, device_id: "d", capabilities: ["generate"], models: [] }));
    expect(s.closedWith?.code).toBe(4400);
  });

  it("says why a model is not available: offline, not downloaded, not allowed, low memory", () => {
    expect(bridgeWith().availability("gemma-4-e4b")).toEqual({ ok: false, reason: "device_offline" });
    const b1 = new DeviceBridge();
    const a = phone(b1, "a", [report("gemma-4-e4b", { state: "not_downloaded" })]);
    b1.attach(() => [a]);
    expect(b1.availability("gemma-4-e4b")).toEqual({ ok: false, reason: "not_downloaded" });
    expect(b1.availability("spark-x2.5-1.7b")).toEqual({ ok: false, reason: "not_downloaded" });
    b1.message(a, JSON.stringify({ type: "status", models: [report("gemma-4-e4b", { use_in_chain: false })] }));
    expect(b1.availability("gemma-4-e4b")).toEqual({ ok: false, reason: "not_allowed" });
    b1.message(a, JSON.stringify({ type: "status", models: [report("gemma-4-e4b", { ram: "block" })] }));
    expect(b1.availability("gemma-4-e4b")).toEqual({ ok: false, reason: "low_memory" });
    b1.message(a, JSON.stringify({ type: "status", models: [report("gemma-4-e4b")] }));
    expect(b1.availability("gemma-4-e4b")).toMatchObject({ ok: true });
  });

  it("prefers a phone that has the model loaded", () => {
    const b = new DeviceBridge();
    const a = phone(b, "a", [report("gemma-4-e4b")]);
    const c = phone(b, "c", [report("gemma-4-e4b", { state: "ready" })]);
    b.attach(() => [a, c]);
    const pick = b.availability("gemma-4-e4b");
    expect(pick.ok && pick.socket.id).toBe("c");
  });

  it("routes tokens of a request only from the socket that holds it, and ends requests when the socket closes", async () => {
    const b = new DeviceBridge();
    const a = phone(b);
    const other = phone(b, "o");
    b.attach(() => [a, other]);
    const r = b.generate(a, { model: "gemma-4-e4b", system: "s", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 });
    const frame = a.sent.find((m) => m.type === "generate");
    expect(frame).toMatchObject({ id: r.id, model: "gemma-4-e4b", max_output_tokens: 10 });
    b.message(other, JSON.stringify({ type: "token", id: r.id, delta: "spoofed" }));
    b.message(a, JSON.stringify({ type: "token", id: r.id, delta: "hello" }));
    expect(await r.next(100)).toEqual({ kind: "token", delta: "hello" });
    b.closed(a);
    expect(await r.next(100)).toEqual({ kind: "closed" });
    expect(b.inFlight).toBe(0);
  });

  it("sends cancel once for a request that is still open", () => {
    const b = new DeviceBridge();
    const a = phone(b);
    b.attach(() => [a]);
    const r = b.generate(a, { model: "gemma-4-e4b", system: "s", messages: [], maxOutputTokens: 10 });
    r.cancel();
    r.cancel();
    expect(a.sent.filter((m) => m.type === "cancel")).toEqual([{ type: "cancel", id: r.id }]);
  });
});

/** A phone that answers each generate with a script of frames (delays in ms between them). */
function scripted(b: DeviceBridge, s: FakeSocket, script: (object | number)[]) {
  s.onSend = (msg) => {
    if (msg.type !== "generate") return;
    void (async () => {
      for (const step of script) {
        if (typeof step === "number") await new Promise((r) => setTimeout(r, step));
        else b.message(s, JSON.stringify({ id: msg.id, ...step }));
      }
    })();
  };
}

describe("DeviceProvider", () => {
  const fast = { firstTokenTimeoutMs: 80, overallTimeoutMs: 400 };

  it("fails over with reason device_offline when no phone is connected (and the reason is never paused)", async () => {
    const p = new DeviceProvider("gemma-4-e4b", bridgeWith(), fast);
    const e = await failure(collect(p.generateWithTools(req())));
    expect(e.code).toBe("AI_UNAVAILABLE");
    expect(attemptOf(e, "device", "gemma-4-e4b").reason).toBe("device_offline");
    expect(cooldownFor(e, Date.now())).toBeNull();
  });

  it("fails over with reason not_downloaded when the phone lacks the model", async () => {
    const b = new DeviceBridge();
    const s = phone(b, "a", [report("gemma-4-e4b", { state: "not_downloaded" })]);
    b.attach(() => [s]);
    const e = await failure(collect(new DeviceProvider("gemma-4-e4b", b, fast).generateWithTools(req())));
    expect(attemptOf(e, "device", "gemma-4-e4b").reason).toBe("not_downloaded");
    expect(e.message).toMatch(/not downloaded/);
  });

  it("streams the phone's answer, strips <think> blocks, ignores tools and reports usage", async () => {
    const b = new DeviceBridge();
    const s = phone(b, "a", [report("spark-x2.5-1.7b", { state: "ready" })]);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "accepted" }, { type: "token", delta: "<thi" }, { type: "token", delta: "nk>secret plan</think>\n\nשלום" }, { type: "token", delta: " לך" }, { type: "done", usage: { input_tokens: 12, output_tokens: 7 } }]);
    const tool = { name: "create_task", description: "", inputSchema: {} as never, execute: async () => ({}) };
    const events = await collect(new DeviceProvider("spark-x2.5-1.7b", b, fast).generateWithTools(req({ tools: [tool] })));
    expect(text(events)).toBe("שלום לך");
    expect(events.at(-1)).toEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 7 } });
    const frame = s.sent.find((m) => m.type === "generate");
    // A reasoning model gets its whole budget; the prompt says there are no tools.
    expect(frame.max_output_tokens).toBe(3072);
    expect(frame.system).toMatch(/without tools/);
    expect(frame.messages).toEqual([{ role: "user", content: "שלום" }]);
  });

  it("times out (reason timeout) when the phone neither takes the request nor speaks within the first-token timeout", async () => {
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    const e = await failure(collect(new DeviceProvider("gemma-4-e4b", b, fast).generateWithTools(req())));
    expect(attemptOf(e, "device", "gemma-4-e4b").reason).toBe("timeout");
    // The phone is told to stop.
    expect(s.sent.some((m) => m.type === "cancel")).toBe(true);
  });

  it("keeps waiting past the first-token timeout while the phone reports progress (loading / thinking)", async () => {
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "progress", phase: "loading" }, 60, { type: "progress", phase: "thinking" }, 60, { type: "token", delta: "ok" }, { type: "done" }]);
    const events = await collect(new DeviceProvider("gemma-4-e4b", b, { firstTokenTimeoutMs: 50, overallTimeoutMs: 1000 }).generateWithTools(req()));
    expect(text(events)).toBe("ok");
  });

  it("maps phone errors: not_downloaded → not_downloaded, busy → overloaded, a closed socket → device_offline", async () => {
    for (const [frame, reason] of [
      [{ type: "error", code: "not_downloaded", message: "file missing" }, "not_downloaded"],
      [{ type: "error", code: "busy", message: "" }, "overloaded"],
      [{ type: "error", code: "load_failed", message: "GPU init failed" }, "error"],
    ] as const) {
      const b = new DeviceBridge();
      const s = phone(b);
      b.attach(() => [s]);
      scripted(b, s, [frame]);
      const e = await failure(collect(new DeviceProvider("gemma-4-e4b", b, fast).generateWithTools(req())));
      expect(attemptOf(e, "device", "gemma-4-e4b").reason).toBe(reason);
    }
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    s.onSend = (m) => m.type === "generate" && setTimeout(() => b.closed(s), 5);
    const e = await failure(collect(new DeviceProvider("gemma-4-e4b", b, fast).generateWithTools(req())));
    expect(attemptOf(e, "device", "gemma-4-e4b").reason).toBe("device_offline");
  });

  it("cancels the phone's work when the turn is stopped", async () => {
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "accepted" }, { type: "token", delta: "a" }, 200, { type: "token", delta: "b" }, { type: "done" }]);
    const controller = new AbortController();
    const it = new DeviceProvider("gemma-4-e4b", b, { firstTokenTimeoutMs: 100, overallTimeoutMs: 1000 }).generateWithTools(req({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: "text", delta: "a" });
    controller.abort();
    await expect(it.next()).rejects.toBeTruthy();
    expect(s.sent.some((m) => m.type === "cancel")).toBe(true);
  });

  it("drops older turns to fit the model's prompt budget, always keeping the latest message", async () => {
    const b = new DeviceBridge();
    const s = phone(b, "a", [report("spark-x2.5-1.7b")]);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "token", delta: "x" }, { type: "done" }]);
    const long = "א".repeat(2000);
    await collect(
      new DeviceProvider("spark-x2.5-1.7b", b, fast).generateWithTools(
        req({ messages: [{ role: "user", content: long }, { role: "assistant", content: long }, { role: "user", content: "last question" }] }),
      ),
    );
    const frame = s.sent.find((m) => m.type === "generate");
    expect(frame.messages.at(-1)).toEqual({ role: "user", content: "last question" });
    expect(frame.messages.length).toBeLessThan(3);
  });
});

/** A plain provider for the chain tests. */
function cloud(id: string, answer: string): AIProvider & { calls: number } {
  const p = {
    id,
    modelId: `${id}-model`,
    calls: 0,
    async generate() {
      p.calls++;
      return { text: answer, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream() {
      yield { type: "text" as const, delta: answer };
    },
    async *generateWithTools(): AsyncIterable<AgentEvent> {
      p.calls++;
      yield { type: "text", delta: answer };
    },
  };
  return p;
}

describe("device entries in the fallback chain", () => {
  it("an offline phone is skipped at once and the next model answers, with the attempt reported", async () => {
    const next = cloud("gemini", "from gemini");
    const chain = new FallbackProvider([new DeviceProvider("gemma-4-e4b", bridgeWith()), next], undefined, 50);
    const events = await collect(chain.generateWithTools(req()));
    expect(text(events)).toBe("from gemini");
    const switched = events.find((e) => e.type === "provider");
    expect(switched).toMatchObject({ provider: "gemini" });
    expect((switched as { attempts: { reason: string }[] }).attempts[0]).toMatchObject({ provider: "device", reason: "device_offline" });
  });

  it("the chain's watchdog does not cut the phone off before its own first-token timeout", async () => {
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "accepted" }, 120, { type: "token", delta: "from phone" }, { type: "done" }]);
    const next = cloud("gemini", "from gemini");
    // Chain watchdog 30 ms; the phone's first token comes after 120 ms.
    const chain = new FallbackProvider([new DeviceProvider("gemma-4-e4b", b, { firstTokenTimeoutMs: 500, overallTimeoutMs: 2000 }), next], undefined, 30);
    const events = await collect(chain.generateWithTools(req()));
    expect(text(events)).toBe("from phone");
    expect(next.calls).toBe(0);
  });

  it("a device model in the middle of the chain is tried in its place", async () => {
    const first = { ...cloud("workers-ai", ""), async *generateWithTools(): AsyncIterable<AgentEvent> { throw new AppError("AI_QUOTA_EXHAUSTED", "4006", { provider: "workers-ai", reason: "quota" }); } };
    const b = new DeviceBridge();
    const s = phone(b);
    b.attach(() => [s]);
    scripted(b, s, [{ type: "token", delta: "phone" }, { type: "done" }]);
    const last = cloud("gemini", "gemini");
    const cooldowns = new ModelCooldowns({ getJson: () => null, setJson: () => {} });
    const chain = new FallbackProvider([first, new DeviceProvider("gemma-4-e4b", b), last], undefined, 1000, cooldowns);
    expect(text(await collect(chain.generateWithTools(req())))).toBe("phone");
    expect(last.calls).toBe(0);
  });
});

describe("chain status and catalog for device entries", () => {
  const settings = { modelProvider: "workers-ai" as const, model: "@cf/zai-org/glm-4.7-flash", fallback: { ...DEFAULT_FALLBACK, enabled: true, provider: "gemini" as const, model: "gemini-3.5-flash", chain: [{ provider: "device" as const, model: "gemma-4-e4b" }] } };
  const deps = (device: "ok" | "device_offline" | "not_downloaded") => ({
    cooldowns: { active: () => null },
    quotas: { get: () => null },
    configured: () => true,
    endpointName: () => null,
    openRouter: null,
    device: () => device,
    now: Date.now(),
  });

  it("shows a device entry as offline with its reason, or available, in its chain position", () => {
    const off = chainStatus(settings, deps("device_offline")).entries[2]!;
    expect(off).toMatchObject({ provider: "device", model: "gemma-4-e4b", position: 2, state: "offline", reason: "device_offline", label: "Gemma 4 E4B", provider_label: "Phone" });
    expect(chainStatus(settings, deps("not_downloaded")).entries[2]).toMatchObject({ state: "offline", reason: "not_downloaded" });
    expect(chainStatus(settings, deps("ok")).entries[2]).toMatchObject({ state: "available", reason: null });
  });

  it("a device entry can be reordered like any other (the stored settings keep the order)", () => {
    const list = chainFromSettings(settings);
    const moved = [list[2]!, list[0]!, list[1]!];
    const patch = settingsPatchForChain(moved);
    expect(patch).toMatchObject({ modelProvider: "device", model: "gemma-4-e4b", fallback: { provider: "workers-ai", chain: [{ provider: "gemini", model: "gemini-3.5-flash" }] } });
  });

  it("lists both on-device models without tool calling", () => {
    const p = deviceCatalogProvider([]);
    expect(p).toMatchObject({ id: "device", connected: false, needsKey: false });
    expect(p.models.map((m) => [m.id, m.tools])).toEqual([
      ["spark-x2.5-1.7b", false],
      ["gemma-4-e4b", false],
    ]);
    expect(deviceCatalogProvider([{ models: [] }]).connected).toBe(true);
  });
});
