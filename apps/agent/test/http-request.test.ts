import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TOOLS, runApprovedAction, ToolExecutor } from "../src/tools";
import { buildRequest, MAX_RESPONSE_BYTES, MODEL_BODY_CHARS, redactSecret, sendRequest } from "../src/http/request";
import { assertPublicDestination, assertPublicUrl, isPrivateAddress } from "../src/http/ssrf";
import type { ApiConnection } from "../src/http/connections";
import { buildSystemPrompt } from "../src/agent/prompt";
import { inAgent, loggedIn } from "./helpers";

const SECRET = "Bearer tok_test_TOPSECRET_9f3Kq2";
const conn: ApiConnection = { id: "weather", name: "Weather", baseURL: "https://api.weather.example/v1", authHeader: "Authorization" };
const publicDns = async () => ["93.184.216.34"];

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch stub: answers DNS-over-HTTPS with a public address and everything else with `respond`. */
function stubFetch(respond: (req: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.url.startsWith("https://cloudflare-dns.com/")) {
        const type = new URL(req.url).searchParams.get("type");
        return Response.json({ Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] }, { headers: { "content-type": "application/dns-json" } });
      }
      const headers: Record<string, string> = Object.fromEntries(req.headers.entries());
      const s: Seen = { url: req.url, method: req.method, headers, body: req.body ? await req.text() : null };
      seen.push(s);
      return respond(s);
    }),
  );
  return seen;
}

describe("http_request: SSRF guard", () => {
  it("blocks loopback, private, link-local/metadata, CGNAT and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "1.1.1.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("blocks the IPv6 equivalents, including IPv4-mapped and NAT64 forms of private addresses", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "2002:c0a8:0101::1", "2001:db8::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("checks the host as URL parsing normalizes it (decimal, hex, bracketed IPv6) and refuses internal names and other schemes", () => {
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]:8080/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/", "http://localhost:8787/", "http://api.localhost/", "http://metadata.google.internal/", "http://printer.local/", "http://intranet/", "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/"]) {
      expect(() => assertPublicUrl(new URL(u)), u).toThrow();
    }
    expect(() => assertPublicUrl(new URL("https://api.example.com/v1"))).not.toThrow();
    expect(() => assertPublicUrl(new URL("http://93.184.216.34/"))).not.toThrow();
  });

  it("refuses a public-looking name that resolves to a private address; a resolver outage falls back to the literal checks", async () => {
    await expect(assertPublicDestination(new URL("https://rebind.example.com/"), async () => ["10.0.0.5"])).rejects.toThrow(/resolves to 10\.0\.0\.5/);
    await expect(assertPublicDestination(new URL("https://rebind.example.com/"), async () => ["93.184.216.34", "::1"])).rejects.toThrow(/::1/);
    await expect(assertPublicDestination(new URL("https://nothing.example.com/"), async () => [])).rejects.toThrow(/does not resolve/);
    await expect(assertPublicDestination(new URL("https://ok.example.com/"), publicDns)).resolves.toBeUndefined();
    await expect(assertPublicDestination(new URL("https://ok.example.com/"), async () => null)).resolves.toBeUndefined();
  });
});

describe("http_request: building the request", () => {
  it("joins the connection's base URL, the path and the query", () => {
    const r = buildRequest({ method: "GET", url: "/forecast", connection: "Weather", query: { city: "Tel Aviv", days: 3, metric: true } }, conn);
    expect(r.url.href).toBe("https://api.weather.example/v1/forecast?city=Tel+Aviv&days=3&metric=true");
    expect(r.timeoutMs).toBe(15_000);
    expect(r.headers.get("authorization")).toBeNull(); // the secret is added only at send time
  });

  it("keeps a connection's key on its own host: no escaping the base path, no other origin", () => {
    expect(() => buildRequest({ method: "GET", url: "../../admin" }, conn)).toThrow(/under/);
    expect(() => buildRequest({ method: "GET", url: "https://evil.example/steal" }, conn)).toThrow(/path under/);
    expect(() => buildRequest({ method: "GET", url: "//evil.example/steal" }, conn)).toThrow(/not a valid URL|path under/);
    expect(buildRequest({ method: "GET", url: "https://api.weather.example/v1/now" }, conn).url.pathname).toBe("/v1/now");
  });

  it("refuses transport and cookie headers and the connection's own auth header", () => {
    expect(() => buildRequest({ method: "GET", url: "https://a.example/", headers: { Host: "x" } }, null)).toThrow(/cannot be set/);
    expect(() => buildRequest({ method: "GET", url: "https://a.example/", headers: { Cookie: "s=1" } }, null)).toThrow(/cannot be set/);
    expect(() => buildRequest({ method: "GET", url: "/x", headers: { authorization: "Bearer guess" } }, conn)).toThrow(/set by the connection/);
    expect(buildRequest({ method: "GET", url: "https://a.example/", headers: { "X-Trace": "1" } }, null).headers.get("x-trace")).toBe("1");
  });

  it("sends JSON objects as application/json and text as text/plain; GET has no body; timeouts are bounded", () => {
    const json = buildRequest({ method: "POST", url: "https://a.example/items", body: { title: "חלב", qty: 2 } }, null);
    expect(json.body).toBe('{"title":"חלב","qty":2}');
    expect(json.headers.get("content-type")).toBe("application/json");
    const text = buildRequest({ method: "PUT", url: "https://a.example/note", body: "hello" }, null);
    expect(text.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(() => buildRequest({ method: "GET", url: "https://a.example/", body: { a: 1 } }, null)).toThrow(/GET request has no body/);
    expect(buildRequest({ method: "GET", url: "https://a.example/", timeout_ms: 999_999 }, null).timeoutMs).toBe(30_000);
  });
});

describe("http_request: sending", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("injects the secret under the connection's header, and hides it if the server echoes it", async () => {
    const seen: Seen[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, method: String(init.method), headers: Object.fromEntries(h.entries()), body: null });
      return Response.json({ you_sent: h.get("authorization"), token_only: "tok_test_TOPSECRET_9f3Kq2" }, { headers: { "x-ratelimit-remaining": "41", "set-cookie": "s=1" } });
    }) as unknown as typeof fetch;
    const r = await sendRequest(buildRequest({ method: "GET", url: "/now" }, conn), conn, { secret: SECRET, resolve: publicDns, fetcher });
    expect(seen[0]!.headers.authorization).toBe(SECRET);
    expect(r.status).toBe(200);
    expect(r.headers["x-ratelimit-remaining"]).toBe("41");
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
    expect(r.body).toEqual({ you_sent: "[secret hidden]", token_only: "[secret hidden]" });
  });

  it("follows redirects by hand: each hop is SSRF-checked and the key never leaves the connection's origin", async () => {
    const hops: Seen[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      hops.push({ url, method: String(init.method), headers: Object.fromEntries(new Headers(init.headers).entries()), body: null });
      if (url.includes("/moved")) return new Response(null, { status: 302, headers: { location: "https://cdn.other.example/file.json" } });
      if (url.includes("/internal")) return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return Response.json({ ok: 1 });
    }) as unknown as typeof fetch;
    const r = await sendRequest(buildRequest({ method: "GET", url: "/moved" }, conn), conn, { secret: SECRET, resolve: publicDns, fetcher });
    expect(r.redirected_to).toBe("https://cdn.other.example/file.json");
    expect(hops[0]!.headers.authorization).toBe(SECRET);
    expect(hops[1]!.headers.authorization).toBeUndefined();
    await expect(sendRequest(buildRequest({ method: "GET", url: "/internal" }, conn), conn, { secret: SECRET, resolve: publicDns, fetcher })).rejects.toThrow(/Blocked/);
  });

  it("caps what is read from the network and what the model sees", async () => {
    const big = "א".repeat(MAX_RESPONSE_BYTES); // 2 bytes each: twice the cap
    const fetcher = (async () => new Response(big, { headers: { "content-type": "text/plain; charset=utf-8" } })) as unknown as typeof fetch;
    const r = await sendRequest(buildRequest({ method: "GET", url: "https://big.example/" }, null), null, { resolve: publicDns, fetcher });
    expect(r.body_bytes).toBe(MAX_RESPONSE_BYTES);
    expect(r.truncated).toBe(true);
    expect((r.body as string).length).toBe(MODEL_BODY_CHARS);
    expect(r.note).toMatch(/cut to 8000/);
    const bin = await sendRequest(buildRequest({ method: "GET", url: "https://img.example/a.png" }, null), null, { resolve: publicDns, fetcher: (async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch });
    expect(bin.body).toBeNull();
    expect(bin.note).toMatch(/Binary/);
  });

  it("times out", async () => {
    const fetcher = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    await expect(sendRequest(buildRequest({ method: "GET", url: "https://slow.example/", timeout_ms: 1_000 }, null), null, { resolve: publicDns, fetcher })).rejects.toThrow(/within 1 s/);
  });

  it("redacts a Bearer secret's token part too", () => {
    expect(redactSecret("x Bearer abcdefgh123 y abcdefgh123", "Bearer abcdefgh123")).toBe("x [secret hidden] y [secret hidden]");
  });
});

describe("http_request: the tool, connections and approvals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores a connection's secret encrypted and only ever returns its last four characters", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/http/connections", { method: "POST", body: { name: "Weather", baseURL: "https://api.weather.example/v1", authHeader: "Authorization", secret: SECRET } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created.connection).toMatchObject({ id: "weather", name: "Weather", authHeader: "Authorization", secret: { set: true, hint: "…3Kq2" } });
    const list = (await c.json("/api/http/connections")) as any;
    expect(list.settings).toEqual({ confirmNonGet: true });
    expect(list.secrets_available).toBe(true);
    expect(JSON.stringify(list)).not.toContain("TOPSECRET");
    expect((await c.call("/api/http/connections", { method: "POST", body: { name: "Plain", baseURL: "http://api.example.com" } })).status).toBe(400);
    expect((await c.call("/api/http/connections", { method: "POST", body: { name: "Bad", baseURL: "https://x.example", authHeader: "Cookie" } })).status).toBe(400);
    // Hebrew name → a generated id; moving the base URL to another host drops the stored key.
    const he = (await c.json("/api/http/connections", { method: "POST", body: { name: "מזג אוויר", baseURL: "https://he.example", secret: "abcd1234" } })) as any;
    expect(he.connection.id).toMatch(/^api-[a-z0-9]+$/);
    const moved = (await c.json(`/api/http/connections/${he.connection.id}`, { method: "PUT", body: { baseURL: "https://other.example" } })) as any;
    expect(moved.connection.secret.set).toBe(false);
    expect((await c.call(`/api/http/connections/${he.connection.id}`, { method: "DELETE" })).status).toBe(200);
    await inAgent(async (a) => {
      const raw = JSON.stringify(a.services.db.all(`SELECT key, value FROM tal_settings`));
      expect(raw).not.toContain("TOPSECRET");
      expect(await a.services.apiConnections.secret("weather")).toBe(SECRET);
    });
    const off = (await c.json("/api/http/settings", { method: "PUT", body: { confirmNonGet: false } })) as any;
    expect(off.settings.confirmNonGet).toBe(false);
    await c.call("/api/http/settings", { method: "PUT", body: { confirmNonGet: true } });
  });

  it("GET runs now with the key injected; the model sees the result, never the key", async () => {
    const seen = stubFetch(() => Response.json({ temp_c: 24, city: "Tel Aviv" }));
    await inAgent(async (a) => {
      const s = a.services;
      s.apiConnections.upsert("weather", { name: "Weather", baseURL: "https://api.weather.example/v1", authHeader: "X-API-Key" });
      await s.apiConnections.setSecret("weather", "k-123456789");
      const ex = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat", conversationId: s.conversations.create().id }, { maxToolCalls: 5 });
      const out = (await ex.execute("http_request", { url: "/now", connection: "weather", query: { city: "Tel Aviv" } }, "call-1")) as any;
      expect(out).toMatchObject({ status: 200, ok: true, connection: "Weather", body: { temp_c: 24 } });
      expect(seen[0]).toMatchObject({ method: "GET", url: "https://api.weather.example/v1/now?city=Tel+Aviv" });
      expect(seen[0]!.headers["x-api-key"]).toBe("k-123456789");
      expect(JSON.stringify(out)).not.toContain("k-123456789");
      await expect(ex.execute("http_request", { url: "/now", connection: "nope" })).rejects.toThrow(/Saved connections: “Weather”/);
      await expect(ex.execute("http_request", { url: "http://10.0.0.1/admin" })).rejects.toThrow(/Blocked/);
    });
  });

  it("anything but GET waits for the owner's Approve (setting on by default) and is sent only after it", async () => {
    const seen = stubFetch((r) => Response.json({ id: 7, got: r.body ? JSON.parse(r.body) : null }, { status: 201 }));
    await inAgent(async (a) => {
      const s = a.services;
      s.apiConnections.upsert("todo", { name: "Todo API", baseURL: "https://todo.example/api", authHeader: "Authorization" });
      await s.apiConnections.setSecret("todo", SECRET);
      const conversation = s.conversations.create();
      const ctx = { services: s, timezone: "UTC", mode: "chat" as const, conversationId: conversation.id };
      const ex = new ToolExecutor(ALL_TOOLS, ctx, { maxToolCalls: 5 });
      const out = (await ex.execute("http_request", { method: "POST", url: "/items", connection: "Todo API", json: { title: "Buy milk" } }, "call-2")) as any;
      expect(out.status).toBe("awaiting_owner_approval");
      expect(out.action).toBe('POST https://todo.example/api/items · Todo API · body {"title":"Buy milk"}');
      expect(seen).toHaveLength(0);
      const action = ex.approvalFor("call-2")!;
      expect(action.status).toBe("pending");
      const stored = s.pendingActions.get(action.id)!;
      expect(stored.target_id).not.toContain("TOPSECRET");

      const done = await runApprovedAction(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat" }, action.id);
      expect(done.status).toBe("approved");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "POST", url: "https://todo.example/api/items", body: '{"title":"Buy milk"}' });
      expect(seen[0]!.headers.authorization).toBe(SECRET);
      expect(s.notifications.list({ limit: 5 }).some((n) => n.title === "Request sent")).toBe(true);
      await expect(runApprovedAction(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat" }, action.id)).rejects.toThrow(/already handled/);

      // A declined (cancelled) request is never sent.
      const ex2 = new ToolExecutor(ALL_TOOLS, ctx, { maxToolCalls: 5 });
      await ex2.execute("http_request", { method: "DELETE", url: "/items/7", connection: "todo" }, "call-3");
      s.pendingActions.resolve(ex2.approvalFor("call-3")!.id, "cancelled");
      expect(seen).toHaveLength(1);

      // With the setting off, the owner chose to let non-GET requests run directly.
      s.apiConnections.setConfig({ confirmNonGet: false });
      const ex3 = new ToolExecutor(ALL_TOOLS, ctx, { maxToolCalls: 5 });
      const direct = (await ex3.execute("http_request", { method: "PATCH", url: "/items/7", connection: "todo", json: { done: true } }, "call-4")) as any;
      expect(direct.status).toBe(201);
      expect(seen).toHaveLength(2);
      s.apiConnections.setConfig({ confirmNonGet: true });
    });
  });

  it("scheduled automations can only GET, whatever the approval setting", async () => {
    const seen = stubFetch(() => Response.json({ ok: true }));
    await inAgent(async (a) => {
      const s = a.services;
      for (const confirmNonGet of [true, false]) {
        s.apiConnections.setConfig({ confirmNonGet });
        const ex = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 5 });
        expect(ex.available().map((t) => t.name)).toContain("http_request");
        await expect(ex.execute("http_request", { method: "POST", url: "https://hooks.example/run", json: { a: 1 } })).rejects.toThrow(/only make GET/);
        expect(((await ex.execute("http_request", { url: "https://status.example/health" })) as any).status).toBe(200);
      }
      s.apiConnections.setConfig({ confirmNonGet: true });
    });
    expect(seen.map((x) => x.method)).toEqual(["GET", "GET"]);
  });

  it("tells the model which connections exist and that it may call APIs", () => {
    const base = { agentName: "T", timezone: "UTC", now: new Date(), autoMemory: false, memories: [] };
    expect(buildSystemPrompt({ ...base, apiConnections: ["Weather"] })).toContain("Saved API connections (pass the name as `connection`; the key is added for you): “Weather”");
    expect(buildSystemPrompt({ ...base, scheduled: true })).toContain("only GET requests are possible");
  });
});
