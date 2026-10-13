import { createPublicKey, createSign, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOwnerSecrets, generateVapidKeys, vapidSubject } from "../src/secrets";

describe("VAPID keys for Web Push", () => {
  it("generates a P-256 pair in the form the agent Worker reads", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const point = Buffer.from(publicKey, "base64url");
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // A second call is a different pair.
    expect(generateVapidKeys().publicKey).not.toBe(publicKey);
  });

  it("the private key signs what the public key verifies (ES256)", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const point = Buffer.from(publicKey, "base64url");
    const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
    const signer = createSign("SHA256").update("header.claims");
    const signature = signer.sign({ key: { ...jwk, d: privateKey }, format: "jwk", dsaEncoding: "ieee-p1363" });
    expect(signature).toHaveLength(64);
    const verify = createVerify("SHA256").update("header.claims");
    expect(verify.verify({ key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("picks a contact the push services accept", () => {
    expect(vapidSubject("owner@example.com", "https://x.pages.dev")).toBe("mailto:owner@example.com");
    expect(vapidSubject(undefined, "https://x.pages.dev")).toBe("https://x.pages.dev");
    expect(vapidSubject("not an email", undefined)).toBe("mailto:owner@talorys.local");
  });

  it("buildOwnerSecrets adds the three push secrets only when asked", async () => {
    const without = await buildOwnerSecrets("Strong-password-123", { includeSessionSecret: false });
    expect(Object.keys(without)).toEqual(["OWNER_PASSWORD_HASH"]);
    const withKeys = await buildOwnerSecrets("Strong-password-123", { includeSessionSecret: true, includeVapid: true, vapidSubject: "mailto:a@b.co" });
    expect(Object.keys(withKeys).sort()).toEqual(["OWNER_PASSWORD_HASH", "SESSION_SECRET", "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]);
    expect(withKeys.VAPID_SUBJECT).toBe("mailto:a@b.co");
  });
});
