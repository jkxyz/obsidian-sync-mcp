import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { VaultOperationError } from "./protocol.js";

type CommandResult = { stdout: string; stderr: string };
export type RemoteVault = { id?: string; name?: string };
export type SyncMode = "bidirectional" | "mirror-remote";
export type SyncStateRows = { data: string }[];

export type SyncRunObservation = {
  summary: ReturnType<typeof summarizeSyncRun>;
  deletedRemotePaths: string[];
  removedLocalPaths: string[];
  deletedLocalPaths: string[];
};

export type MirrorSnapshot = {
  version: number;
  digest: string;
  files: Record<string, { size: number; sha256: string }>;
};
const HEADLESS_COMMAND = process.env.OBSIDIAN_HEADLESS_COMMAND ?? "ob";

export function summarizeSyncRun(result: CommandResult): {
  outputLines: number;
  stderrLines: number;
  downloaded: number;
  restored: number;
  removedLocal: number;
  deletedRemote: number;
  deletedLocal: number;
  fullySynced: number;
} {
  const stdout = result.stdout.split(/\r?\n/u).filter(Boolean);
  const stderr = result.stderr.split(/\r?\n/u).filter(Boolean);
  const matching = (text: string) =>
    stdout.filter((line) => line.includes(text)).length;
  return {
    outputLines: stdout.length,
    stderrLines: stderr.length,
    downloaded: matching("Downloaded "),
    restored: matching("Restoring "),
    removedLocal: matching("Removing local-only "),
    deletedRemote: matching("Deleting remote "),
    deletedLocal: stdout.filter(
      (line) =>
        line.startsWith("Deleting ") && !line.startsWith("Deleting remote "),
    ).length,
    fullySynced: matching("Fully synced"),
  };
}

export function observeSyncRun(result: CommandResult): SyncRunObservation {
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  const paths = (pattern: RegExp) =>
    lines.flatMap((line) => {
      const match = pattern.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
  return {
    summary: summarizeSyncRun(result),
    deletedRemotePaths: paths(/^Deleting remote (?:file|folder) (.+)$/u),
    removedLocalPaths: paths(/^Removing local-only (?:file|folder) (.+)$/u),
    deletedLocalPaths: paths(/^Deleting (?!remote )(?:file |folder )?(.+)$/u),
  };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotDirectory(
  root: string,
  version: number,
  include: (pathName: string) => boolean = () => true,
): Promise<MirrorSnapshot> {
  const files: Record<string, { size: number; sha256: string }> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink())
        throw new Error(`The Obsidian safety mirror contains a symbolic link`);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) {
        if (!include(relative)) continue;
        const data = await readFile(absolute);
        files[relative.normalize("NFC")] = {
          size: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      } else
        throw new Error("The Obsidian safety mirror contains an unsafe entry");
    }
  };
  await walk(root);
  const digest = createHash("sha256");
  for (const [pathName, entry] of Object.entries(files).sort(
    ([left], [right]) => left.localeCompare(right),
  ))
    digest.update(`${pathName}\0${entry.size}\0${entry.sha256}\0`);
  return { version, digest: digest.digest("hex"), files };
}

export function isSyncEligiblePath(pathName: string): boolean {
  if (!pathName.startsWith(".")) return true;
  if (!pathName.startsWith(".obsidian/")) return false;
  const relative = pathName.slice(".obsidian/".length);
  const parts = relative.split("/");
  if (relative === "workspace.json" || relative === "workspace-mobile.json")
    return false;
  if (
    parts.length === 1 &&
    [
      "app.json",
      "types.json",
      "appearance.json",
      "hotkeys.json",
      "core-plugins.json",
      "core-plugins-migration.json",
      "community-plugins.json",
    ].includes(relative)
  )
    return true;
  if (parts.length === 1 && relative.endsWith(".json")) return true;
  if (
    parts[0] === "themes" &&
    parts.length === 3 &&
    (parts[2] === "theme.css" || parts[2] === "manifest.json")
  )
    return true;
  if (
    parts[0] === "snippets" &&
    parts.length === 2 &&
    parts[1]?.endsWith(".css")
  )
    return true;
  return (
    parts[0] === "plugins" &&
    parts.length === 3 &&
    ["manifest.json", "main.js", "styles.css", "data.json"].includes(
      parts[2] ?? "",
    )
  );
}

export function summarizeSyncStateRows(rows: SyncStateRows): {
  entries: number;
  activeFiles: number;
  activeFolders: number;
  deleted: number;
  unreadable: number;
} {
  let activeFiles = 0;
  let activeFolders = 0;
  let deleted = 0;
  let unreadable = 0;
  for (const row of rows) {
    try {
      const state = JSON.parse(row.data) as {
        deleted?: boolean;
        folder?: boolean;
      };
      if (state.deleted) deleted += 1;
      else if (state.folder) activeFolders += 1;
      else activeFiles += 1;
    } catch {
      unreadable += 1;
    }
  }
  return {
    entries: rows.length,
    activeFiles,
    activeFolders,
    deleted,
    unreadable,
  };
}

export function safeEnvironment(
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    NODE_ENV: process.env.NODE_ENV,
    ...overrides,
  };
}

export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: safeEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceTimer.unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut)
        reject(
          new Error(
            `${command} timed out after ${timeoutMs}ms${stderr ? `: ${stderr.slice(-1000)}` : ""}`,
          ),
        );
      else if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} exited unsuccessfully (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr.slice(-1000)}` : ""}`,
          ),
        );
    });
  });
}

export function remoteVaults(value: unknown): RemoteVault[] {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [
          ...(Array.isArray((value as { vaults?: unknown }).vaults)
            ? (value as { vaults: unknown[] }).vaults
            : []),
          ...(Array.isArray((value as { shared?: unknown }).shared)
            ? (value as { shared: unknown[] }).shared
            : []),
        ]
      : [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.vaultId === "string"
          ? record.vaultId
          : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    return id || name
      ? [{ ...(id ? { id } : {}), ...(name ? { name } : {}) }]
      : [];
  });
}

export function syncConfigArgs(
  vaultRoot: string,
  deviceName: string,
  mode: SyncMode,
): string[] {
  return [
    "sync-config",
    "--path",
    vaultRoot,
    "--mode",
    mode,
    "--conflict-strategy",
    "conflict",
    "--file-types",
    "image,audio,video,pdf,unsupported",
    "--configs",
    "app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data",
    "--excluded-folders",
    "",
    "--config-dir",
    ".obsidian",
    "--device-name",
    deviceName,
    "--json",
  ];
}

export class SyncSupervisor {
  private authToken: string | null = null;
  private connection: {
    token: string;
    vault: string;
    vaultPassword?: string;
  } | null = null;
  private lastSyncAt: string | null = null;
  private lastSyncError: string | null = null;
  private lastSyncSummary: ReturnType<typeof summarizeSyncRun> | null = null;

  constructor(
    private readonly vaultRoot: string,
    private readonly deviceName: string,
  ) {}

  private commandEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    if (!this.authToken)
      throw new VaultOperationError(
        "not_configured",
        "Obsidian authentication is not configured",
      );
    return { OBSIDIAN_AUTH_TOKEN: this.authToken, ...extra };
  }

  async login(input: {
    email: string;
    password: string;
    mfa?: string;
  }): Promise<{ token: string; vaults: RemoteVault[] }> {
    const configRoot = path.join("/tmp", `obsidian-login-${randomUUID()}`);
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    try {
      const args = [
        "login",
        "--email",
        input.email,
        "--password",
        input.password,
      ];
      if (input.mfa) args.push("--mfa", input.mfa);
      await runCommand(
        HEADLESS_COMMAND,
        args,
        { XDG_CONFIG_HOME: configRoot },
        60_000,
      );
      const token = (
        await readFile(
          path.join(configRoot, "obsidian-headless", "auth_token"),
          "utf8",
        )
      ).trim();
      if (!token)
        throw new Error(
          "Obsidian login did not produce an authentication token",
        );
      const listed = await runCommand(
        HEADLESS_COMMAND,
        ["sync-list-remote", "--json"],
        { XDG_CONFIG_HOME: configRoot, OBSIDIAN_AUTH_TOKEN: token },
        60_000,
      );
      const vaults = remoteVaults(JSON.parse(listed.stdout));
      if (vaults.length === 0)
        throw new Error(
          "No Obsidian Sync vaults were returned for this account",
        );
      return { token, vaults };
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  }

  async configure(input: {
    token: string;
    vault: string;
    vaultPassword?: string;
  }): Promise<void> {
    this.authToken = input.token;
    this.connection = input;
    await mkdir(this.vaultRoot, { recursive: true, mode: 0o700 });
    try {
      await runCommand(
        HEADLESS_COMMAND,
        ["sync-status", "--path", this.vaultRoot, "--json"],
        this.commandEnvironment(),
        30_000,
      );
    } catch {
      const args = [
        "sync-setup",
        "--vault",
        input.vault,
        "--path",
        this.vaultRoot,
        "--device-name",
        this.deviceName,
        "--json",
      ];
      if (input.vaultPassword) args.push("--password", input.vaultPassword);
      await runCommand(
        HEADLESS_COMMAND,
        args,
        this.commandEnvironment(),
        120_000,
      );
    }
    await this.configureMode("mirror-remote");
  }

  async activateBidirectional(): Promise<void> {
    await this.configureMode("bidirectional");
  }

  async activateMirrorRemote(): Promise<void> {
    await this.configureMode("mirror-remote");
  }

  private async configureMode(mode: SyncMode): Promise<void> {
    await runCommand(
      HEADLESS_COMMAND,
      syncConfigArgs(this.vaultRoot, this.deviceName, mode),
      this.commandEnvironment(),
      60_000,
    );
  }

  async oneShot(): Promise<SyncRunObservation> {
    try {
      const result = await runCommand(
        HEADLESS_COMMAND,
        ["sync", "--path", this.vaultRoot],
        this.commandEnvironment(),
        300_000,
      );
      const observation = observeSyncRun(result);
      this.lastSyncSummary = observation.summary;
      if (observation.summary.fullySynced === 0)
        throw new Error(
          "Obsidian Sync exited before reporting that the vault was fully synced",
        );
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncError = null;
      return observation;
    } catch (error) {
      this.lastSyncError =
        error instanceof Error ? error.message : "Sync failed";
      throw error;
    }
  }

  async refreshSafetyMirror(): Promise<{
    snapshot: MirrorSnapshot;
    observation: SyncRunObservation;
  }> {
    if (!this.connection)
      throw new VaultOperationError(
        "not_configured",
        "Obsidian authentication is not configured",
      );
    const dataRoot = path.dirname(this.vaultRoot);
    const mirrorRoot = path.join(dataRoot, "obsidian-safety-mirror");
    const mirrorConfig = path.join(dataRoot, "config-safety-mirror");
    await mkdir(mirrorRoot, { recursive: true, mode: 0o700 });
    await mkdir(mirrorConfig, { recursive: true, mode: 0o700 });
    const environment = {
      OBSIDIAN_AUTH_TOKEN: this.connection.token,
      XDG_CONFIG_HOME: mirrorConfig,
    };
    try {
      await runCommand(
        HEADLESS_COMMAND,
        ["sync-status", "--path", mirrorRoot, "--json"],
        environment,
        30_000,
      );
    } catch {
      const setup = [
        "sync-setup",
        "--vault",
        this.connection.vault,
        "--path",
        mirrorRoot,
        "--device-name",
        `${this.deviceName} safety mirror`,
        "--json",
      ];
      if (this.connection.vaultPassword)
        setup.push("--password", this.connection.vaultPassword);
      await runCommand(HEADLESS_COMMAND, setup, environment, 120_000);
    }
    await runCommand(
      HEADLESS_COMMAND,
      syncConfigArgs(
        mirrorRoot,
        `${this.deviceName} safety mirror`,
        "mirror-remote",
      ),
      environment,
      60_000,
    );
    const result = await runCommand(
      HEADLESS_COMMAND,
      ["sync", "--path", mirrorRoot],
      environment,
      300_000,
    );
    const observation = observeSyncRun(result);
    if (observation.summary.fullySynced === 0)
      throw new Error("The Obsidian safety mirror did not fully synchronize");
    const status = JSON.parse(
      (
        await runCommand(
          HEADLESS_COMMAND,
          ["sync-status", "--path", mirrorRoot, "--json"],
          environment,
          30_000,
        )
      ).stdout,
    ) as { vaultId?: string };
    const version = status.vaultId
      ? this.stateVersion(mirrorConfig, status.vaultId)
      : 0;
    return {
      snapshot: await snapshotDirectory(mirrorRoot, version),
      observation,
    };
  }

  async loadMirrorBaseline(): Promise<MirrorSnapshot | null> {
    const baselinePath = path.join(
      path.dirname(this.vaultRoot),
      "obsidian-safety-mirror-baseline.json",
    );
    try {
      return JSON.parse(await readFile(baselinePath, "utf8")) as MirrorSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async saveMirrorBaseline(snapshot: MirrorSnapshot): Promise<void> {
    const baselinePath = path.join(
      path.dirname(this.vaultRoot),
      "obsidian-safety-mirror-baseline.json",
    );
    const temporary = `${baselinePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, baselinePath);
  }

  async snapshotLiveSyncSubset(): Promise<MirrorSnapshot> {
    return snapshotDirectory(this.vaultRoot, 0, isSyncEligiblePath);
  }

  async reinitializeStateAndRepublish(): Promise<SyncRunObservation> {
    if (!this.authToken) throw new Error("Obsidian Sync is not configured");
    const status = JSON.parse(
      (
        await runCommand(
          HEADLESS_COMMAND,
          ["sync-status", "--path", this.vaultRoot, "--json"],
          this.commandEnvironment(),
          30_000,
        )
      ).stdout,
    ) as { vaultId?: string };
    if (status.vaultId) {
      const configRoot =
        process.env.XDG_CONFIG_HOME ??
        path.join(process.env.HOME ?? "/home/ob", ".config");
      const stateRoot = path.join(
        configRoot,
        "obsidian-headless",
        "sync",
        status.vaultId,
      );
      if (await fileExists(stateRoot)) {
        const archiveRoot = path.join(
          path.dirname(this.vaultRoot),
          "config-archive",
        );
        await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
        await rename(
          stateRoot,
          path.join(archiveRoot, `${status.vaultId}-${Date.now()}`),
        );
      }
    }
    await this.activateBidirectional();
    return this.oneShot();
  }

  async status(): Promise<unknown> {
    let cliStatus: unknown = null;
    let stateDatabase: unknown = { available: false };
    if (this.authToken) {
      try {
        const result = await runCommand(
          HEADLESS_COMMAND,
          ["sync-status", "--path", this.vaultRoot, "--json"],
          this.commandEnvironment(),
          30_000,
        );
        cliStatus = JSON.parse(result.stdout);
        const vaultId =
          cliStatus &&
          typeof cliStatus === "object" &&
          typeof (cliStatus as { vaultId?: unknown }).vaultId === "string"
            ? (cliStatus as { vaultId: string }).vaultId
            : null;
        if (vaultId) stateDatabase = this.inspectStateDatabase(vaultId);
      } catch (error) {
        cliStatus = {
          error: error instanceof Error ? error.message : "Status failed",
        };
      }
    }
    return {
      driver: "scheduled_one_shot",
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncSummary: this.lastSyncSummary,
      stateDatabase,
      cli: cliStatus,
    };
  }

  private inspectStateDatabase(vaultId: string): unknown {
    const configHome =
      process.env.XDG_CONFIG_HOME ??
      path.join(process.env.HOME ?? "/home/ob", ".config");
    const databasePath = path.join(
      configHome,
      "obsidian-headless",
      "sync",
      vaultId,
      "state.db",
    );
    let database: Database.Database | null = null;
    try {
      database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const server = summarizeSyncStateRows(
        database
          .prepare("SELECT data FROM server_files")
          .all() as SyncStateRows,
      );
      const local = summarizeSyncStateRows(
        database.prepare("SELECT data FROM local_files").all() as SyncStateRows,
      );
      const pending = (
        database.prepare("SELECT COUNT(*) count FROM pending_files").get() as {
          count: number;
        }
      ).count;
      const meta = Object.fromEntries(
        (
          database.prepare("SELECT key, value FROM meta").all() as {
            key: string;
            value: string;
          }[]
        ).map((row) => [row.key, row.value]),
      );
      return {
        available: true,
        server,
        local,
        pending,
        initial: meta.initial !== "false",
        version: Number(meta.version ?? "0"),
      };
    } catch {
      return { available: false };
    } finally {
      database?.close();
    }
  }

  private stateVersion(configRoot: string, vaultId: string): number {
    const databasePath = path.join(
      configRoot,
      "obsidian-headless",
      "sync",
      vaultId,
      "state.db",
    );
    let database: Database.Database | null = null;
    try {
      database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const row = database
        .prepare("SELECT value FROM meta WHERE key = 'version'")
        .get() as { value?: string } | undefined;
      return Number(row?.value ?? "0");
    } catch {
      return 0;
    } finally {
      database?.close();
    }
  }
}
