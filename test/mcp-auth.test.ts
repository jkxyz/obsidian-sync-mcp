import { describe, expect, it, vi } from "vitest";
import { effectiveScopesForRequest } from "../src/mcp/server.js";

describe("MCP OAuth authorization", () => {
  it("passes the effective access-token scopes to MCP tools", async () => {
    const unwrapToken = vi.fn(async (token: string) =>
      token === "access-token"
        ? { scope: ["vault.read", "vault.write"] }
        : null,
    );
    const request = new Request("https://example.test/mcp", {
      headers: { authorization: "Bearer access-token" },
    });

    await expect(
      effectiveScopesForRequest(request, { unwrapToken }),
    ).resolves.toEqual(["vault.read", "vault.write"]);
    expect(unwrapToken).toHaveBeenCalledWith("access-token");
  });

  it("does not grant scopes without a valid provider-issued token", async () => {
    const unwrapToken = vi.fn(async () => null);

    await expect(
      effectiveScopesForRequest(new Request("https://example.test/mcp"), {
        unwrapToken,
      }),
    ).resolves.toEqual([]);
    expect(unwrapToken).not.toHaveBeenCalled();
  });
});
