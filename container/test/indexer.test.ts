import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultIndexer } from "../src/indexer.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  root: string;
  vault: string;
  indexer: VaultIndexer;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-indexer-"));
  temporaryDirectories.push(root);
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "Folder"), { recursive: true });
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await writeFile(
    path.join(vault, "Alpha.md"),
    `---\ntitle: Alpha title\nstatus: active\ntags:\n  - Project\n  - Important\n---\n# Alpha heading\nThe searchable phrase is here. #inline\n[[Folder/Target]] and [[Missing]]\n`,
  );
  await writeFile(
    path.join(vault, "Folder", "Target.md"),
    "# Target\nBacklink destination.\n",
  );
  await writeFile(
    path.join(vault, "asset.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  await writeFile(
    path.join(vault, ".obsidian", "private.md"),
    "must not be indexed",
  );
  const indexer = new VaultIndexer(vault, path.join(root, "index.sqlite"));
  await indexer.rebuild();
  return { root, vault, indexer };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vault index", () => {
  it("indexes searchable content, tags, properties, and link relationships", async () => {
    const { indexer } = await fixture();
    try {
      expect(indexer.counts()).toEqual({ files: 3, notes: 2, attachments: 1 });
      const result = indexer.search({
        query: "searchable phrase",
        tags: ["project"],
        properties: { status: "active" },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        path: "Alpha.md",
        title: "Alpha title",
        tags: expect.arrayContaining(["project", "important", "inline"]),
      });
      expect(indexer.links("Folder/Target.md").backlinks).toEqual([
        { source: "Alpha.md", raw: "Folder/Target" },
      ]);
      expect(indexer.links("Alpha.md").unresolved).toEqual([
        { raw: "Missing" },
      ]);
    } finally {
      indexer.close();
    }
  });

  it("paginates deterministic listings and validates cursors", async () => {
    const { indexer } = await fixture();
    try {
      const first = indexer.list({ limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.cursor).toBeTypeOf("string");
      const second = indexer.list({ limit: 1, cursor: first.cursor });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]).not.toEqual(first.items[0]);
      expect(() => indexer.list({ cursor: "not-a-cursor" })).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    } finally {
      indexer.close();
    }
  });
});
