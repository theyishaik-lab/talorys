import { describe, expect, it } from "vitest";
import {
  chainWithDeviceModel,
  formatBytes,
  isAgentUnreachable,
  isUsable,
  offlineRequest,
  pickOfflineModel,
  progressPercent,
} from "../src/lib/localModels";

const m = (id: string, state: string, ram = "ok") => ({ id, state, ram }) as never;

describe("local models", () => {
  it("formats sizes and progress", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB");
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(300, 200)).toBe(100);
  });

  it("adds a device model at the end and removes it, never reordering", () => {
    const base = [{ provider: "nvidia", model: "a" }, { provider: "deepseek", model: "b" }] as never[];
    const on = chainWithDeviceModel(base, "gemma-4-e4b", true)!;
    expect(on.slice(0, 2)).toEqual(base);
    expect(on[2]).toEqual({ provider: "device", model: "gemma-4-e4b" });
    expect(chainWithDeviceModel(on, "gemma-4-e4b", true)).toBeNull();
    expect(chainWithDeviceModel(on, "gemma-4-e4b", false)).toEqual(base);
    expect(chainWithDeviceModel(base, "gemma-4-e4b", false)).toBeNull();
  });

  it("picks a usable offline model", () => {
    expect(isUsable(m("x", "downloaded"))).toBe(true);
    expect(isUsable(m("x", "ready", "block"))).toBe(false);
    expect(isUsable(m("x", "downloading"))).toBe(false);
    const models = [m("spark-x2.5-1.7b", "downloaded"), m("gemma-4-e4b", "ready", "block")];
    expect(pickOfflineModel(models, "gemma-4-e4b")?.id).toBe("spark-x2.5-1.7b");
    expect(pickOfflineModel(models, "spark-x2.5-1.7b")?.id).toBe("spark-x2.5-1.7b");
    expect(pickOfflineModel([m("a", "absent")], "a")).toBeNull();
  });

  it("only falls back when the agent itself is unreachable", () => {
    expect(isAgentUnreachable({ code: "NETWORK" }, false)).toBe(true);
    expect(isAgentUnreachable({ status: 502 }, false)).toBe(true);
    expect(isAgentUnreachable({ status: 522 }, false)).toBe(true);
    expect(isAgentUnreachable({ status: 503, code: "AI_UNAVAILABLE" }, false)).toBe(false);
    expect(isAgentUnreachable({ status: 401, code: "UNAUTHORIZED" }, false)).toBe(false);
    expect(isAgentUnreachable({ code: "NETWORK" }, true)).toBe(false);
    expect(isAgentUnreachable(null, false)).toBe(false);
  });

  it("builds a fitted offline prompt in the user's language", () => {
    const history = [
      { role: "user", content: "hi", status: "done" },
      { role: "assistant", content: "boom", status: "error" },
    ] as never[];
    const he = offlineRequest("spark-x2.5-1.7b", history, "מה נשמע", "he");
    expect(he.system).toContain("בעברית");
    expect(he.messages.at(-1)).toEqual({ role: "user", content: "מה נשמע" });
    expect(he.messages.some((x) => x.content === "boom")).toBe(false);
    expect(he.maxOutputTokens).toBeGreaterThan(0);
  });
});
