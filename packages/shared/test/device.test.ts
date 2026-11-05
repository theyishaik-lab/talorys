import { describe, expect, it } from "vitest";
import {
  DEVICE_MODELS,
  deviceModelSpec,
  fitDevicePrompt,
  isDeviceModelId,
  modelReadiness,
  parseBridgeClientMessage,
  ramVerdict,
  stripThinking,
  ThinkStripper,
} from "../src/device";
import { isModelIdFor, settingsSchema, settingsUpdateSchema } from "../src/schemas";
import { modelDisplayName, modelLabel } from "../src/attribution";
import { DEFAULT_LIMITS, DEFAULT_MEMORY_HISTORY } from "../src/constants";

describe("on-device model specs", () => {
  it("pins each model to a Hugging Face revision with its exact size and checksum", () => {
    for (const m of DEVICE_MODELS) {
      expect(m.url).toBe(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`);
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(1e9);
      expect(m.promptBudgetTokens + m.maxOutputTokens).toBeLessThanOrEqual(m.contextTokens);
    }
    expect(deviceModelSpec("spark-x2.5-1.7b")).toMatchObject({ file: "Spark-X2.5-1.7B_int8.litertlm", reasoning: true });
    expect(deviceModelSpec("gemma-4-e4b")).toMatchObject({ file: "gemma-4-E4B-it.litertlm", minRamGb: 6 });
  });

  it("gives a reasoning model a generous answer budget", () => {
    expect(deviceModelSpec("spark-x2.5-1.7b")!.maxOutputTokens).toBeGreaterThanOrEqual(2048);
  });

  it("device model ids are valid chain entries; anything else is not", () => {
    expect(isDeviceModelId("gemma-4-e4b")).toBe(true);
    expect(isModelIdFor("device", "spark-x2.5-1.7b")).toBe(true);
    expect(isModelIdFor("device", "llama-3")).toBe(false);
    expect(isModelIdFor("gemini", "gemma-4-e4b")).toBe(true);
  });

  it("blocks Gemma 4 E4B under ~6 GB and warns under 8 GB (Android reports a little less than marketed)", () => {
    const gemma = deviceModelSpec("gemma-4-e4b")!;
    const GB = 1024 ** 3;
    expect(ramVerdict(gemma, 3.6 * GB)).toBe("block"); // a 4 GB phone
    expect(ramVerdict(gemma, 5.6 * GB)).toBe("warn"); // a 6 GB phone
    expect(ramVerdict(gemma, 11.2 * GB)).toBe("ok"); // a 12 GB phone
    expect(ramVerdict(deviceModelSpec("spark-x2.5-1.7b")!, 3.6 * GB)).toBe("ok");
  });

  it("names the models readably", () => {
    expect(modelLabel("gemma-4-e4b")).toBe("Gemma 4 E4B");
    expect(modelLabel("spark-x2.5-1.7b")).toBe("Spark X2.5 1.7B");
    expect(modelDisplayName({ provider: "device", model: "gemma-4-e4b" })).toBe("Gemma 4 E4B (Phone)");
  });
});

describe("device settings", () => {
  it("settings saved before on-device models existed read the default timeouts", () => {
    const parsed = settingsSchema.parse({ agentName: "T", timezone: "UTC", theme: "system", model: "@cf/zai-org/glm-4.7-flash", temperature: 0.5, limits: DEFAULT_LIMITS, autoMemory: true, demoMode: false, memoryHistory: DEFAULT_MEMORY_HISTORY });
    expect(parsed.device).toEqual({ firstTokenTimeoutS: 20, overallTimeoutS: 240 });
  });

  it("a timeout patch is validated", () => {
    expect(settingsUpdateSchema.safeParse({ device: { firstTokenTimeoutS: 30 } }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ device: { firstTokenTimeoutS: 1 } }).success).toBe(false);
  });
});

describe("bridge frames", () => {
  it("parses well-formed phone frames and rejects the rest", () => {
    expect(parseBridgeClientMessage(JSON.stringify({ type: "token", id: "g1", delta: "hi" }))).toEqual({ type: "token", id: "g1", delta: "hi" });
    expect(parseBridgeClientMessage(JSON.stringify({ type: "token", id: "g1" }))).toBeNull();
    expect(parseBridgeClientMessage("nope")).toBeNull();
    expect(parseBridgeClientMessage(JSON.stringify({ type: "rpc", method: "x" }))).toBeNull();
    const hello = parseBridgeClientMessage(JSON.stringify({ type: "hello", protocol: 1, device_id: "d", capabilities: ["generate"], models: [{ id: "gemma-4-e4b", state: "weird", use_in_chain: "yes" }, 7] }));
    expect(hello).toMatchObject({ type: "hello", models: [{ id: "gemma-4-e4b", state: "error", use_in_chain: false }] });
    expect(parseBridgeClientMessage(JSON.stringify({ type: "error", id: "g", code: "busy", message: "x".repeat(900) }))).toMatchObject({ code: "busy", message: "x".repeat(500) });
  });

  it("a model is usable only when downloaded, allowed in the chain and not blocked for memory", () => {
    expect(modelReadiness(undefined)).toBe("not_downloaded");
    expect(modelReadiness({ id: "m", state: "downloading", use_in_chain: true })).toBe("not_downloaded");
    expect(modelReadiness({ id: "m", state: "downloaded", use_in_chain: false })).toBe("not_allowed");
    expect(modelReadiness({ id: "m", state: "ready", use_in_chain: true, ram: "block" })).toBe("low_memory");
    expect(modelReadiness({ id: "m", state: "ready", use_in_chain: true, ram: "warn" })).toBe("ok");
  });
});

describe("ThinkStripper", () => {
  it("removes think blocks split across deltas, at any boundary", () => {
    const full = "<think>let me think about it</think>\n\nThe answer is 42.";
    for (let cut = 1; cut < full.length; cut++) {
      const s = new ThinkStripper();
      const out = s.push(full.slice(0, cut)) + s.push(full.slice(cut)) + s.end();
      expect(out).toBe("The answer is 42.");
    }
  });

  it("streams plain text through as it arrives (holding back only a possible tag start)", () => {
    const s = new ThinkStripper();
    expect(s.push("Hello ")).toBe("Hello ");
    expect(s.push("world <")).toBe("world ");
    expect(s.push("b>")).toBe("<b>");
    expect(s.end()).toBe("");
  });

  it("drops an unterminated block and a stray closing tag (the runtime pre-filled the opener)", () => {
    expect(stripThinking("reasoning...</think>שלום")).toBe("reasoning...שלום");
    expect(stripThinking("Answer.<think>never closed")).toBe("Answer.");
    expect(stripThinking("a<think>x</think>b<think>y</think>c")).toBe("abc");
  });
});

describe("fitDevicePrompt", () => {
  it("keeps everything when it fits", () => {
    const r = fitDevicePrompt("sys", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "how are you" }], 1000);
    expect(r.messages).toHaveLength(3);
    expect(r.dropped).toBe(0);
  });

  it("drops the oldest turns first and never starts with an assistant turn", () => {
    const big = "x".repeat(600);
    const r = fitDevicePrompt("sys", [{ role: "user", content: big }, { role: "assistant", content: big }, { role: "user", content: big }, { role: "assistant", content: "short" }, { role: "user", content: "now" }], 300);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages.at(-1)).toEqual({ role: "user", content: "now" });
    expect(r.dropped).toBeGreaterThan(0);
  });

  it("cuts a single over-long message from the front and caps the system text", () => {
    const r = fitDevicePrompt("s".repeat(3000), [{ role: "user", content: `${"y".repeat(5000)}END` }], 300);
    expect(r.system.length).toBeLessThanOrEqual(300);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.content.endsWith("END")).toBe(true);
    expect(r.messages[0]!.content.length).toBeLessThan(1000);
  });
});
