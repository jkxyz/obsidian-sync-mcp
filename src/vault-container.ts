import { Container } from "@cloudflare/containers";
import type { AppEnv } from "./env.js";
import { decryptJson, encryptJson } from "./auth/crypto.js";
import { createInstallationToken, validateGitHubBranch } from "./github.js";
import {
  isMutation,
  type GitReconcileResult,
  type GitSafetyEvent,
  type VaultOperation,
  type VaultResponse,
} from "./shared/protocol.js";

type StoredCredentials = {
  token: string;
  vault?: string;
  vaultPassword?: string;
};

type RemoteVault = { id?: string; name?: string };

export type AdminStatus = {
  configured: boolean;
  vault?: string;
  remoteVaults?: RemoteVault[];
  runtime?: unknown;
  git?: GitAdminStatus;
};

export type GitAdminStatus = {
  configured: boolean;
  repository?: string;
  branch?: string;
  baseCommit?: string;
  mode?: "paused" | "active" | "quarantined";
  status?: GitReconcileResult;
};

type GitConfigurationRow = {
  installation_id: number;
  repository_id: number;
  repository: string;
  branch: string;
  base_commit: string | null;
  enabled: number;
  mode: "paused" | "active" | "quarantined";
  status_json: string | null;
};

type BootstrapResult = VaultResponse<{ vaults?: RemoteVault[] }>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class VaultContainer extends Container<AppEnv> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "1h";
  // Obsidian Sync uses a native WSS connection. Cloudflare's HTTPS outbound
  // interception is HTTP-level and cannot transparently carry that protocol.
  override enableInternet = true;
  override pingEndpoint = "localhost/health";
  private queueTail: Promise<void> = Promise.resolve();
  private scheduledReconcilePending = false;

  constructor(ctx: DurableObjectState<{}>, env: AppEnv) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      HOME: "/home/ob",
      XDG_CONFIG_HOME: "/data/config",
      VAULT_ROOT: "/data/vault",
      INDEX_PATH: "/data/index.sqlite",
      OBSIDIAN_HEADLESS_COMMAND: "/app/node_modules/.bin/ob",
      PORT: "8080",
      DEVICE_NAME: env.DEVICE_NAME,
      INTERNAL_CONTAINER_TOKEN: env.INTERNAL_CONTAINER_TOKEN,
    };
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS credential_envelope (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        envelope TEXT NOT NULL,
        vault TEXT,
        remote_vaults_json TEXT NOT NULL DEFAULT '[]',
        configured INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS operations (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS operations_updated_at_idx ON operations(updated_at);
      CREATE TABLE IF NOT EXISTS git_configuration (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        installation_id INTEGER NOT NULL,
        repository_id INTEGER NOT NULL,
        repository TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'active',
        status_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS oauth_flow_claims (
        nonce TEXT PRIMARY KEY,
        consumed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1), (2), (3);
    `);
    const gitColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(git_configuration)")
      .toArray()
      .map((column) => column.name);
    if (!gitColumns.includes("mode"))
      this.ctx.storage.sql.exec(
        "ALTER TABLE git_configuration ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'",
      );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (4)",
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(operation, operation);
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async claimOAuthFlow(nonce: string): Promise<boolean> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        nonce,
      )
    )
      return false;
    const existing = this.ctx.storage.sql
      .exec<{ nonce: string }>(
        "SELECT nonce FROM oauth_flow_claims WHERE nonce = ?",
        nonce,
      )
      .toArray()[0];
    if (existing) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_flow_claims (nonce) VALUES (?)",
      nonce,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_flow_claims WHERE consumed_at < datetime('now', '-1 day')",
    );
    return true;
  }

  private credentialRow(): {
    envelope: string;
    vault: string | null;
    remote_vaults_json: string;
    configured: number;
  } | null {
    return (
      this.ctx.storage.sql
        .exec<{
          envelope: string;
          vault: string | null;
          remote_vaults_json: string;
          configured: number;
        }>(
          "SELECT envelope, vault, remote_vaults_json, configured FROM credential_envelope WHERE id = 1",
        )
        .toArray()[0] ?? null
    );
  }

  private async storedCredentials(): Promise<StoredCredentials | null> {
    const row = this.credentialRow();
    return row
      ? decryptJson<StoredCredentials>(
          row.envelope,
          this.env.CREDENTIAL_ENCRYPTION_KEY,
        )
      : null;
  }

  private gitRow(): GitConfigurationRow | null {
    return (
      this.ctx.storage.sql
        .exec<GitConfigurationRow>(
          "SELECT installation_id, repository_id, repository, branch, base_commit, enabled, mode, status_json FROM git_configuration WHERE id = 1",
        )
        .toArray()[0] ?? null
    );
  }

  private gitAdminStatus(): GitAdminStatus {
    const row = this.gitRow();
    if (!row || row.enabled !== 1) return { configured: false };
    return {
      configured: true,
      repository: row.repository,
      branch: row.branch,
      mode: row.mode,
      ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
      ...(row.status_json
        ? { status: JSON.parse(row.status_json) as GitReconcileResult }
        : {}),
    };
  }

  private async callContainer<T>(path: string, body: unknown): Promise<T> {
    const response = await this.containerFetch(`http://localhost${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.INTERNAL_CONTAINER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as T;
    if (!response.ok)
      throw new Error(`Container request failed (${response.status})`);
    return parsed;
  }

  private saveCredentials(
    credentials: StoredCredentials,
    vaults: RemoteVault[],
    configured: boolean,
  ): Promise<void> {
    return encryptJson(credentials, this.env.CREDENTIAL_ENCRYPTION_KEY).then(
      (envelope) => {
        this.ctx.storage.sql.exec(
          `INSERT INTO credential_envelope (id, envelope, vault, remote_vaults_json, configured, updated_at)
         VALUES (1, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET envelope = excluded.envelope, vault = excluded.vault,
           remote_vaults_json = excluded.remote_vaults_json, configured = excluded.configured, updated_at = excluded.updated_at`,
          envelope,
          credentials.vault ?? null,
          JSON.stringify(vaults),
          configured ? 1 : 0,
        );
      },
    );
  }

  override async onStart(): Promise<void> {
    const row = this.credentialRow();
    if (!row || row.configured !== 1) return;
    const credentials = await this.storedCredentials();
    if (!credentials?.vault)
      throw new Error("Stored credential envelope could not be decrypted");
    const result = await this.callContainer<VaultResponse>(
      "/bootstrap/restore",
      {
        ...credentials,
        ...(this.gitRow()?.mode === "quarantined" ? { pauseSync: true } : {}),
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    if (this.gitRow()?.mode === "active")
      await this.reconcileGitInside("startup");
  }

  override async onActivityExpired(): Promise<void> {
    await this.renewActivityTimeout();
  }

  override onError(error: unknown): never {
    console.error(
      JSON.stringify({
        event: "vault_container_error",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    throw error;
  }

  async bootstrapLogin(input: {
    email: string;
    password: string;
    mfa?: string;
  }): Promise<BootstrapResult> {
    return this.enqueue(async () => {
      if (this.credentialRow()?.configured === 1) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "Reset the configured vault before signing in again",
          },
        };
      }
      try {
        const result = await this.callContainer<
          VaultResponse<{ token: string; vaults: RemoteVault[] }>
        >("/bootstrap/login", input);
        if (!result.ok)
          return {
            ok: false,
            error: result.error,
            ...(result.data
              ? { data: result.data as { vaults?: RemoteVault[] } }
              : {}),
          };
        await this.saveCredentials(
          { token: result.data.token },
          result.data.vaults,
          false,
        );
        return {
          ok: true,
          data: { vaults: result.data.vaults },
          sync_state: "not_applicable",
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : "Login failed",
          },
        };
      }
    });
  }

  async bootstrapConfigure(input: {
    vault: string;
    vaultPassword?: string;
  }): Promise<BootstrapResult> {
    return this.enqueue(async () => {
      const row = this.credentialRow();
      const credentials = await this.storedCredentials();
      if (!row || !credentials?.token)
        return {
          ok: false,
          error: {
            code: "not_configured",
            message: "Sign in to Obsidian first",
          },
        };
      const vaults = JSON.parse(row.remote_vaults_json) as RemoteVault[];
      if (
        !vaults.some(
          (candidate) =>
            candidate.id === input.vault || candidate.name === input.vault,
        )
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "The selected vault is not available to this account",
          },
        };
      }
      const next: StoredCredentials = {
        token: credentials.token,
        vault: input.vault,
        ...(input.vaultPassword ? { vaultPassword: input.vaultPassword } : {}),
      };
      try {
        const result = await this.callContainer<VaultResponse>(
          "/bootstrap/configure",
          next,
        );
        if (!result.ok) return { ok: false, error: result.error };
        await this.saveCredentials(next, vaults, true);
        if (this.gitRow()?.mode === "active")
          await this.reconcileGitInside("startup");
        return {
          ok: true,
          data: {},
          sync_state: result.sync_state ?? "synced_remote",
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              error instanceof Error ? error.message : "Configuration failed",
          },
        };
      }
    });
  }

  async adminStatus(): Promise<AdminStatus> {
    const row = this.credentialRow();
    if (!row) return { configured: false, git: this.gitAdminStatus() };
    let runtime: unknown;
    if (row.configured === 1) {
      try {
        runtime = await this.callContainer<unknown>("/runtime/status", {});
      } catch {
        runtime = { state: "unavailable" };
      }
    }
    return {
      configured: row.configured === 1,
      ...(row.vault ? { vault: row.vault } : {}),
      remoteVaults: JSON.parse(row.remote_vaults_json) as RemoteVault[],
      ...(runtime === undefined ? {} : { runtime }),
      git: this.gitAdminStatus(),
    };
  }

  async configureGit(input: {
    installationId: number;
    repositoryId: number;
    repository: string;
    branch: string;
  }): Promise<GitAdminStatus> {
    return this.enqueue(async () => {
      const token = await createInstallationToken(
        this.env,
        input.installationId,
        input.repositoryId,
      );
      await validateGitHubBranch(token, input.repository, input.branch);
      this.ctx.storage.sql.exec(
        "UPDATE git_configuration SET enabled = 0, updated_at = datetime('now') WHERE id = 1",
      );
      await this.callContainer("/git/reset", {});
      this.ctx.storage.sql.exec(
        `INSERT INTO git_configuration
          (id, installation_id, repository_id, repository, branch, base_commit, enabled, mode, status_json, updated_at)
         VALUES (1, ?, ?, ?, ?, NULL, 1, 'paused', NULL, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
          installation_id = excluded.installation_id,
          repository_id = excluded.repository_id,
          repository = excluded.repository,
          branch = excluded.branch,
          base_commit = NULL,
          enabled = 1,
          mode = 'paused',
          status_json = NULL,
          updated_at = datetime('now')`,
        input.installationId,
        input.repositoryId,
        input.repository,
        input.branch,
      );
      return this.gitAdminStatus();
    });
  }

  async disconnectGit(): Promise<void> {
    await this.enqueue(async () => {
      this.ctx.storage.sql.exec(
        "UPDATE git_configuration SET enabled = 0, updated_at = datetime('now') WHERE id = 1",
      );
      try {
        await this.callContainer("/git/reset", {});
      } finally {
        this.ctx.storage.sql.exec("DELETE FROM git_configuration");
      }
    });
  }

  async reconcileGit(
    resolution?: "adopt_remote" | "reconnect_base",
  ): Promise<GitReconcileResult | null> {
    return this.enqueue(async () => {
      const row = this.gitRow();
      return this.reconcileGitInside(
        "manual",
        undefined,
        false,
        resolution,
        "apply",
        undefined,
        undefined,
        row?.mode === "paused" && Boolean(row.base_commit),
      );
    });
  }

  async enableScheduledGit(): Promise<GitAdminStatus> {
    return this.enqueue(async () => {
      const row = this.gitRow();
      const status = row?.status_json
        ? (JSON.parse(row.status_json) as GitReconcileResult)
        : undefined;
      if (
        !row ||
        row.enabled !== 1 ||
        row.mode !== "paused" ||
        !row.base_commit ||
        status?.state !== "converged" ||
        status.transaction_id ||
        status.blocked_reason
      )
        throw new Error(
          "Complete the reviewed recovery and manual no-op checks before enabling the schedule",
        );
      this.ctx.storage.sql.exec(
        "UPDATE git_configuration SET mode = 'active', updated_at = datetime('now') WHERE id = 1",
      );
      return this.gitAdminStatus();
    });
  }

  async previewGit(restoreCommit?: string): Promise<GitReconcileResult | null> {
    return this.enqueue(async () =>
      this.reconcileGitInside(
        "manual",
        undefined,
        false,
        undefined,
        "preview",
        undefined,
        restoreCommit,
        true,
      ),
    );
  }

  async resolveGitSafety(
    action: "approve" | "reject",
    eventId: string,
  ): Promise<GitReconcileResult | null> {
    return this.enqueue(async () => {
      const row = this.gitRow();
      const status = row?.status_json
        ? (JSON.parse(row.status_json) as GitReconcileResult)
        : undefined;
      const event = status?.safety_event;
      if (!event || event.event_id !== eventId)
        throw new Error("The Git safety event is stale");
      return this.reconcileGitInside(
        "manual",
        undefined,
        false,
        undefined,
        action,
        event,
        event.restore_commit,
        true,
      );
    });
  }

  async refreshGitSafety(eventId: string): Promise<GitReconcileResult | null> {
    return this.enqueue(async () => {
      const row = this.gitRow();
      const status = row?.status_json
        ? (JSON.parse(row.status_json) as GitReconcileResult)
        : undefined;
      const event = status?.safety_event;
      if (!event || event.event_id !== eventId)
        throw new Error("The Git safety event is stale");
      return this.reconcileGitInside(
        "manual",
        undefined,
        false,
        undefined,
        "preview",
        event,
        event.restore_commit,
        true,
      );
    });
  }

  async gitSafetyManifest(eventId: string): Promise<{
    event_id: string;
    paths: string[];
  }> {
    const row = this.gitRow();
    const status = row?.status_json
      ? (JSON.parse(row.status_json) as GitReconcileResult)
      : undefined;
    if (status?.safety_event?.event_id !== eventId)
      throw new Error("The Git safety event is stale");
    return this.callContainer<{ event_id: string; paths: string[] }>(
      "/git/safety-manifest",
      { event_id: eventId },
    );
  }

  async scheduledReconcile(): Promise<void> {
    if (this.scheduledReconcilePending) return;
    this.scheduledReconcilePending = true;
    try {
      await this.enqueue(async () => {
        const configuredGit = this.gitRow();
        const configuredStatus = configuredGit?.status_json
          ? (JSON.parse(configuredGit.status_json) as GitReconcileResult)
          : undefined;
        if (configuredStatus?.transaction_id) {
          await this.reconcileGitInside("scheduled");
          return;
        }
        if (this.credentialRow()?.configured === 1) {
          const safety = await this.callContainer<{
            state: "ready" | "quarantined" | "not_ready";
            safety_event?: GitSafetyEvent;
          }>("/sync/safety-check", {});
          if (safety.state !== "ready") {
            const row = configuredGit;
            if (row?.enabled === 1 && safety.safety_event) {
              const attemptedAt = new Date().toISOString();
              const result: GitReconcileResult = {
                state: "blocked",
                ...(row.base_commit ? { base_commit: row.base_commit } : {}),
                retries: 0,
                conflict_count: 0,
                conflicts: [],
                unsupported_workflow_count: 0,
                unsupported_workflow_paths: [],
                blocked_reason: "destructive_change",
                safety_event: safety.safety_event,
                attempted_at: attemptedAt,
                lfs: { available: false, healthy: false },
              };
              this.ctx.storage.sql.exec(
                "UPDATE git_configuration SET mode = 'quarantined', status_json = ?, updated_at = datetime('now') WHERE id = 1",
                JSON.stringify(result),
              );
            }
            return;
          }
        }
        await this.reconcileGitInside(
          "scheduled",
          undefined,
          false,
          undefined,
          "apply",
          undefined,
          undefined,
          false,
          true,
        );
      });
    } finally {
      this.scheduledReconcilePending = false;
    }
  }

  private async reconcileGitInside(
    trigger: "startup" | "scheduled" | "mutation" | "manual",
    requestId?: string,
    emergency = false,
    resolution?: "adopt_remote" | "reconnect_base",
    action: "apply" | "preview" | "approve" | "reject" = "apply",
    safetyEvent?: GitSafetyEvent,
    restoreCommit?: string,
    allowPaused = false,
    syncBarrierComplete = false,
  ): Promise<GitReconcileResult | null> {
    const row = this.gitRow();
    if (!row || row.enabled !== 1 || this.credentialRow()?.configured !== 1)
      return null;
    const previousStatus = row.status_json
      ? (JSON.parse(row.status_json) as GitReconcileResult)
      : undefined;
    if (previousStatus?.transaction_id) {
      try {
        const finalizedMode = previousStatus.safety_event ? "paused" : row.mode;
        await this.callContainer("/git/finalize", {
          transaction_id: previousStatus.transaction_id,
        });
        previousStatus.state = "converged";
        delete previousStatus.transaction_id;
        delete previousStatus.safety_event;
        delete previousStatus.error;
        this.ctx.storage.sql.exec(
          "UPDATE git_configuration SET mode = ?, status_json = ?, updated_at = datetime('now') WHERE id = 1",
          finalizedMode,
          JSON.stringify(previousStatus),
        );
        return previousStatus;
      } catch (error) {
        const pendingFinalization: GitReconcileResult = {
          ...previousStatus,
          state: "pending",
          error:
            error instanceof Error
              ? error.message
              : "Git transaction finalization failed",
        };
        this.ctx.storage.sql.exec(
          "UPDATE git_configuration SET status_json = ?, updated_at = datetime('now') WHERE id = 1",
          JSON.stringify(pendingFinalization),
        );
        return pendingFinalization;
      }
    }
    if (
      !allowPaused &&
      row.mode !== "active" &&
      !(emergency && row.base_commit)
    )
      return null;
    let result: GitReconcileResult;
    const attemptedAt = new Date().toISOString();
    try {
      const token = await createInstallationToken(
        this.env,
        row.installation_id,
        row.repository_id,
      );
      result = await this.callContainer<GitReconcileResult>("/git/reconcile", {
        token,
        repository: row.repository,
        branch: row.branch,
        ...(row.base_commit ? { base_commit: row.base_commit } : {}),
        trigger,
        ...(requestId ? { request_id: requestId } : {}),
        ...(emergency ? { emergency: true } : {}),
        ...(resolution ? { resolution } : {}),
        action,
        ...(safetyEvent ? { safety_event: safetyEvent } : {}),
        ...(restoreCommit ? { restore_commit: restoreCommit } : {}),
        ...(syncBarrierComplete ? { sync_barrier_complete: true } : {}),
      });
    } catch (error) {
      result = {
        state: "pending",
        ...(row.base_commit ? { base_commit: row.base_commit } : {}),
        retries: 0,
        conflict_count: 0,
        conflicts: [],
        unsupported_workflow_count: 0,
        unsupported_workflow_paths: [],
        error:
          error instanceof Error ? error.message : "Git reconciliation failed",
        lfs: { available: false, healthy: false },
      };
    }
    result = {
      ...result,
      attempted_at: attemptedAt,
      ...(result.state === "converged"
        ? { succeeded_at: attemptedAt }
        : previousStatus?.succeeded_at
          ? { succeeded_at: previousStatus.succeeded_at }
          : {}),
    };
    const nextMode =
      result.state === "blocked" &&
      result.blocked_reason === "destructive_change"
        ? "quarantined"
        : result.state === "blocked" &&
            result.blocked_reason === "preflight_required"
          ? "paused"
          : result.state === "converged" && action === "reject"
            ? "active"
            : row.mode;
    this.ctx.storage.sql.exec(
      `UPDATE git_configuration SET
        base_commit = CASE WHEN ? = 'converged' AND ? IS NOT NULL THEN ? ELSE base_commit END,
        mode = ?, status_json = ?, updated_at = datetime('now') WHERE id = 1`,
      result.state,
      result.base_commit ?? null,
      result.base_commit ?? null,
      nextMode,
      JSON.stringify(result),
    );
    if (result.transaction_id) {
      try {
        await this.callContainer("/git/finalize", {
          transaction_id: result.transaction_id,
        });
        delete result.transaction_id;
        delete result.safety_event;
        delete result.error;
        this.ctx.storage.sql.exec(
          `UPDATE git_configuration SET mode = CASE WHEN ? = 'approve' THEN 'paused' ELSE mode END,
            status_json = ?, updated_at = datetime('now') WHERE id = 1`,
          action,
          JSON.stringify(result),
        );
      } catch {
        // The committed journal is retained and retried before the next cycle.
        result.state = "pending";
        result.error =
          "The Git commit was recorded, but local checkpoint finalization is pending";
        this.ctx.storage.sql.exec(
          "UPDATE git_configuration SET status_json = ?, updated_at = datetime('now') WHERE id = 1",
          JSON.stringify(result),
        );
      }
    }
    return result;
  }

  async resetConfiguration(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.callContainer("/bootstrap/reset", {});
        await this.callContainer("/git/reset", {});
      } finally {
        this.ctx.storage.sql.exec(
          "DELETE FROM credential_envelope; DELETE FROM operations; DELETE FROM git_configuration;",
        );
      }
    });
  }

  async invoke(operation: VaultOperation): Promise<VaultResponse> {
    return this.enqueue(async () => {
      if (!isMutation(operation)) {
        const result = await this.callOperation(operation);
        if (operation.kind === "vault_status" && result.ok)
          return {
            ...result,
            data: {
              ...(result.data && typeof result.data === "object"
                ? result.data
                : {}),
              git: this.gitAdminStatus(),
            },
          };
        return result;
      }
      const hash = await requestHash(operation);
      const previous = this.ctx.storage.sql
        .exec<{ request_hash: string; response_json: string | null }>(
          "SELECT request_hash, response_json FROM operations WHERE request_id = ?",
          operation.request_id,
        )
        .toArray()[0];
      if (previous) {
        if (previous.request_hash !== hash) {
          return {
            ok: false,
            error: {
              code: "invalid_input",
              message: "request_id was already used with different input",
            },
          };
        }
        if (previous.response_json)
          return JSON.parse(previous.response_json) as VaultResponse;
      } else {
        this.ctx.storage.sql.exec(
          "INSERT INTO operations (request_id, request_hash, operation_kind, status) VALUES (?, ?, ?, 'running')",
          operation.request_id,
          hash,
          operation.kind,
        );
      }
      let result = await this.callOperation(operation);
      if (result.ok || result.data !== undefined) {
        const git = await this.reconcileGitInside(
          "mutation",
          operation.request_id,
          !result.ok && result.sync_state === "sync_pending",
        );
        result = {
          ...result,
          git_state: git
            ? git.state === "converged"
              ? "converged"
              : "pending"
            : this.gitRow()?.enabled === 1
              ? "pending"
              : "not_configured",
        } as VaultResponse;
      } else result = { ...result, git_state: "not_applicable" };
      if (result.ok || result.data !== undefined) {
        this.ctx.storage.sql.exec(
          "UPDATE operations SET status = ?, response_json = ?, updated_at = datetime('now') WHERE request_id = ?",
          result.ok ? "completed" : "failed",
          JSON.stringify(result),
          operation.request_id,
        );
      } else {
        this.ctx.storage.sql.exec(
          "DELETE FROM operations WHERE request_id = ?",
          operation.request_id,
        );
      }
      return result;
    });
  }

  private async callOperation(
    operation: VaultOperation,
  ): Promise<VaultResponse> {
    const row = this.credentialRow();
    if (!row || row.configured !== 1)
      return {
        ok: false,
        error: {
          code: "not_configured",
          message: "Configure the vault through /admin first",
        },
      };
    try {
      return await this.callContainer<VaultResponse>("/rpc", operation);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message:
            error instanceof Error
              ? error.message
              : "Container operation failed",
        },
      };
    }
  }
}
