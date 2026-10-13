import { describe, expect, it } from "vitest";
import { client, password } from "./helpers";

/** The native app (apps/mobile) signs in with a bearer token instead of the cookie. */
describe("native client sessions", () => {
  it("login with x-talorys-client: native returns the token in the body and sets no cookie", async () => {
    const c = client();
    const res = await c.call("/api/auth/login", { method: "POST", body: { password: password() }, headers: { "x-talorys-client": "native" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { authenticated: boolean; token: string };
    expect(body.authenticated).toBe(true);
    expect(body.token.length).toBeGreaterThan(20);

    // The bearer token opens every route, with no cookie and no browser origin.
    const bare = client();
    const auth = { authorization: `Bearer ${body.token}`, origin: "" };
    expect((await bare.call("/api/tasks", { headers: auth })).status).toBe(200);
    expect((await bare.call("/api/tasks", { headers: { authorization: "Bearer nope" } })).status).toBe(401);

    // Logout revokes it.
    expect((await bare.call("/api/auth/logout", { method: "POST", headers: auth })).status).toBe(200);
    expect((await bare.call("/api/tasks", { headers: auth })).status).toBe(401);
  });

  it("a browser login still gets the cookie and no token", async () => {
    const c = client();
    const res = await c.call("/api/auth/login", { method: "POST", body: { password: password() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-talorys_session=/);
    expect("token" in ((await res.json()) as object)).toBe(false);
  });
});
