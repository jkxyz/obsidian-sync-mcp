import { describe, expect, it } from "vitest";
import {
  cookieValue,
  createPkce,
  decryptJson,
  encryptJson,
  signValue,
  verifySignedValue,
} from "../src/auth/crypto.js";

describe("authentication cryptography", () => {
  it("signs values and rejects tampering", async () => {
    const signed = await signValue("flow-id", "test-secret");
    expect(await verifySignedValue(signed, "test-secret")).toBe("flow-id");
    expect(await verifySignedValue(`${signed}x`, "test-secret")).toBeNull();
    expect(await verifySignedValue(signed, "different-secret")).toBeNull();
  });

  it("encrypts credential-shaped JSON with authenticated encryption", async () => {
    const input = { token: "secret-token", vault: "vault-id" };
    const envelope = await encryptJson(input, "encryption-secret");
    expect(envelope).not.toContain(input.token);
    expect(await decryptJson(envelope, "encryption-secret")).toEqual(input);
    expect(await decryptJson(`${envelope}x`, "encryption-secret")).toBeNull();
  });

  it("creates an RFC 7636-sized PKCE verifier and challenge", async () => {
    const pair = await createPkce();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("parses exact cookie names", () => {
    const request = new Request("https://example.test", {
      headers: { cookie: "one=1; session=a=b=c; session_extra=no" },
    });
    expect(cookieValue(request, "session")).toBe("a=b=c");
    expect(cookieValue(request, "missing")).toBeNull();
  });
});
