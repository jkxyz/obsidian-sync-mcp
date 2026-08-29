import { describe, expect, it } from "vitest";
import {
  remoteVaults,
  runCommand,
  safeEnvironment,
  summarizeSyncRun,
  summarizeSyncStateRows,
  syncConfigArgs,
} from "../src/sync.js";

describe("Obsidian Headless subprocess environment", () => {
  it("uses only the explicit subprocess environment allowlist", () => {
    expect(safeEnvironment({ XDG_CONFIG_HOME: "/tmp/login" })).toMatchObject({
      XDG_CONFIG_HOME: "/tmp/login",
    });
  });

  it("rejects a timeout even when SIGTERM produces exit code zero", async () => {
    await expect(
      runCommand(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
        ],
        {},
        100,
      ),
    ).rejects.toThrow("timed out after 100ms");
  });
});

describe("Obsidian Headless bootstrap configuration", () => {
  it("can mirror the remote vault before enabling writes", () => {
    const args = syncConfigArgs(
      "/data/vault",
      "Cloudflare Obsidian MCP",
      "mirror-remote",
    );

    expect(args).toContain("mirror-remote");
    expect(args).not.toContain("bidirectional");
  });

  it("can enable bidirectional sync after bootstrap", () => {
    const args = syncConfigArgs(
      "/data/vault",
      "Cloudflare Obsidian MCP",
      "bidirectional",
    );

    expect(args).toContain("bidirectional");
    expect(args).not.toContain("mirror-remote");
  });
});

describe("Obsidian Headless diagnostics", () => {
  it("summarizes sync output without retaining vault paths", () => {
    const summary = summarizeSyncRun({
      stdout:
        "Downloading Private/Secret.md\nDownloaded Private/Secret.md\nFully synced\n",
      stderr: "",
    });

    expect(summary).toMatchObject({ downloaded: 1, fullySynced: 1 });
    expect(JSON.stringify(summary)).not.toContain("Secret.md");
  });

  it("counts active and deleted state rows without retaining paths", () => {
    const summary = summarizeSyncStateRows([
      { data: JSON.stringify({ path: "Private.md", folder: false }) },
      { data: JSON.stringify({ path: "Folder", folder: true }) },
      { data: JSON.stringify({ path: "Old.md", deleted: true }) },
      { data: "invalid" },
    ]);

    expect(summary).toEqual({
      entries: 4,
      activeFiles: 1,
      activeFolders: 1,
      deleted: 1,
      unreadable: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("Private.md");
  });
});

describe("Obsidian Headless JSON normalization", () => {
  it("combines owned and shared vaults", () => {
    expect(
      remoteVaults({
        vaults: [{ id: "owned-id", name: "Owned", region: "eu" }],
        shared: [{ id: "shared-id", name: "Shared", region: "us" }],
      }),
    ).toEqual([
      { id: "owned-id", name: "Owned" },
      { id: "shared-id", name: "Shared" },
    ]);
  });

  it("accepts alternate vaultId fields and drops malformed entries", () => {
    expect(
      remoteVaults([
        { vaultId: "legacy-id", name: "Legacy" },
        null,
        { name: 42 },
      ]),
    ).toEqual([{ id: "legacy-id", name: "Legacy" }]);
  });
});
