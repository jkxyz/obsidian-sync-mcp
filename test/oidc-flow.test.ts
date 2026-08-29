import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.js";
import { storeFlow, takeFlow } from "../src/auth/oidc.js";

describe("temporary OAuth flow storage", () => {
  it("encrypts GitHub user tokens and consumes flows once", async () => {
    const values = new Map<string, string>();
    const claims = new Set<string>();
    const env = {
      COOKIE_ENCRYPTION_KEY: "test-cookie-key-with-sufficient-entropy",
      OAUTH_KV: {
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
        get: async (key: string) => values.get(key) ?? null,
        delete: async (key: string) => {
          values.delete(key);
        },
      },
      VAULT_CONTAINER: {
        getByName: () => ({
          claimOAuthFlow: async (nonce: string) => {
            if (claims.has(nonce)) return false;
            claims.add(nonce);
            return true;
          },
        }),
      },
    } as unknown as AppEnv;
    const state = await storeFlow(env, {
      kind: "github-repository-selection",
      adminSub: "admin",
      accessToken: "secret-github-token",
      repositories: [],
    });

    expect([...values.values()].join("\n")).not.toContain(
      "secret-github-token",
    );
    await expect(takeFlow(env, state)).resolves.toMatchObject({
      kind: "github-repository-selection",
      accessToken: "secret-github-token",
    });
    await expect(takeFlow(env, state)).resolves.toBeNull();

    const expiredState = await storeFlow(env, {
      kind: "github-oauth",
      verifier: "verifier",
      adminSub: "admin",
    });
    values.clear();
    await expect(takeFlow(env, expiredState)).resolves.toBeNull();
  });
});
