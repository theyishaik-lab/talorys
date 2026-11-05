import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, client, freshIp, inAgent, loggedIn, password } from "./helpers";

/** The device bridge end to end: the phone's WebSocket through the Worker into the agent's Durable Object. */

async function nativeToken(): Promise<string> {
  const c = client();
  const res = await c.call("/api/auth/login", { method: "POST", body: { password: password() }, headers: { "x-talorys-client": "native" } });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("no native token");
  return body.token;
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(`${BASE}${path}`, { headers: { upgrade: "websocket", "cf-connecting-ip": freshIp(), ...headers } }),
  );
}

/** Opens the bridge as a phone; frames the agent sends land in `inbox`. */
async function connectPhone(token: string) {
  const res = await upgrade("/api/device/bridge", { authorization: `Bearer ${token}` });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    inbox.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code, reason: e.reason };
  });
  ws.accept();
  const next = (type: string, ms = 5000) =>
    new Promise<any>((resolve, reject) => {
      const found = inbox.find((m) => m.type === type);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return resolve(found);
      }
      const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), ms);
      const wait = (m: any) => {
        if (m.type === type) {
          clearTimeout(timer);
          inbox.splice(inbox.indexOf(m), 1);
          resolve(m);
        } else waiters.push(wait);
      };
      waiters.push(wait);
    });
  return { ws, next, send: (m: object) => ws.send(JSON.stringify(m)), closed: () => closed };
}

const hello = (models: object[]) => ({ type: "hello", protocol: 1, device_id: "test-phone", device_name: "Test Pixel", app_version: "0.5.0", capabilities: ["generate"], models });

describe("device bridge WebSocket", () => {
  it("refuses WebSocket upgrades anywhere but the bridge path", async () => {
    const res = await upgrade("/api/chat/stream");
    expect(res.status).toBe(400);
  });

  it("closes a bridge socket without a valid native token (4401)", async () => {
    const res = await upgrade("/api/device/bridge", { authorization: "Bearer not-a-token" });
    if (res.status === 101) {
      const ws = res.webSocket!;
      const code = await new Promise<number>((resolve) => {
        ws.addEventListener("close", (e) => resolve(e.code));
        ws.accept();
      });
      expect(code).toBe(4401);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("an authenticated phone is welcomed, shows in /api/device/status and answers a device chain entry", async () => {
    const token = await nativeToken();
    const phone = await connectPhone(token);
    expect(await phone.next("welcome")).toMatchObject({ protocol: 1 });
    phone.send(hello([{ id: "gemma-4-e4b", state: "downloaded", use_in_chain: true, ram: "ok" }]));

    const owner = await loggedIn();
    // The hello is processed asynchronously; poll the status briefly.
    let status: any = null;
    for (let i = 0; i < 20; i++) {
      status = await owner.json("/api/device/status");
      if (status.devices.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status.devices[0]).toMatchObject({ device_id: "test-phone", device_name: "Test Pixel" });
    expect(status.models.find((m: any) => m.id === "gemma-4-e4b")).toMatchObject({ available: true });
    expect(status.models.find((m: any) => m.id === "spark-x2.5-1.7b")).toMatchObject({ available: false, reason: "not_downloaded" });

    // The phone answers whatever the agent asks it.
    void (async () => {
      const gen = await phone.next("generate");
      phone.send({ type: "accepted", id: gen.id });
      phone.send({ type: "token", id: gen.id, delta: "Hi from " });
      phone.send({ type: "token", id: gen.id, delta: "the phone" });
      phone.send({ type: "done", id: gen.id, usage: { input_tokens: 5, output_tokens: 4 } });
    })();
    const answer = await inAgent(async (agent) => {
      const p = agent.providerFor("device", "gemma-4-e4b")!;
      return p.generate({ system: "You are Talorys.", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 512 });
    });
    expect(answer.text).toBe("Hi from the phone");
    phone.ws.close(1000, "bye");
  });

  it("a device model can be stored anywhere in the chain and shows in /api/ai/chain", async () => {
    const owner = await loggedIn();
    const before = await owner.json("/api/settings");
    const res = await owner.call("/api/settings", {
      method: "PATCH",
      body: { fallback: { enabled: true, chain: [...before.settings.fallback.chain, { provider: "device", model: "spark-x2.5-1.7b" }] } },
    });
    expect(res.status).toBe(200);
    const chain = await owner.json("/api/ai/chain");
    const entry = chain.entries.find((e: any) => e.provider === "device");
    expect(entry).toMatchObject({ model: "spark-x2.5-1.7b", provider_label: "Phone", label: "Spark X2.5 1.7B" });
    expect(entry.state === "offline" || entry.state === "available").toBe(true);
    // An unknown device model id is rejected.
    const bad = await owner.call("/api/settings", { method: "PATCH", body: { fallback: { chain: [{ provider: "device", model: "llama-70b" }] } } });
    expect(bad.status).toBe(400);
    // The catalog lists the device provider.
    const models = await owner.json("/api/ai/models");
    expect(models.providers.find((p: any) => p.id === "device").models.map((m: any) => m.id)).toEqual(["spark-x2.5-1.7b", "gemma-4-e4b"]);
    // Leave the chain as it was.
    await owner.call("/api/settings", { method: "PATCH", body: { fallback: before.settings.fallback } });
  });
});
