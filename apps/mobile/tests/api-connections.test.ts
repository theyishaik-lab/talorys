import { describe, expect, it } from "vitest";
import { connectionBody, isDraftReady } from "../src/lib/apiConnections";
import strings from "../src/lib/strings.json";

describe("API connections screen helpers", () => {
  it("sends a new key, keeps the saved one when the field is empty, and removes it only on an existing connection", () => {
    const d = { name: " Weather ", baseURL: "https://api.weather.example/v1 ", authHeader: "X-API-Key", secret: " k-1234 " };
    expect(connectionBody(d, false)).toEqual({ name: "Weather", baseURL: "https://api.weather.example/v1", authHeader: "X-API-Key", secret: "k-1234" });
    expect(connectionBody({ ...d, secret: "" }, true)).not.toHaveProperty("secret");
    expect(connectionBody({ ...d, secret: null }, true)).toMatchObject({ secret: null });
    expect(connectionBody({ ...d, secret: null }, false)).not.toHaveProperty("secret");
    expect(connectionBody({ ...d, authHeader: "" }, false).authHeader).toBe("Authorization");
  });

  it("only saves https base URLs with a name and a valid header name", () => {
    expect(isDraftReady({ name: "מזג אוויר", baseURL: "https://api.example.com", authHeader: "Authorization" })).toBe(true);
    expect(isDraftReady({ name: "x", baseURL: "http://api.example.com", authHeader: "Authorization" })).toBe(false);
    expect(isDraftReady({ name: "", baseURL: "https://api.example.com", authHeader: "Authorization" })).toBe(false);
    expect(isDraftReady({ name: "x", baseURL: "https://api.example.com", authHeader: "Bad Header" })).toBe(false);
  });

  it("has the Hebrew title the settings list shows", () => {
    expect(strings.he["settings.tab.Api"]).toBe("חיבורי API");
  });
});
