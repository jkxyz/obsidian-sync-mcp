import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeGitHubCode,
  listGitHubBranches,
  missingGitHubBindings,
  validateGitHubBranch,
} from "../src/github.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub repository selection", () => {
  it("reports absent GitHub App bindings before OAuth starts", () => {
    const env = {
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    } as never;

    expect(missingGitHubBindings(env)).toEqual([
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
    ]);
  });

  it("surfaces GitHub OAuth error responses without a schema exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          error: "incorrect_client_credentials",
          error_description: "The client credentials are incorrect.",
        }),
      ),
    );

    await expect(
      exchangeGitHubCode(
        new Request("https://worker.example/admin/github/callback?code=code"),
        {
          GITHUB_APP_CLIENT_ID: "client-id",
          GITHUB_APP_CLIENT_SECRET: "client-secret",
        } as never,
        "verifier",
      ),
    ).rejects.toThrow(
      "GitHub OAuth token exchange failed (incorrect_client_credentials)",
    );
  });

  it("permits main for an empty repository with a null default branch", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ size: 0, default_branch: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateGitHubBranch("token", "owner/empty", "main"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats GitHub's empty-repository branch response as no branches", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 409 })),
    );

    await expect(listGitHubBranches("token", "owner/empty")).resolves.toEqual(
      [],
    );
  });
});
