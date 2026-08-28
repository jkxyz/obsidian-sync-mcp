import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  absoluteVaultPath,
  normalizeVaultPath,
  rejectCaseCollision,
  rejectSymlinkSegments,
  requireNotePath,
} from "../src/path-policy.js";
import { VaultOperationError } from "../src/protocol.js";

const temporaryDirectories: string[] = [];

async function temporaryVault(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "obsidian-path-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vault path policy", () => {
  it("normalizes Unicode and vault-relative separators", () => {
    expect(normalizeVaultPath("Folder/Cafe\u0301.md")).toBe("Folder/Café.md");
    expect(absoluteVaultPath("/vault", "Folder/Note.md")).toBe(
      path.resolve("/vault/Folder/Note.md"),
    );
    expect(requireNotePath("Folder/NOTE.MD")).toBe("Folder/NOTE.MD");
  });

  it.each([
    "",
    "/etc/passwd",
    "../outside.md",
    "folder/../outside.md",
    "folder/./note.md",
    "folder\\note.md",
    ".obsidian/config",
    ".OBSIDIAN/plugins/x",
    ".hidden.md",
    "nul\0byte.md",
  ])("rejects unsafe path %j", (candidate) => {
    expect(() => normalizeVaultPath(candidate)).toThrow(VaultOperationError);
  });

  it("rejects symlink traversal", async () => {
    const vault = await temporaryVault();
    const outside = await temporaryVault();
    await symlink(outside, path.join(vault, "linked"));
    await expect(
      rejectSymlinkSegments(vault, "linked/secret.md"),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects case-insensitive collisions", async () => {
    const vault = await temporaryVault();
    await mkdir(path.join(vault, "Folder"));
    await writeFile(path.join(vault, "Folder", "Note.md"), "content");
    await expect(
      rejectCaseCollision(vault, "folder/other.md"),
    ).rejects.toMatchObject({ code: "already_exists" });
    await expect(
      rejectCaseCollision(vault, "Folder/note.md"),
    ).rejects.toMatchObject({ code: "already_exists" });
  });
});
