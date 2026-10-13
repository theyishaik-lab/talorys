import { afterEach, describe, expect, it, vi } from "vitest";
import { isModelIdFor, modelDisplayName, splitEndpointModel } from "@talorys/shared";
import { quotaHints } from "../src/ai/provider";
import { inAgent, loggedIn } from "./helpers";

describe("OpenAI-compatible endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("model ids are <endpoint>/<model>", () => {
    expect(isModelIdFor("openai-compatible", "ovh/gpt-oss-120b")).toBe(true);
    expect(isModelIdFor("openai-compatible", "groq/openai/gpt-oss-120b")).toBe(true);
    expect(isModelIdFor("openai-compatible", "gpt-oss-120b")).toBe(false);
    expect(isModelIdFor("openai-compatible", "OVH/x")).toBe(false);
    expect(splitEndpointModel("groq/openai/gpt-oss-120b")).toEqual({ endpoint: "groq", model: "openai/gpt-oss-120b" });
    expect(modelDisplayName({ provider: "openai-compatible", model: "ovh/gpt-oss-120b" })).toBe("GPT OSS 120B (OVH)");
    expect(modelDisplayName({ provider: "openai-compatible", model: "groq/qwen/qwen3.8-27b" })).toBe("Qwen3.8 27B (Groq)");
  });

  it("reads the IETF RateLimit-Reset header (OVH: 2 requests per minute)", () => {
    const e = Object.assign(new Error("Too Many Requests"), { statusCode: 429, responseHeaders: { "RateLimit-Reset": "43", "ratelimit-limit": "2" } });
    expect(quotaHints(e, "openai-compatible").retry_after_s).toBe(43);
  });

  it("registers a preset without a key, stores a key encrypted, and puts the endpoint's models in the chain", async () => {
    const c = await loggedIn();
    const ovh = await c.json("/api/ai/endpoints/ovh", { method: "PUT", body: {} });
    expect(ovh.endpoint).toMatchObject({ id: "ovh", name: "OVH AI Endpoints", baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", key: { set: false } });
    expect((await c.call("/api/ai/endpoints/Bad_Id", { method: "PUT", body: {} })).status).toBe(400);
    expect((await c.call("/api/ai/endpoints/plain", { method: "PUT", body: { baseURL: "http://insecure.example/v1" } })).status).toBe(400);
    const groq = await c.json("/api/ai/endpoints/groq", { method: "PUT", body: { key: "gsk_test_key_1234wxyz" } });
    expect(groq.endpoint).toMatchObject({ id: "groq", baseURL: "https://api.groq.com/openai/v1", key: { set: true, hint: "…wxyz" } });
    expect(JSON.stringify(groq)).not.toContain("gsk_test");
    const list = await c.json("/api/ai/endpoints");
    expect(list.endpoints.map((e: { id: string }) => e.id)).toEqual(["groq", "ovh"]);
    expect(list.presets.groq.baseURL).toBe("https://api.groq.com/openai/v1");

    const set = await c.call("/api/settings", {
      method: "PATCH",
      body: { modelProvider: "gemini", model: "gemini-3.8-flash", fallback: { enabled: true, provider: "openai-compatible", model: "groq/openai/gpt-oss-120b", chain: [{ provider: "openai-compatible", model: "ovh/gpt-oss-120b" }] } },
    });
    expect(set.status).toBe(200);
    expect((await c.call("/api/settings", { method: "PATCH", body: { fallback: { chain: [{ provider: "openai-compatible", model: "gpt-oss-120b" }] } } })).status).toBe(400);

    // The endpoint is called at its own base URL, with its key when it has one and with none when not.
    const calls: { url: string; auth: string | null; model: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const body = (await req.clone().json().catch(() => ({}))) as { model?: unknown };
      calls.push({ url: req.url, auth: req.headers.get("authorization"), model: body.model });
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: String(body.model), choices: [{ index: 0, message: { role: "assistant", content: "שלום" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await inAgent(async (a) => {
      const chain = a.providerChain();
      expect(chain.map((p) => `${p.id}:${p.modelId}`)).toEqual(["gemini:gemini-3.8-flash", "openai-compatible:groq/openai/gpt-oss-120b", "openai-compatible:ovh/gpt-oss-120b"]);
      const groqOut = await (chain[1] as { generate: (r: unknown) => Promise<{ text: string }> }).generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100 });
      const ovhOut = await (chain[2] as { generate: (r: unknown) => Promise<{ text: string }> }).generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100 });
      expect(groqOut.text).toBe("שלום");
      expect(ovhOut.text).toBe("שלום");
    });
    expect(calls).toEqual([
      { url: "https://api.groq.com/openai/v1/chat/completions", auth: "Bearer gsk_test_key_1234wxyz", model: "openai/gpt-oss-120b" },
      { url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", auth: null, model: "gpt-oss-120b" },
    ]);

    // A model on an endpoint that is gone fails as "not configured", so the chain moves on.
    expect((await c.call("/api/ai/endpoints/groq", { method: "DELETE" })).status).toBe(200);
    await inAgent(async (a) => {
      const gone = a.providerChain()[1] as { generate: (r: unknown) => Promise<unknown> };
      await expect(gone.generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(await a.services.providerKeys.get("endpoint:groq")).toBeNull();
    });
    await c.call("/api/ai/endpoints/ovh", { method: "DELETE" });
    await c.json("/api/settings", { method: "PATCH", body: { modelProvider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash", fallback: { enabled: false, chain: [] } } });
  });
});
