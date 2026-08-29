import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  applyTreeDelta,
  analyzeDeletion,
  buildRestoreUnion,
  mergeTrees,
  GitRepository,
  recoverVaultSwap,
  type Tree,
  type TreeEntry,
} from "../src/git.js";

const exec = promisify(execFile);

const blob = (oid: string): TreeEntry => ({ mode: "100644", oid });
const tree = (entries: Record<string, TreeEntry>): Tree =>
  new Map(Object.entries(entries));

describe("full-vault three-way reconciliation", () => {
  it.each([
    {
      name: "Git-only modification",
      base: blob("base"),
      git: blob("git"),
      obsidian: blob("base"),
      expected: blob("git"),
      conflicts: 0,
    },
    {
      name: "Obsidian-only modification",
      base: blob("base"),
      git: blob("base"),
      obsidian: blob("obsidian"),
      expected: blob("obsidian"),
      conflicts: 0,
    },
    {
      name: "same modification",
      base: blob("base"),
      git: blob("same"),
      obsidian: blob("same"),
      expected: blob("same"),
      conflicts: 0,
    },
    {
      name: "concurrent modification",
      base: blob("base"),
      git: blob("git"),
      obsidian: blob("obsidian"),
      expected: blob("obsidian"),
      conflicts: 1,
    },
    {
      name: "Git deletion",
      base: blob("base"),
      git: undefined,
      obsidian: blob("base"),
      expected: undefined,
      conflicts: 0,
    },
    {
      name: "Obsidian deletion",
      base: blob("base"),
      git: blob("base"),
      obsidian: undefined,
      expected: undefined,
      conflicts: 0,
    },
    {
      name: "Git edit versus Obsidian deletion",
      base: blob("base"),
      git: blob("git"),
      obsidian: undefined,
      expected: undefined,
      conflicts: 1,
    },
    {
      name: "Git deletion versus Obsidian edit",
      base: blob("base"),
      git: undefined,
      obsidian: blob("obsidian"),
      expected: blob("obsidian"),
      conflicts: 1,
    },
  ])("resolves $name", ({ base, git, obsidian, expected, conflicts }) => {
    const result = mergeTrees(
      tree(base ? { "Note.md": base } : {}),
      tree(git ? { "Note.md": git } : {}),
      tree(obsidian ? { "Note.md": obsidian } : {}),
    );

    expect(result.tree.get("Note.md")).toEqual(expected);
    expect(result.conflictCount).toBe(conflicts);
  });

  it("preserves the Git side of excluded workflow paths", () => {
    const result = mergeTrees(
      tree({ ".github/workflows/test.yml": blob("base") }),
      tree({ ".github/workflows/test.yml": blob("git") }),
      tree({ ".github/workflows/test.yml": blob("obsidian") }),
    );

    expect(result.tree.get(".github/workflows/test.yml")).toEqual(blob("git"));
    expect(result.conflictCount).toBe(0);
    expect(result.unsupportedWorkflowPaths).toEqual([
      ".github/workflows/test.yml",
    ]);
  });

  it("applies only a newly arrived Git delta to a staged retry base", () => {
    const result = applyTreeDelta(
      tree({ "Both.md": blob("old-git"), "Unchanged.md": blob("same") }),
      tree({ "Both.md": blob("new-git"), "Added.md": blob("added") }),
      tree({ "Both.md": blob("staged"), "Unchanged.md": blob("same") }),
    );

    expect(result).toEqual(
      tree({ "Both.md": blob("new-git"), "Added.md": blob("added") }),
    );
  });

  it("restores missing historical paths while retaining current files and workflows", () => {
    const result = buildRestoreUnion(
      tree({
        "Recovered.md": blob("historical"),
        "Survives.md": blob("historical-version"),
        ".github/workflows/old.yml": blob("historical-workflow"),
      }),
      tree({
        "Git current.md": blob("git-current"),
        "Survives.md": blob("git-version"),
        ".github/workflows/current.yml": blob("current-workflow"),
      }),
      tree({
        "Local current.md": blob("local-current"),
        "Survives.md": blob("local-version"),
        ".github/workflows/current.yml": blob("local-workflow"),
      }),
    );

    expect(result.get("Recovered.md")).toEqual(blob("historical"));
    expect(result.get("Git current.md")).toEqual(blob("git-current"));
    expect(result.get("Local current.md")).toEqual(blob("local-current"));
    expect(result.get("Survives.md")).toEqual(blob("local-version"));
    expect(result.has(".github/workflows/old.yml")).toBe(false);
    expect(result.get(".github/workflows/current.yml")).toEqual(
      blob("current-workflow"),
    );
  });

  it("caps detailed conflicts without losing the aggregate count", () => {
    const base: Tree = new Map();
    const git: Tree = new Map();
    const obsidian: Tree = new Map();
    for (let index = 0; index < 120; index += 1) {
      const name = `${index}.md`;
      base.set(name, blob(`base-${index}`));
      git.set(name, blob(`git-${index}`));
      obsidian.set(name, blob(`obsidian-${index}`));
    }

    const result = mergeTrees(base, git, obsidian);

    expect(result.conflictCount).toBe(120);
    expect(result.conflicts).toHaveLength(100);
  });

  it("blocks balanced mass-deletion thresholds", () => {
    const before: Tree = new Map();
    const candidate: Tree = new Map();
    for (let index = 0; index < 100; index += 1) {
      before.set(`${index}.md`, {
        mode: "100644",
        oid: `before-${index}`,
        size: 100,
      });
      if (index >= 20) candidate.set(`${index}.md`, before.get(`${index}.md`)!);
    }

    const result = analyzeDeletion(before, candidate);

    expect(result.destructive).toBe(true);
    expect(result.reasons).toContain("at_least_twenty_paths_and_ten_percent");
  });

  it("allows a small deletion batch", () => {
    const before = tree({
      "A.md": { ...blob("a"), size: 100 },
      "B.md": { ...blob("b"), size: 100 },
      "C.md": { ...blob("c"), size: 100 },
      "D.md": { ...blob("d"), size: 100 },
      "E.md": { ...blob("e"), size: 100 },
    });
    const candidate = new Map(before);
    candidate.delete("A.md");

    expect(analyzeDeletion(before, candidate).destructive).toBe(false);
  });

  it("quarantines the incident shape of 300 files collapsing to configuration only", () => {
    const before: Tree = new Map();
    for (let index = 0; index < 297; index += 1)
      before.set(`Notes/${index}.md`, {
        mode: "100644",
        oid: `note-${index}`,
        size: 1_000,
      });
    for (const name of ["app.json", "appearance.json", "core-plugins.json"])
      before.set(`.obsidian/${name}`, {
        mode: "100644",
        oid: name,
        size: 100,
      });
    const candidate = new Map(
      [...before].filter(([pathName]) => pathName.startsWith(".obsidian/")),
    );

    const result = analyzeDeletion(before, candidate);

    expect(result).toMatchObject({
      destructive: true,
      previousFiles: 300,
      candidateFiles: 3,
      deletedFiles: 297,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "at_least_half_of_paths",
        "at_least_quarter_of_bytes",
        "at_least_twenty_paths_and_ten_percent",
      ]),
    );
  });

  it("triggers each inclusive deletion boundary", () => {
    const paths = (count: number, size = 0): Tree =>
      new Map(
        Array.from({ length: count }, (_, index) => [
          `${index}.md`,
          { ...blob(`${index}`), size },
        ]),
      );
    const half = paths(10);
    expect(
      analyzeDeletion(half, new Map([...half].slice(5))).reasons,
    ).toContain("at_least_half_of_paths");

    const bytes = paths(4, 25);
    expect(
      analyzeDeletion(bytes, new Map([...bytes].slice(1))).reasons,
    ).toContain("at_least_quarter_of_bytes");

    const twenty = paths(200);
    expect(
      analyzeDeletion(twenty, new Map([...twenty].slice(20))).reasons,
    ).toContain("at_least_twenty_paths_and_ten_percent");

    const one = paths(1);
    expect(analyzeDeletion(one, new Map()).reasons).toContain("vault_zeroed");
  });
});

describe("vault swap recovery", () => {
  it("finishes a staged swap after interruption", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "vault-swap-")),
    );
    const vault = path.join(root, "vault");
    const previous = path.join(root, "vault-previous-test");
    const stage = path.join(root, "reconcile-test", "stage");
    await mkdir(previous);
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(previous, "Note.md"), "old");
    await writeFile(path.join(stage, "Note.md"), "new");
    await writeFile(
      path.join(root, "git-reconcile-journal.json"),
      JSON.stringify({ active: vault, previous, stage }),
    );

    await recoverVaultSwap(vault);

    expect(await readFile(path.join(vault, "Note.md"), "utf8")).toBe("new");
  });

  it("rejects journal paths outside the reconciliation directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vault-swap-unsafe-"));
    const vault = path.join(root, "vault");
    const unrelated = path.join(root, "unrelated");
    await mkdir(vault);
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "keep.txt"), "keep");
    await writeFile(
      path.join(root, "git-reconcile-journal.json"),
      JSON.stringify({ active: vault, previous: unrelated, stage: unrelated }),
    );

    await expect(recoverVaultSwap(vault)).rejects.toThrow("Unsafe paths");
    expect(await readFile(path.join(unrelated, "keep.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("rolls back to the previous vault when the staged tree is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vault-swap-rollback-"));
    const vault = path.join(root, "vault");
    const previous = path.join(root, "vault-previous-test");
    const stage = path.join(root, "reconcile-test", "stage");
    await mkdir(previous);
    await writeFile(path.join(previous, "Note.md"), "old");
    await writeFile(
      path.join(root, "git-reconcile-journal.json"),
      JSON.stringify({ active: vault, previous, stage }),
    );

    await recoverVaultSwap(vault);

    expect(await readFile(path.join(vault, "Note.md"), "utf8")).toBe("old");
  });
});

describe("Git repository integration", () => {
  it("unions an existing Git tree with the Obsidian vault and preserves workflows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-reconcile-"));
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const vault = path.join(root, "vault");
    const gitDir = path.join(root, "objects.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await exec("git", ["-C", seed, "config", "user.name", "Test"]);
    await exec("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
    await mkdir(path.join(seed, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(seed, "Git only.md"), "git only");
    await writeFile(path.join(seed, "Both.md"), "git version");
    await writeFile(
      path.join(seed, ".github", "workflows", "test.yml"),
      "git workflow",
    );
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-m", "seed"]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "origin", "main"]);
    await mkdir(path.join(vault, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await mkdir(path.join(vault, ".agents", "skills"), { recursive: true });
    await writeFile(path.join(vault, "Obsidian only.md"), "obsidian only");
    await writeFile(path.join(vault, "Both.md"), "obsidian version");
    await writeFile(path.join(vault, ".gitignore"), "Ignored.md\n");
    await writeFile(path.join(vault, "Ignored.md"), "still backed up");
    await writeFile(path.join(vault, ".obsidian", "app.json"), "{}");
    await writeFile(
      path.join(vault, ".agents", "skills", "SKILL.md"),
      "instructions",
    );
    await writeFile(
      path.join(vault, ".github", "workflows", "test.yml"),
      "obsidian workflow",
    );
    const repository = new GitRepository(
      vault,
      gitDir,
      {
        token: "test",
        repository: "owner/repository",
        branch: "main",
        trigger: "manual",
      },
      { remoteUrl: remote },
    );
    await repository.initialize();
    const head = await repository.fetch();
    expect(head).toBeTruthy();
    const originalVaultInode = (await stat(vault)).ino;

    const merged = await repository.initialUnion(head);
    expect(merged.unsupportedWorkflowPaths).toEqual([
      ".github/workflows/test.yml",
    ]);
    const initialTransaction = await repository.applyTree(merged.treeOid, head);
    await repository.finalizeTransaction(initialTransaction.id);
    expect((await stat(vault)).ino).toBe(originalVaultInode);

    expect(await readFile(path.join(vault, "Git only.md"), "utf8")).toBe(
      "git only",
    );
    expect(await readFile(path.join(vault, "Obsidian only.md"), "utf8")).toBe(
      "obsidian only",
    );
    expect(await readFile(path.join(vault, "Both.md"), "utf8")).toBe(
      "obsidian version",
    );
    expect(
      await readFile(
        path.join(vault, ".github", "workflows", "test.yml"),
        "utf8",
      ),
    ).toBe("obsidian workflow");
    expect(
      (await repository.readTree(merged.treeOid)).get(
        ".github/workflows/test.yml",
      ),
    ).toEqual(
      (await repository.readTree(head)).get(".github/workflows/test.yml"),
    );
    const mergedTree = await repository.readTree(merged.treeOid);
    expect(mergedTree.has("Ignored.md")).toBe(true);
    expect(mergedTree.has(".obsidian/app.json")).toBe(true);
    expect(mergedTree.has(".agents/skills/SKILL.md")).toBe(true);
    const finalTree = (await repository.snapshotVault(head)).treeOid;
    const pushed = await repository.commitAndPush(head, finalTree, 0);
    expect(pushed.changed).toBe(true);
    expect(
      (
        await exec("git", [
          `--git-dir=${remote}`,
          "show",
          `${pushed.commit}:Both.md`,
        ])
      ).stdout,
    ).toBe("obsidian version");

    const currentHead = await repository.fetch();
    expect(currentHead).toBe(pushed.commit);
    await writeFile(path.join(vault, "Server.md"), "server");
    const pendingTree = (await repository.snapshotVault(currentHead)).treeOid;
    const concurrent = path.join(root, "concurrent");
    await exec("git", ["clone", "-b", "main", remote, concurrent]);
    await exec("git", ["-C", concurrent, "config", "user.name", "Concurrent"]);
    await exec("git", [
      "-C",
      concurrent,
      "config",
      "user.email",
      "concurrent@example.com",
    ]);
    await exec("git", ["-C", concurrent, "config", "commit.gpgsign", "false"]);
    await writeFile(path.join(concurrent, "Concurrent.md"), "concurrent");
    await exec("git", ["-C", concurrent, "add", "-A"]);
    await exec("git", ["-C", concurrent, "commit", "-m", "concurrent"]);
    await exec("git", ["-C", concurrent, "push", "origin", "main"]);
    let rejection: unknown;
    try {
      await repository.commitAndPush(currentHead, pendingTree, 0);
    } catch (error) {
      rejection = error;
    }
    expect(repository.isNonFastForward(rejection)).toBe(true);

    const concurrentHead = await repository.fetch();
    expect(concurrentHead).toBeTruthy();
    const retried = await repository.retryMergedTree(
      currentHead,
      concurrentHead!,
      pendingTree,
    );
    const retryTransaction = await repository.applyTree(
      retried.treeOid,
      concurrentHead,
    );
    await repository.finalizeTransaction(retryTransaction.id);
    const retriedTree = (await repository.snapshotVault(concurrentHead))
      .treeOid;
    const retriedPush = await repository.commitAndPush(
      concurrentHead,
      retriedTree,
      retried.conflictCount,
    );
    expect(await readFile(path.join(vault, "Concurrent.md"), "utf8")).toBe(
      "concurrent",
    );
    expect(await readFile(path.join(vault, "Server.md"), "utf8")).toBe(
      "server",
    );
    const reconnected = await repository.commitAndPush(
      retriedPush.commit,
      retriedTree,
      0,
      currentHead,
    );
    expect(reconnected.changed).toBe(true);
    expect(
      (
        await exec("git", [
          `--git-dir=${remote}`,
          "show",
          "-s",
          "--format=%P",
          reconnected.commit,
        ])
      ).stdout
        .trim()
        .split(" "),
    ).toHaveLength(2);

    await writeFile(path.join(vault, "Both.md"), "checkpoint candidate");
    const checkpointCandidate = (
      await repository.snapshotVault(undefined, false, true)
    ).treeOid;
    await writeFile(path.join(vault, "Both.md"), "safe before transaction");
    await repository.applyTree(checkpointCandidate, undefined);
    expect(await readFile(path.join(vault, "Both.md"), "utf8")).toBe(
      "checkpoint candidate",
    );
    await recoverVaultSwap(vault);
    expect(await readFile(path.join(vault, "Both.md"), "utf8")).toBe(
      "safe before transaction",
    );
    expect((await stat(vault)).ino).toBe(originalVaultInode);

    const committedTransaction = await repository.applyTree(
      checkpointCandidate,
      undefined,
    );
    await repository.markTransactionCommitted(committedTransaction.id);
    await recoverVaultSwap(vault);
    expect(await readFile(path.join(vault, "Both.md"), "utf8")).toBe(
      "checkpoint candidate",
    );
    expect((await stat(vault)).ino).toBe(originalVaultInode);

    await mkdir(path.join(vault, "Shape"));
    await writeFile(path.join(vault, "Shape", "Child.md"), "child");
    const directoryShape = (
      await repository.snapshotVault(undefined, false, true)
    ).treeOid;
    await rm(path.join(vault, "Shape"), { recursive: true });
    await writeFile(path.join(vault, "Shape"), "file");
    const fileShape = (await repository.snapshotVault(undefined, false, true))
      .treeOid;
    let shapeTransaction = await repository.applyTree(directoryShape);
    await repository.finalizeTransaction(shapeTransaction.id);
    expect(await readFile(path.join(vault, "Shape", "Child.md"), "utf8")).toBe(
      "child",
    );
    shapeTransaction = await repository.applyTree(fileShape);
    await repository.finalizeTransaction(shapeTransaction.id);
    expect(await readFile(path.join(vault, "Shape"), "utf8")).toBe("file");
    expect((await stat(vault)).ino).toBe(originalVaultInode);

    await symlink("Both.md", path.join(vault, "Linked.md"));
    await expect(repository.snapshotVault(reconnected.commit)).rejects.toThrow(
      "Unsupported Git mode 120000",
    );
  });

  it("initializes main in an empty repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-empty-"));
    const remote = path.join(root, "remote.git");
    const vault = path.join(root, "vault");
    const gitDir = path.join(root, "objects.git");
    await exec("git", ["init", "--bare", remote]);
    await mkdir(vault);
    await writeFile(path.join(vault, "First.md"), "first");
    const repository = new GitRepository(
      vault,
      gitDir,
      {
        token: "test",
        repository: "owner/empty",
        branch: "main",
        trigger: "manual",
      },
      { remoteUrl: remote },
    );
    await repository.initialize();
    expect(await repository.fetch()).toBeUndefined();

    const initial = await repository.initialUnion();
    const pushed = await repository.commitAndPush(
      undefined,
      initial.treeOid,
      0,
    );

    expect(
      (
        await exec("git", [
          `--git-dir=${remote}`,
          "show",
          `${pushed.commit}:First.md`,
        ])
      ).stdout,
    ).toBe("first");
  });
});
