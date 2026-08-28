import { Container } from "@cloudflare/containers";
import type { AppEnv } from "./env.js";
import { decryptJson, encryptJson } from "./auth/crypto.js";
import {
  isMutation,
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
  override enableInternet = false;
  override allowedHosts = ["api.obsidian.md", "*.obsidian.md"];
  override pingEndpoint = "localhost/health";
  private queueTail: Promise<void> = Promise.resolve();

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
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
    `);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(operation, operation);
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      credentials,
    );
    if (!result.ok) throw new Error(result.error.message);
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
        return { ok: true, data: {}, sync_state: "synced_remote" };
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
    if (!row) return { configured: false };
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
    };
  }

  async resetConfiguration(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.callContainer("/bootstrap/reset", {});
      } finally {
        this.ctx.storage.sql.exec(
          "DELETE FROM credential_envelope; DELETE FROM operations;",
        );
      }
    });
  }

  async invoke(operation: VaultOperation): Promise<VaultResponse> {
    return this.enqueue(async () => {
      if (!isMutation(operation)) return this.callOperation(operation);
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
      const result = await this.callOperation(operation);
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
