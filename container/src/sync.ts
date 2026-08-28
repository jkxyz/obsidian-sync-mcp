import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { VaultOperationError } from "./protocol.js";

type CommandResult = { stdout: string; stderr: string };
export type RemoteVault = { id?: string; name?: string };
const HEADLESS_COMMAND = process.env.OBSIDIAN_HEADLESS_COMMAND ?? "ob";

function safeEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    NODE_ENV: process.env.NODE_ENV,
    ...overrides,
  };
}

function runCommand(
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
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
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
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

export class SyncSupervisor {
  private continuous: ChildProcess | null = null;
  private continuousDesired = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private authToken: string | null = null;
  private lastSyncAt: string | null = null;
  private lastSyncError: string | null = null;
  private continuousExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;

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
    await runCommand(
      HEADLESS_COMMAND,
      [
        "sync-config",
        "--path",
        this.vaultRoot,
        "--mode",
        "bidirectional",
        "--conflict-strategy",
        "conflict",
        "--file-types",
        "image,audio,video,pdf,unsupported",
        "--configs",
        "",
        "--device-name",
        this.deviceName,
        "--json",
      ],
      this.commandEnvironment(),
      60_000,
    );
  }

  async oneShot(): Promise<void> {
    try {
      await runCommand(
        HEADLESS_COMMAND,
        ["sync", "--path", this.vaultRoot],
        this.commandEnvironment(),
        300_000,
      );
      this.lastSyncAt = new Date().toISOString();
      this.lastSyncError = null;
    } catch (error) {
      this.lastSyncError =
        error instanceof Error ? error.message : "Sync failed";
      throw error;
    }
  }

  startContinuous(): void {
    this.continuousDesired = true;
    if (this.continuous || this.restartTimer) return;
    const child = spawn(
      HEADLESS_COMMAND,
      ["sync", "--path", this.vaultRoot, "--continuous"],
      {
        env: safeEnvironment(this.commandEnvironment()),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    let handled = false;
    const stopped = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: Error,
    ) => {
      if (handled) return;
      handled = true;
      this.continuousExit = { code, signal };
      if (this.continuous === child) this.continuous = null;
      if (error) this.lastSyncError = error.message;
      else if (code !== 0)
        this.lastSyncError = `Continuous sync exited (${code ?? signal ?? "unknown"})`;
      if (this.continuousDesired) this.scheduleRestart();
    };
    child.once("exit", (code, signal) => stopped(code, signal));
    child.once("error", (error) => stopped(null, null, error));
    this.continuous = child;
    this.continuousExit = null;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.continuousDesired) return;
    const delay = Math.min(
      60_000,
      1_000 * 2 ** Math.min(this.restartAttempts, 6),
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.continuousDesired) this.startContinuous();
    }, delay);
    this.restartTimer.unref();
  }

  async stopContinuous(): Promise<void> {
    this.continuousDesired = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAttempts = 0;
    const child = this.continuous;
    if (!child) return;
    this.continuous = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 10_000);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
  }

  async status(): Promise<unknown> {
    let cliStatus: unknown = null;
    if (this.authToken) {
      try {
        const result = await runCommand(
          HEADLESS_COMMAND,
          ["sync-status", "--path", this.vaultRoot, "--json"],
          this.commandEnvironment(),
          30_000,
        );
        cliStatus = JSON.parse(result.stdout);
      } catch (error) {
        cliStatus = {
          error: error instanceof Error ? error.message : "Status failed",
        };
      }
    }
    return {
      continuous: this.continuous !== null,
      continuousDesired: this.continuousDesired,
      restartAttempts: this.restartAttempts,
      continuousExit: this.continuousExit,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      cli: cliStatus,
    };
  }
}
