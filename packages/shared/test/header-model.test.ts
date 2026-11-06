import { describe, expect, it } from "vitest";
import { headerModel } from "../src/attribution";

const main = { provider: "openai-compatible", model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b" };
const reply = (model: string, provider = "openai-compatible", status = "complete") => ({ role: "assistant", status, ai: { provider, model, fallback: true, attempts: [] } });

describe("headerModel", () => {
  it("shows the main model in a new chat", () => {
    const m = headerModel({ messages: [], main });
    expect(m?.model).toBe(main.model);
    expect(m?.local).toBe(false);
  });
  it("shows the model that wrote the last reply", () => {
    const m = headerModel({ messages: [reply("deepseek/deepseek-flash"), { role: "user" }], main });
    expect(m?.model).toBe("deepseek/deepseek-flash");
    expect(m?.label).toBe("Deepseek Flash");
  });
  it("skips failed replies", () => {
    const m = headerModel({ messages: [reply("a/good"), reply("b/bad", "openai-compatible", "error")], main });
    expect(m?.model).toBe("a/good");
  });
  it("while streaming: the announced backup, else the main model", () => {
    expect(headerModel({ messages: [reply("a/old")], streaming: true, main })?.model).toBe(main.model);
    expect(headerModel({ messages: [reply("a/old")], streaming: true, streamAi: { provider: "gemini", model: "gemini-3.5-flash", fallback: true, attempts: [] }, main })?.label).toBe("Gemini 3.5 Flash");
  });
  it("marks phone models as local", () => {
    expect(headerModel({ messages: [reply("device:spark-x2.5-1.7b", "device")] })?.local).toBe(true);
    expect(headerModel({ messages: [{ role: "assistant", status: "complete", ai: { provider: "x", model: "y", fallback: true, attempts: [], local: true } }] })?.local).toBe(true);
  });
  it("returns null with nothing to show", () => {
    expect(headerModel({})).toBeNull();
  });
});
