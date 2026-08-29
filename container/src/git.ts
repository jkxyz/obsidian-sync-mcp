import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { GitConflict, GitReconcileInput } from "./protocol.js";
import { safeEnvironment } from "./sync.js";

const WORKFLOW_PREFIX = ".github/workflows/";
const MAX_CONFLICTS = 100;
const GIT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT_BYTES = 4_000_000;
const MAX_TREE_LIST_BYTES = 64 * 1024 * 1024;

export type TreeEntry = {
  mode: "100644" | "100755";
  oid: string;
  size?: number;
};
export type Tree = Map<string, TreeEntry>;

export type DeletionAnalysis = {
  previousFiles: number;
  candidateFiles: number;
  deletedFiles: number;
  previousBytes: number;
  deletedBytes: number;
  deletedPaths: string[];
  reasons: string[];
  destructive: boolean;
};

export type VaultTransaction = {
  id: string;
  beforeTree: string;
  appliedTree: string;
  deletion: DeletionAnalysis;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export class GitCommandError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `Git command failed (${code})${stderr ? `: ${stderr.slice(-1000)}` : ""}`,
    );
    this.name = "GitCommandError";
  }
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string | Buffer,
  timeoutMs = GIT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: safeEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const terminate = () => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        if (!outputExceeded) {
          outputExceeded = true;
          terminate();
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 128_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (outputExceeded) {
        reject(
          new Error(
            `${command} produced more than ${maxStdoutBytes} bytes of output`,
          ),
        );
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function equalEntry(left?: TreeEntry, right?: TreeEntry): boolean {
  return left?.mode === right?.mode && left?.oid === right?.oid;
}

export function analyzeDeletion(
  before: Tree,
  candidate: Tree,
): DeletionAnalysis {
  const relevantBefore = [...before.entries()].filter(
    ([pathName]) => !isWorkflowPath(pathName),
  );
  const relevantCandidate = [...candidate.keys()].filter(
    (pathName) => !isWorkflowPath(pathName),
  );
  const deletedPaths = relevantBefore
    .filter(([pathName]) => !candidate.has(pathName))
    .map(([pathName]) => pathName)
    .sort();
  const previousBytes = relevantBefore.reduce(
    (total, [, entry]) => total + (entry.size ?? 0),
    0,
  );
  const deletedBytes = deletedPaths.reduce(
    (total, pathName) => total + (before.get(pathName)?.size ?? 0),
    0,
  );
  const previousFiles = relevantBefore.length;
  const candidateFiles = relevantCandidate.length;
  const deletedFiles = deletedPaths.length;
  const pathRatio = previousFiles > 0 ? deletedFiles / previousFiles : 0;
  const byteRatio = previousBytes > 0 ? deletedBytes / previousBytes : 0;
  const reasons: string[] = [];
  if (previousFiles > 0 && candidateFiles === 0) reasons.push("vault_zeroed");
  if (deletedFiles > 0 && pathRatio >= 0.5)
    reasons.push("at_least_half_of_paths");
  if (deletedBytes > 0 && byteRatio >= 0.25)
    reasons.push("at_least_quarter_of_bytes");
  if (deletedFiles >= 20 && pathRatio >= 0.1)
    reasons.push("at_least_twenty_paths_and_ten_percent");
  return {
    previousFiles,
    candidateFiles,
    deletedFiles,
    previousBytes,
    deletedBytes,
    deletedPaths,
    reasons,
    destructive: reasons.length > 0,
  };
}

function conflictEntry(
  pathName: string,
  base: TreeEntry | undefined,
  git: TreeEntry | undefined,
  obsidian: TreeEntry | undefined,
): GitConflict {
  return {
    path: pathName,
    base_oid: base?.oid ?? null,
    git_oid: git?.oid ?? null,
    obsidian_oid: obsidian?.oid ?? null,
    resolution: "obsidian",
  };
}

export function mergeTrees(
  base: Tree,
  git: Tree,
  obsidian: Tree,
): {
  tree: Tree;
  conflicts: GitConflict[];
  conflictCount: number;
  unsupportedWorkflowPaths: string[];
  unsupportedWorkflowCount: number;
} {
  const result: Tree = new Map();
  const conflicts: GitConflict[] = [];
  const unsupportedWorkflowPaths: string[] = [];
  let conflictCount = 0;
  let unsupportedWorkflowCount = 0;
  const paths = new Set([...base.keys(), ...git.keys(), ...obsidian.keys()]);
  for (const pathName of [...paths].sort()) {
    const baseEntry = base.get(pathName);
    const gitEntry = git.get(pathName);
    const obsidianEntry = obsidian.get(pathName);
    let selected: TreeEntry | undefined;
    if (isWorkflowPath(pathName)) {
      selected = gitEntry;
      if (!equalEntry(gitEntry, obsidianEntry)) {
        unsupportedWorkflowCount += 1;
        if (unsupportedWorkflowPaths.length < MAX_CONFLICTS)
          unsupportedWorkflowPaths.push(pathName);
      }
    } else if (equalEntry(gitEntry, obsidianEntry)) selected = gitEntry;
    else if (equalEntry(gitEntry, baseEntry)) selected = obsidianEntry;
    else if (equalEntry(obsidianEntry, baseEntry)) selected = gitEntry;
    else {
      selected = obsidianEntry;
      conflictCount += 1;
      if (conflicts.length < MAX_CONFLICTS)
        conflicts.push(
          conflictEntry(pathName, baseEntry, gitEntry, obsidianEntry),
        );
    }
    if (selected) result.set(pathName, selected);
  }
  return {
    tree: result,
    conflicts,
    conflictCount,
    unsupportedWorkflowPaths,
    unsupportedWorkflowCount,
  };
}

export function applyTreeDelta(base: Tree, changed: Tree, target: Tree): Tree {
  const result = new Map(target);
  const paths = new Set([...base.keys(), ...changed.keys()]);
  for (const pathName of paths) {
    const before = base.get(pathName);
    const after = changed.get(pathName);
    if (equalEntry(before, after)) continue;
    if (after) result.set(pathName, after);
    else result.delete(pathName);
  }
  return result;
}

export function buildRestoreUnion(
  restoreTree: Tree,
  currentGit: Tree,
  currentVault: Tree,
): Tree {
  const result = new Map(restoreTree);
  for (const [pathName, entry] of currentGit) result.set(pathName, entry);
  for (const [pathName, entry] of currentVault)
    if (!isWorkflowPath(pathName)) result.set(pathName, entry);
  for (const pathName of [...result.keys()])
    if (isWorkflowPath(pathName) && !currentGit.has(pathName))
      result.delete(pathName);
  return result;
}

function validateRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("Invalid GitHub repository name");
}

function validateBranch(branch: string): void {
  if (
    !branch ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch === "@" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s~^:?*[\\\]]/u.test(branch) ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new Error("Invalid Git branch name");
}

function gitAuthEnvironment(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durablySyncTree(target: string): Promise<void> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink())
    throw new Error("Symbolic links are not supported in the vault");
  if (targetStat.isFile()) {
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!targetStat.isDirectory())
    throw new Error(`Unsupported vault filesystem entry: ${target}`);
  for (const entry of await readdir(target))
    await durablySyncTree(path.join(target, entry));
  await syncDirectory(target);
}

async function writeJournal(
  journalPath: string,
  journal: unknown,
): Promise<void> {
  const temporary = `${journalPath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(journal), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, journalPath);
    await syncDirectory(path.dirname(journalPath));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function isWorkflowPath(pathName: string): boolean {
  return (
    pathName === ".github/workflows" || pathName.startsWith(WORKFLOW_PREFIX)
  );
}

export async function recoverVaultSwap(vaultRoot: string): Promise<void> {
  const dataRoot = path.dirname(vaultRoot);
  const journalPath = path.join(dataRoot, "git-reconcile-journal.json");
  if (!(await pathExists(journalPath))) {
    for (const name of await readdir(dataRoot))
      if (name.startsWith("reconcile-"))
        await rm(path.join(dataRoot, name), { recursive: true, force: true });
    return;
  }
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Partial<
    LegacySwapJournal & VaultTransactionJournal
  >;
  if (journal.version === 2) {
    const transaction = validateTransactionJournal(vaultRoot, journal);
    if (transaction.state === "committed")
      await finalizeJournal(journalPath, transaction);
    else await rollbackJournal(vaultRoot, journalPath, transaction);
    return;
  }
  if (
    typeof journal.active !== "string" ||
    typeof journal.previous !== "string" ||
    typeof journal.stage !== "string"
  )
    throw new Error("Invalid Git reconciliation journal");
  const active = path.resolve(journal.active);
  const previous = path.resolve(journal.previous);
  const stage = path.resolve(journal.stage);
  const resolvedDataRoot = path.resolve(dataRoot);
  const reconcileRoot = path.dirname(stage);
  if (
    active !== path.resolve(vaultRoot) ||
    path.dirname(previous) !== resolvedDataRoot ||
    !path.basename(previous).startsWith("vault-previous-") ||
    path.dirname(reconcileRoot) !== resolvedDataRoot ||
    !path.basename(reconcileRoot).startsWith("reconcile-") ||
    path.basename(stage) !== "stage"
  )
    throw new Error("Unsafe paths in Git reconciliation journal");
  const vaultExists = await pathExists(vaultRoot);
  const previousExists = await pathExists(previous);
  const stageExists = await pathExists(stage);
  if (!vaultExists && stageExists) {
    await rename(stage, vaultRoot);
    await syncDirectory(dataRoot);
  } else if (!vaultExists && previousExists) {
    await rename(previous, vaultRoot);
    await syncDirectory(dataRoot);
  } else if (!vaultExists)
    throw new Error("Git reconciliation journal has no recoverable vault");
  if (await pathExists(previous))
    await rm(previous, { recursive: true, force: true });
  if (await pathExists(stage))
    await rm(stage, { recursive: true, force: true });
  await rm(journalPath, { force: true });
  await syncDirectory(dataRoot);
}

type LegacySwapJournal = {
  active: string;
  previous: string;
  stage: string;
};

type VaultTransactionEntry = {
  path: string;
  before: boolean;
  after: boolean;
};

type VaultTransactionJournal = {
  version: 2;
  id: string;
  active: string;
  root: string;
  stage: string;
  backup: string;
  state: "applying" | "applied" | "committed";
  beforeTree: string;
  appliedTree: string;
  entries: VaultTransactionEntry[];
};

function validateTransactionJournal(
  vaultRoot: string,
  journal: Partial<VaultTransactionJournal>,
): VaultTransactionJournal {
  if (
    journal.version !== 2 ||
    typeof journal.id !== "string" ||
    typeof journal.active !== "string" ||
    typeof journal.root !== "string" ||
    typeof journal.stage !== "string" ||
    typeof journal.backup !== "string" ||
    (journal.state !== "applying" &&
      journal.state !== "applied" &&
      journal.state !== "committed") ||
    typeof journal.beforeTree !== "string" ||
    typeof journal.appliedTree !== "string" ||
    !Array.isArray(journal.entries)
  )
    throw new Error("Invalid Git reconciliation transaction journal");
  const dataRoot = path.resolve(path.dirname(vaultRoot));
  const root = path.resolve(journal.root);
  if (
    path.resolve(journal.active) !== path.resolve(vaultRoot) ||
    path.dirname(root) !== dataRoot ||
    !path.basename(root).startsWith("reconcile-") ||
    path.resolve(journal.stage) !== path.join(root, "stage") ||
    path.resolve(journal.backup) !== path.join(root, "backup")
  )
    throw new Error("Unsafe paths in Git reconciliation transaction journal");
  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.before !== "boolean" ||
      typeof entry.after !== "boolean" ||
      entry.path.includes("\\") ||
      path.posix.isAbsolute(entry.path) ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe path in Git reconciliation transaction journal");
  }
  return journal as VaultTransactionJournal;
}

async function finalizeJournal(
  journalPath: string,
  journal: VaultTransactionJournal,
): Promise<void> {
  await rm(journalPath, { force: true });
  await syncDirectory(path.dirname(journal.active));
  await rm(journal.root, { recursive: true, force: true });
  await syncDirectory(path.dirname(journal.active));
}

async function pruneEmptyParents(target: string, stop: string): Promise<void> {
  let current = path.dirname(target);
  const boundary = path.resolve(stop);
  while (path.resolve(current) !== boundary) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

async function rollbackJournal(
  vaultRoot: string,
  journalPath: string,
  value: Partial<VaultTransactionJournal>,
): Promise<void> {
  const journal = validateTransactionJournal(vaultRoot, value);
  await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
  const deepestFirst = [...journal.entries].sort(
    (left, right) =>
      right.path.split("/").length - left.path.split("/").length ||
      right.path.localeCompare(left.path),
  );
  for (const entry of deepestFirst) {
    const target = path.join(vaultRoot, ...entry.path.split("/"));
    const backup = path.join(journal.backup, ...entry.path.split("/"));
    if ((await pathExists(backup)) || !entry.before) {
      await rm(target, { recursive: true, force: true });
      await pruneEmptyParents(target, vaultRoot);
    }
  }
  const shallowestFirst = [...journal.entries].sort(
    (left, right) =>
      left.path.split("/").length - right.path.split("/").length ||
      left.path.localeCompare(right.path),
  );
  for (const entry of shallowestFirst) {
    const target = path.join(vaultRoot, ...entry.path.split("/"));
    const backup = path.join(journal.backup, ...entry.path.split("/"));
    if (!(await pathExists(backup))) continue;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(backup, target);
  }
  await rm(journalPath, { force: true });
  await rm(journal.root, { recursive: true, force: true });
  await syncDirectory(path.dirname(vaultRoot));
}

export class GitRepository {
  private readonly remoteUrl: string;
  private readonly authEnvironment: NodeJS.ProcessEnv;
  private lfsAvailable = false;
  private lfsError: string | undefined;

  constructor(
    private readonly vaultRoot: string,
    private readonly gitDir: string,
    private readonly input: GitReconcileInput,
    options: { remoteUrl?: string } = {},
  ) {
    validateRepository(input.repository);
    validateBranch(input.branch);
    this.remoteUrl =
      options.remoteUrl ?? `https://github.com/${input.repository}.git`;
    this.authEnvironment = gitAuthEnvironment(input.token);
  }

  private gitArgs(args: string[]): string[] {
    return [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.vaultRoot}`,
      "-c",
      "core.quotePath=false",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ];
  }

  private async git(
    args: string[],
    options: {
      input?: string | Buffer;
      allow?: number[];
      index?: string;
      maxStdoutBytes?: number;
    } = {},
  ): Promise<CommandResult> {
    const result = await runProcess(
      "git",
      this.gitArgs(args),
      {
        ...this.authEnvironment,
        ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
        GIT_AUTHOR_NAME: "Obsidian Sync MCP",
        GIT_AUTHOR_EMAIL: "obsidian-sync-mcp@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Obsidian Sync MCP",
        GIT_COMMITTER_EMAIL: "obsidian-sync-mcp@users.noreply.github.com",
      },
      options.input,
      GIT_TIMEOUT_MS,
      options.maxStdoutBytes,
    );
    if (result.code !== 0 && !(options.allow ?? []).includes(result.code))
      throw new GitCommandError(result.code, result.stderr);
    return result;
  }

  async initialize(): Promise<void> {
    await mkdir(this.vaultRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.gitDir), { recursive: true, mode: 0o700 });
    if (!(await pathExists(path.join(this.gitDir, "HEAD")))) {
      const initialized = await runProcess(
        "git",
        ["init", "--bare", this.gitDir],
        {},
      );
      if (initialized.code !== 0)
        throw new GitCommandError(initialized.code, initialized.stderr);
    }
    const remotes = await this.git(["remote"], { allow: [0] });
    if (remotes.stdout.split(/\r?\n/u).includes("origin"))
      await this.git(["remote", "set-url", "origin", this.remoteUrl]);
    else await this.git(["remote", "add", "origin", this.remoteUrl]);
    const lfs = await runProcess(
      "git",
      ["lfs", "version"],
      {},
      undefined,
      30_000,
    );
    this.lfsAvailable = lfs.code === 0;
    this.lfsError = this.lfsAvailable
      ? undefined
      : "Git LFS is not installed in the container";
    if (this.lfsAvailable) {
      const installed = await this.git(["lfs", "install", "--local"], {
        allow: [1, 2, 128],
      });
      if (installed.code !== 0) {
        this.lfsError = installed.stderr || "Git LFS initialization failed";
        throw new Error(this.lfsError);
      }
    }
  }

  lfsStatus(): { available: boolean; healthy: boolean; error?: string } {
    return {
      available: this.lfsAvailable,
      healthy: this.lfsAvailable && !this.lfsError,
      ...(this.lfsError ? { error: this.lfsError } : {}),
    };
  }

  async fetch(): Promise<string | undefined> {
    const reference = `refs/heads/${this.input.branch}`;
    const listed = await this.git([
      "ls-remote",
      "--heads",
      "origin",
      reference,
    ]);
    const oid = listed.stdout.trim().split(/\s+/u)[0];
    if (!oid) return undefined;
    await this.git([
      "fetch",
      "--no-tags",
      "origin",
      `+${reference}:refs/remotes/origin/${this.input.branch}`,
    ]);
    return (
      await this.git(["rev-parse", `refs/remotes/origin/${this.input.branch}`])
    ).stdout.trim();
  }

  async ensureCommit(commit: string): Promise<boolean> {
    const present = await this.git(["cat-file", "-e", `${commit}^{commit}`], {
      allow: [1, 128],
    });
    if (present.code === 0) return true;
    const fetched = await this.git(["fetch", "--no-tags", "origin", commit], {
      allow: [1, 128],
    });
    return fetched.code === 0;
  }

  async isAncestor(base: string, head: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", base, head], {
      allow: [1],
    });
    return result.code === 0;
  }

  async readTree(reference?: string): Promise<Tree> {
    if (!reference) return new Map();
    const output = await this.git(["ls-tree", "-r", "-l", "-z", reference], {
      maxStdoutBytes: MAX_TREE_LIST_BYTES,
    });
    const result: Tree = new Map();
    for (const record of output.stdout.split("\0")) {
      if (!record) continue;
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/u.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !match[4])
        throw new Error("Git tree contains an unsupported entry");
      const mode = match[1];
      if (mode !== "100644" && mode !== "100755")
        throw new Error(`Unsupported Git mode ${mode} at ${match[4]}`);
      const normalized = match[4].normalize("NFC");
      if (normalized.includes("\uFFFD"))
        throw new Error("Git tree contains a non-UTF-8 path");
      if (result.has(normalized))
        throw new Error(
          `Unicode-normalizing Git path collision: ${normalized}`,
        );
      result.set(normalized, {
        mode,
        oid: match[2],
        size: Number(match[3]),
      });
    }
    this.validateTree(result);
    return result;
  }

  validateTree(tree: Tree): void {
    const folded = new Map<string, string>();
    for (const pathName of tree.keys()) {
      if (
        !pathName ||
        pathName.includes("\0") ||
        pathName.includes("\\") ||
        path.posix.isAbsolute(pathName) ||
        pathName.split("/").some((part) => part === "." || part === "..") ||
        pathName.split("/").some((part) => part.toLowerCase() === ".git")
      )
        throw new Error(`Unsafe Git path: ${pathName}`);
      const key = pathName.toLocaleLowerCase("en-US");
      const previous = folded.get(key);
      if (previous && previous !== pathName)
        throw new Error(
          `Case-colliding Git paths: ${previous} and ${pathName}`,
        );
      folded.set(key, pathName);
    }
  }

  private indexPath(label: string): string {
    return path.join(this.gitDir, `index-${label}-${randomUUID()}`);
  }

  private async writeIndex(tree: Tree, index: string): Promise<string> {
    await rm(index, { force: true });
    await this.git(["read-tree", "--empty"], { index });
    if (tree.size > 0) {
      const records = [...tree.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pathName, entry]) => `${entry.mode} ${entry.oid}\t${pathName}\0`)
        .join("");
      await this.git(["update-index", "-z", "--index-info"], {
        index,
        input: Buffer.from(records, "utf8"),
      });
    }
    return (await this.git(["write-tree"], { index })).stdout.trim();
  }

  async snapshotVault(
    seed?: string,
    preserveMissing = false,
    includeWorkflows = false,
  ): Promise<{
    treeOid: string;
    tree: Tree;
  }> {
    const index = this.indexPath("snapshot");
    try {
      await rm(index, { force: true });
      if (seed) await this.git(["read-tree", seed], { index });
      else await this.git(["read-tree", "--empty"], { index });
      const addArgs = [
        "add",
        "-f",
        preserveMissing ? "--ignore-removal" : "-A",
        "--",
        ".",
      ];
      if (!includeWorkflows)
        addArgs.push(
          ":(exclude).github/workflows",
          ":(exclude).github/workflows/**",
        );
      await this.git(addArgs, { index });
      const treeOid = (await this.git(["write-tree"], { index })).stdout.trim();
      return { treeOid, tree: await this.readTree(treeOid) };
    } finally {
      await rm(index, { force: true });
    }
  }

  async mergedTree(
    baseCommit: string,
    gitCommit: string,
  ): Promise<{
    treeOid: string;
    conflicts: GitConflict[];
    conflictCount: number;
    unsupportedWorkflowPaths: string[];
    unsupportedWorkflowCount: number;
  }> {
    const [base, git, obsidianSnapshot] = await Promise.all([
      this.readTree(baseCommit),
      this.readTree(gitCommit),
      this.snapshotVault(baseCommit, false, true),
    ]);
    const merged = mergeTrees(base, git, obsidianSnapshot.tree);
    const index = this.indexPath("merged");
    try {
      return {
        treeOid: await this.writeIndex(merged.tree, index),
        conflicts: merged.conflicts,
        conflictCount: merged.conflictCount,
        unsupportedWorkflowPaths: merged.unsupportedWorkflowPaths,
        unsupportedWorkflowCount: merged.unsupportedWorkflowCount,
      };
    } finally {
      await rm(index, { force: true });
    }
  }

  async initialUnion(gitCommit?: string): Promise<{
    treeOid: string;
    conflicts: GitConflict[];
    conflictCount: number;
    unsupportedWorkflowPaths: string[];
    unsupportedWorkflowCount: number;
  }> {
    const [gitTree, snapshot, localSnapshot] = await Promise.all([
      this.readTree(gitCommit),
      this.snapshotVault(gitCommit, true),
      this.snapshotVault(undefined, false, true),
    ]);
    const comparison = mergeTrees(new Map(), gitTree, localSnapshot.tree);
    return {
      treeOid: snapshot.treeOid,
      conflicts: [],
      conflictCount: 0,
      unsupportedWorkflowPaths: comparison.unsupportedWorkflowPaths,
      unsupportedWorkflowCount: comparison.unsupportedWorkflowCount,
    };
  }

  async restoreUnion(
    restoreCommit: string,
    currentGitCommit: string,
  ): Promise<{
    treeOid: string;
    conflicts: GitConflict[];
    conflictCount: number;
    unsupportedWorkflowPaths: string[];
    unsupportedWorkflowCount: number;
  }> {
    const [restoreTree, currentGit, local] = await Promise.all([
      this.readTree(restoreCommit),
      this.readTree(currentGitCommit),
      this.snapshotVault(undefined, false, true),
    ]);
    const result = buildRestoreUnion(restoreTree, currentGit, local.tree);
    const index = this.indexPath("restore-union");
    try {
      return {
        treeOid: await this.writeIndex(result, index),
        conflicts: [],
        conflictCount: 0,
        unsupportedWorkflowPaths: [],
        unsupportedWorkflowCount: 0,
      };
    } finally {
      await rm(index, { force: true });
    }
  }

  async retryMergedTree(
    previousGitCommit: string | undefined,
    currentGitCommit: string,
    localBaseTree: string,
  ): Promise<{
    treeOid: string;
    conflicts: GitConflict[];
    conflictCount: number;
    unsupportedWorkflowPaths: string[];
    unsupportedWorkflowCount: number;
  }> {
    const [previousGit, currentGit, localBase, obsidianSnapshot] =
      await Promise.all([
        this.readTree(previousGitCommit),
        this.readTree(currentGitCommit),
        this.readTree(localBaseTree),
        this.snapshotVault(localBaseTree, false, true),
      ]);
    const gitCandidate = applyTreeDelta(previousGit, currentGit, localBase);
    const merged = mergeTrees(localBase, gitCandidate, obsidianSnapshot.tree);
    const index = this.indexPath("retry-merged");
    try {
      return {
        treeOid: await this.writeIndex(merged.tree, index),
        conflicts: merged.conflicts,
        conflictCount: merged.conflictCount,
        unsupportedWorkflowPaths: merged.unsupportedWorkflowPaths,
        unsupportedWorkflowCount: merged.unsupportedWorkflowCount,
      };
    } finally {
      await rm(index, { force: true });
    }
  }

  async applyTree(
    treeOid: string,
    remoteHead?: string,
    preserveWorkflows = true,
  ): Promise<VaultTransaction> {
    const requestedTree = await this.readTree(treeOid);
    this.validateTree(requestedTree);
    if (this.lfsAvailable && remoteHead) {
      const fetched = await this.git(["lfs", "fetch", "origin", remoteHead], {
        allow: [1, 2, 128],
      });
      if (fetched.code !== 0) {
        this.lfsError = fetched.stderr || "Git LFS fetch failed";
        throw new Error(this.lfsError);
      }
      if (
        this.input.resolution === "reconnect_base" &&
        this.input.base_commit !== remoteHead
      ) {
        const baseFetched = await this.git(
          ["lfs", "fetch", "origin", this.input.base_commit!],
          { allow: [1, 2, 128] },
        );
        if (baseFetched.code !== 0) {
          this.lfsError =
            baseFetched.stderr || "Git LFS fetch for the previous base failed";
          throw new Error(this.lfsError);
        }
      }
      if (
        this.input.restore_commit &&
        this.input.restore_commit !== remoteHead
      ) {
        const restoreFetched = await this.git(
          ["lfs", "fetch", "origin", this.input.restore_commit],
          { allow: [1, 2, 128] },
        );
        if (restoreFetched.code !== 0) {
          this.lfsError =
            restoreFetched.stderr || "Git LFS fetch for recovery failed";
          throw new Error(this.lfsError);
        }
      }
    }
    const dataRoot = path.dirname(this.vaultRoot);
    const transactionId = randomUUID();
    const reconcileRoot = path.join(dataRoot, `reconcile-${transactionId}`);
    const stage = path.join(reconcileRoot, "stage");
    const backup = path.join(reconcileRoot, "backup");
    const journalPath = path.join(dataRoot, "git-reconcile-journal.json");
    const index = this.indexPath("checkout");
    if (await pathExists(journalPath))
      throw new Error("Another Git reconciliation transaction is unfinished");
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await mkdir(backup, { recursive: true, mode: 0o700 });
    try {
      const beforeSnapshot = await this.snapshotVault(undefined, false, true);
      const appliedTree = new Map(requestedTree);
      if (preserveWorkflows) {
        for (const pathName of [...appliedTree.keys()])
          if (isWorkflowPath(pathName)) appliedTree.delete(pathName);
        for (const [pathName, entry] of beforeSnapshot.tree)
          if (isWorkflowPath(pathName)) appliedTree.set(pathName, entry);
      }
      const appliedTreeOid = await this.writeIndex(appliedTree, index);
      await this.git(["read-tree", appliedTreeOid], { index });
      await this.git(
        ["checkout-index", "--all", "--force", `--prefix=${stage}/`],
        { index },
      );
      await this.verifyNoLfsPointers(stage, appliedTree);
      await durablySyncTree(stage);
      const paths = new Set([
        ...beforeSnapshot.tree.keys(),
        ...appliedTree.keys(),
      ]);
      const entries: VaultTransactionEntry[] = [...paths]
        .filter((pathName) => !preserveWorkflows || !isWorkflowPath(pathName))
        .filter(
          (pathName) =>
            !equalEntry(
              beforeSnapshot.tree.get(pathName),
              appliedTree.get(pathName),
            ),
        )
        .sort()
        .map((pathName) => ({
          path: pathName,
          before: beforeSnapshot.tree.has(pathName),
          after: appliedTree.has(pathName),
        }));
      const journal: VaultTransactionJournal = {
        version: 2,
        id: transactionId,
        active: this.vaultRoot,
        root: reconcileRoot,
        stage,
        backup,
        state: "applying",
        beforeTree: beforeSnapshot.treeOid,
        appliedTree: appliedTreeOid,
        entries,
      };
      await writeJournal(journalPath, journal);
      const deepestFirst = [...entries].sort(
        (left, right) =>
          right.path.split("/").length - left.path.split("/").length ||
          right.path.localeCompare(left.path),
      );
      for (const entry of deepestFirst) {
        if (!entry.before) continue;
        const target = path.join(this.vaultRoot, ...entry.path.split("/"));
        const saved = path.join(backup, ...entry.path.split("/"));
        await mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
        await rename(target, saved);
        await pruneEmptyParents(target, this.vaultRoot);
      }
      const shallowestFirst = [...entries].sort(
        (left, right) =>
          left.path.split("/").length - right.path.split("/").length ||
          left.path.localeCompare(right.path),
      );
      for (const entry of shallowestFirst) {
        if (!entry.after) continue;
        const target = path.join(this.vaultRoot, ...entry.path.split("/"));
        const staged = path.join(stage, ...entry.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(staged, target);
      }
      await durablySyncTree(this.vaultRoot);
      journal.state = "applied";
      await writeJournal(journalPath, journal);
      await syncDirectory(dataRoot);
      return {
        id: transactionId,
        beforeTree: beforeSnapshot.treeOid,
        appliedTree: appliedTreeOid,
        deletion: analyzeDeletion(beforeSnapshot.tree, appliedTree),
      };
    } catch (error) {
      if (await pathExists(journalPath)) await recoverVaultSwap(this.vaultRoot);
      else await rm(reconcileRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(index, { force: true });
    }
  }

  async finalizeTransaction(transactionId: string): Promise<void> {
    const journalPath = path.join(
      path.dirname(this.vaultRoot),
      "git-reconcile-journal.json",
    );
    if (!(await pathExists(journalPath))) return;
    const journal = validateTransactionJournal(
      this.vaultRoot,
      JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Partial<VaultTransactionJournal>,
    );
    if (journal.id !== transactionId)
      throw new Error("Git reconciliation transaction changed unexpectedly");
    if (journal.state !== "applied" && journal.state !== "committed")
      throw new Error("Git reconciliation transaction was not fully applied");
    await finalizeJournal(journalPath, journal);
  }

  async markTransactionCommitted(transactionId: string): Promise<void> {
    const journalPath = path.join(
      path.dirname(this.vaultRoot),
      "git-reconcile-journal.json",
    );
    const journal = validateTransactionJournal(
      this.vaultRoot,
      JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Partial<VaultTransactionJournal>,
    );
    if (journal.id !== transactionId || journal.state !== "applied")
      throw new Error("Git reconciliation transaction changed unexpectedly");
    journal.state = "committed";
    await writeJournal(journalPath, journal);
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    const journalPath = path.join(
      path.dirname(this.vaultRoot),
      "git-reconcile-journal.json",
    );
    if (!(await pathExists(journalPath))) return;
    const journal = validateTransactionJournal(
      this.vaultRoot,
      JSON.parse(
        await readFile(journalPath, "utf8"),
      ) as Partial<VaultTransactionJournal>,
    );
    if (journal.id !== transactionId)
      throw new Error("Git reconciliation transaction changed unexpectedly");
    await rollbackJournal(this.vaultRoot, journalPath, journal);
  }

  private async verifyNoLfsPointers(stage: string, tree: Tree): Promise<void> {
    for (const pathName of tree.keys()) {
      if (isWorkflowPath(pathName)) continue;
      const absolute = path.join(stage, ...pathName.split("/"));
      const fileStat = await stat(absolute);
      if (!fileStat.isFile())
        throw new Error(`Expected regular file: ${pathName}`);
      const handle = await open(absolute, "r");
      const prefix = Buffer.alloc(128);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(prefix, 0, prefix.length, 0));
      } finally {
        await handle.close();
      }
      if (
        prefix
          .subarray(0, bytesRead)
          .toString("utf8")
          .startsWith("version https://git-lfs.github.com/spec/v1\n")
      ) {
        this.lfsError = `Unresolved Git LFS pointer at ${pathName}`;
        throw new Error(this.lfsError);
      }
    }
  }

  async commitAndPush(
    parent: string | undefined,
    treeOid: string,
    conflicts: number,
    reconnectBase?: string,
  ): Promise<{ commit: string; changed: boolean }> {
    const parentTree = parent
      ? (await this.git(["rev-parse", `${parent}^{tree}`])).stdout.trim()
      : undefined;
    if (
      parent &&
      parentTree === treeOid &&
      (!reconnectBase || reconnectBase === parent)
    )
      return { commit: parent, changed: false };
    const message = [
      `vault: reconcile ${new Date().toISOString()}`,
      "",
      `Obsidian-Sync-MCP-Base: ${this.input.base_commit ?? "none"}`,
      `Obsidian-Sync-MCP-Tree: ${treeOid}`,
      `Obsidian-Sync-MCP-Trigger: ${this.input.trigger}`,
      `Obsidian-Sync-MCP-Conflicts: ${conflicts}`,
      ...(this.input.request_id
        ? [`Obsidian-Sync-MCP-Request-ID: ${this.input.request_id}`]
        : []),
      ...(this.input.safety_event
        ? [
            `Obsidian-Sync-MCP-Safety-Event: ${this.input.safety_event.event_id}`,
            `Obsidian-Sync-MCP-Safety-Action: ${this.input.action ?? "apply"}`,
          ]
        : []),
      ...(this.input.restore_commit
        ? [`Obsidian-Sync-MCP-Restore-Source: ${this.input.restore_commit}`]
        : []),
      "",
    ].join("\n");
    const args = ["commit-tree", treeOid];
    if (parent) args.push("-p", parent);
    if (reconnectBase && reconnectBase !== parent)
      args.push("-p", reconnectBase);
    const commit = (await this.git(args, { input: message })).stdout.trim();
    if (this.lfsAvailable) {
      const lfsPush = await this.git(["lfs", "push", "origin", commit], {
        allow: [1, 2, 128],
      });
      if (lfsPush.code !== 0) {
        this.lfsError = lfsPush.stderr || "Git LFS push failed";
        throw new Error(this.lfsError);
      }
    }
    await this.git([
      "push",
      "origin",
      `${commit}:refs/heads/${this.input.branch}`,
    ]);
    return { commit, changed: true };
  }

  isNonFastForward(error: unknown): boolean {
    return (
      error instanceof GitCommandError &&
      /non-fast-forward|fetch first|\[rejected\]/iu.test(error.stderr)
    );
  }

  async reset(): Promise<void> {
    await rm(this.gitDir, { recursive: true, force: true });
  }
}
