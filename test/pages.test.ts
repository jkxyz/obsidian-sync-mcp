import { describe, expect, it } from "vitest";
import {
  adminPage,
  githubBranchPage,
  githubRepositoryPage,
  homePage,
} from "../src/auth/pages.js";

const SOURCE_URL = "https://github.com/jkxyz/obsidian-sync-mcp";

describe("interactive source offer", () => {
  it("links the public source and AGPL license from public pages", async () => {
    const html = await homePage().text();

    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html).toContain("AGPL-3.0-or-later");
    expect(html).toContain("No warranty");
  });

  it("links the public source from the authenticated admin page", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: false,
    }).text();

    expect(html).toContain(`href="${SOURCE_URL}"`);
  });

  it("shows separate GitHub reconciliation controls", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: true,
      vault: "Vault",
      git: {
        configured: true,
        repository: "owner/private-vault",
        branch: "main",
        mode: "active",
        status: { state: "converged" },
      },
    }).text();

    expect(html).toContain("owner/private-vault");
    expect(html).toContain("/admin/github/reconcile");
    expect(html).toContain("/admin/github/disconnect");
  });

  it("keeps an approved base manual until the schedule is explicitly enabled", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: true,
      vault: "Vault",
      git: {
        configured: true,
        repository: "owner/private-vault",
        branch: "main",
        baseCommit: "a".repeat(40),
        mode: "paused",
        status: { state: "converged" },
      },
    }).text();

    expect(html).toContain("Run manual reconciliation");
    expect(html).toContain("Enable one-minute schedule");
    expect(html).not.toContain("Preview initial reconciliation");
  });

  it("shows verification state without offering reconciliation controls", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: true,
      vault: "Vault",
      status: { runtime: { state: "verifying" } },
      git: {
        configured: true,
        repository: "owner/private-vault",
        branch: "main",
        mode: "active",
        status: { state: "converged" },
      },
    }).text();

    expect(html).toContain("being rechecked independently");
    expect(html).not.toContain("Reconcile now");
  });

  it("renders candidate-bound quarantine controls", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: true,
      vault: "Vault",
      git: {
        configured: true,
        repository: "owner/private-vault",
        branch: "main",
        mode: "quarantined",
        status: {
          state: "blocked",
          blocked_reason: "destructive_change",
          safety_event: {
            event_id: "11111111-1111-4111-8111-111111111111",
            phase: "remote_mirror",
            previous_files: 300,
            candidate_files: 3,
            deleted_files: 297,
            previous_bytes: 300_000,
            deleted_bytes: 297_000,
            reasons: ["at_least_half_of_paths"],
            paths: ["preview.md"],
            path_count: 297,
          },
        },
      },
    }).text();

    expect(html).toContain("Approve this exact candidate");
    expect(html).toContain("Reject and republish safe vault");
    expect(html).toContain("Refresh this preview");
    expect(html).toContain("Download the complete manifest");
  });

  it("does not offer GitHub OAuth when its Worker bindings are missing", async () => {
    const html = await adminPage({
      email: "owner@example.com",
      csrf: "csrf",
      configured: true,
      githubConfigurationError:
        "GitHub integration is missing Worker bindings: GITHUB_APP_CLIENT_ID.",
    }).text();

    expect(html).toContain("GITHUB_APP_CLIENT_ID");
    expect(html).not.toContain('href="/admin/github/connect"');
  });

  it("renders only server-validated GitHub repository choices", async () => {
    const html = await githubRepositoryPage({
      email: "owner@example.com",
      csrf: "csrf",
      state: "state",
      installUrl: "https://github.com/apps/example/installations/new",
      repositories: [
        {
          fullName: "owner/private-vault",
          defaultBranch: "main",
          private: true,
        },
      ],
    }).text();

    expect(html).toContain("owner/private-vault");
    expect(html).toContain('action="/admin/github/repository"');
    expect(html).toContain('name="repository_index"');
    expect(html).not.toContain("access_token");
  });

  it("renders server-validated branch choices", async () => {
    const html = await githubBranchPage({
      email: "owner@example.com",
      csrf: "csrf",
      state: "state",
      repository: "owner/private-vault",
      branches: ["main", "notes"],
    }).text();

    expect(html).toContain('<option value="main">main</option>');
    expect(html).toContain('<option value="notes">notes</option>');
    expect(html).toContain('action="/admin/github/configure"');
  });
});
