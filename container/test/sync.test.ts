import { describe, expect, it } from "vitest";
import { remoteVaults } from "../src/sync.js";

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
