import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import mime from "mime-types";
import { VaultIndexer, revisionOf } from "./indexer.js";
import { applyPatches } from "./patch.js";
import {
  absoluteVaultPath,
  normalizeVaultPath,
  rejectCaseCollision,
  rejectSymlinkSegments,
  requireNotePath,
} from "./path-policy.js";
import {
  isMutation,
  MAX_ATTACHMENT_BYTES,
  VaultOperationError,
  type VaultOperation,
  type VaultResponse,
} from "./protocol.js";
import { SyncSupervisor } from "./sync.js";

type RuntimeState = "unconfigured" | "warming" | "ready" | "degraded";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(target: string, data: Uint8Array): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function strictBase64(value: string): Buffer {
  if (
    value.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new VaultOperationError(
      "invalid_input",
      "Attachment content is not canonical base64",
    );
  }
  const data = Buffer.from(value, "base64");
  if (data.byteLength > MAX_ATTACHMENT_BYTES)
    throw new VaultOperationError(
      "too_large",
      "Attachment exceeds the 5 MiB decoded limit",
    );
  if (data.toString("base64") !== value)
    throw new VaultOperationError(
      "invalid_input",
      "Attachment content is not canonical base64",
    );
  return data;
}

export class VaultService {
  private state: RuntimeState = "unconfigured";
  private stateError: string | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private sync: SyncSupervisor;

  constructor(
    private readonly vaultRoot: string,
    private readonly deviceName: string,
    private readonly indexer: VaultIndexer,
  ) {
    this.sync = new SyncSupervisor(vaultRoot, deviceName);
  }

  static async create(
    vaultRoot: string,
    indexPath: string,
    deviceName: string,
  ): Promise<VaultService> {
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    return new VaultService(
      vaultRoot,
      deviceName,
      new VaultIndexer(vaultRoot, indexPath),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    const result = this.queueTail.then(operation, operation);
    this.queueTail = result.then(
      () => {
        this.queueDepth -= 1;
      },
      () => {
        this.queueDepth -= 1;
      },
    );
    return result;
  }

  async login(input: {
    email: string;
    password: string;
    mfa?: string;
  }): Promise<VaultResponse> {
    return this.enqueue(async () => {
      try {
        const result = await this.sync.login(input);
        return { ok: true, data: result, sync_state: "not_applicable" };
      } catch (error) {
        return this.errorResponse(error);
      }
    });
  }

  async configure(input: {
    token: string;
    vault: string;
    vaultPassword?: string;
  }): Promise<VaultResponse> {
    return this.enqueue(async () => this.configureInsideQueue(input));
  }

  private async configureInsideQueue(input: {
    token: string;
    vault: string;
    vaultPassword?: string;
  }): Promise<VaultResponse> {
    this.state = "warming";
    this.stateError = null;
    try {
      await this.sync.stopContinuous();
      await this.indexer.stopWatching();
      await this.sync.configure(input);
      await this.sync.oneShot();
      await this.sync.activateBidirectional();
      await this.assertDiskHeadroom();
      await this.indexer.rebuild();
      this.indexer.startWatching();
      this.sync.startContinuous();
      this.state = "ready";
      return {
        ok: true,
        data: { vault: input.vault },
        sync_state: "synced_remote",
      };
    } catch (error) {
      this.state = "degraded";
      this.stateError =
        error instanceof Error ? error.message : "Configuration failed";
      return this.errorResponse(error);
    }
  }

  async reset(): Promise<VaultResponse> {
    return this.enqueue(async () => {
      await this.sync.stopContinuous();
      await this.indexer.stopWatching();
      await rm(this.vaultRoot, { recursive: true, force: true });
      await rm(path.join(path.dirname(this.vaultRoot), "config"), {
        recursive: true,
        force: true,
      });
      await mkdir(this.vaultRoot, { recursive: true, mode: 0o700 });
      await this.indexer.rebuild();
      this.sync = new SyncSupervisor(this.vaultRoot, this.deviceName);
      this.state = "unconfigured";
      this.stateError = null;
      return { ok: true, data: {}, sync_state: "not_applicable" };
    });
  }

  async runtimeStatus(): Promise<unknown> {
    return {
      state: this.state,
      stateError: this.stateError,
      queueDepth: this.queueDepth,
      counts: this.indexer.counts(),
      filesystemCounts: await this.indexer.filesystemCounts(),
      sync: await this.sync.status(),
      headlessVersion: "0.0.14",
    };
  }

  async handle(operation: VaultOperation): Promise<VaultResponse> {
    return this.enqueue(async () => {
      try {
        if (operation.kind === "vault_status")
          return {
            ok: true,
            data: await this.runtimeStatus(),
            sync_state: "not_applicable",
          };
        if (this.state !== "ready")
          throw new VaultOperationError(
            "not_ready",
            `Vault is ${this.state}`,
            this.stateError ? { error: this.stateError } : undefined,
          );
        if (isMutation(operation)) return await this.mutate(operation);
        return await this.read(operation);
      } catch (error) {
        return this.errorResponse(error);
      }
    });
  }

  private async read(
    operation: Exclude<
      VaultOperation,
      { request_id: string } | { kind: "vault_status" }
    >,
  ): Promise<VaultResponse> {
    switch (operation.kind) {
      case "list_files":
        return {
          ok: true,
          data: this.indexer.list(operation),
          sync_state: "not_applicable",
        };
      case "search_notes":
        return {
          ok: true,
          data: this.indexer.search(operation),
          sync_state: "not_applicable",
        };
      case "read_note": {
        const relative = requireNotePath(operation.path);
        await rejectSymlinkSegments(this.vaultRoot, relative);
        const data = await this.readExisting(relative);
        const content = data.toString("utf8");
        const lines = content.split("\n");
        if (
          operation.start_line &&
          operation.end_line &&
          operation.end_line < operation.start_line
        )
          throw new VaultOperationError(
            "invalid_input",
            "end_line must not be before start_line",
          );
        const start = (operation.start_line ?? 1) - 1;
        const end = operation.end_line ?? lines.length;
        const row = this.indexer.file(relative);
        return {
          ok: true,
          data: {
            path: relative,
            content: lines.slice(start, end).join("\n"),
            total_lines: lines.length,
            revision: revisionOf(data),
            title: row?.title,
            headings: JSON.parse(row?.headings_json ?? "[]") as string[],
            frontmatter: JSON.parse(row?.frontmatter_json ?? "{}") as Record<
              string,
              unknown
            >,
            tags: JSON.parse(row?.tags_json ?? "[]") as string[],
          },
          sync_state: "not_applicable",
        };
      }
      case "get_links": {
        const relative = requireNotePath(operation.path);
        if (!this.indexer.file(relative))
          throw new VaultOperationError("not_found", "Note was not found");
        return {
          ok: true,
          data: { path: relative, ...this.indexer.links(relative) },
          sync_state: "not_applicable",
        };
      }
      case "get_attachment": {
        const relative = normalizeVaultPath(operation.path);
        if (path.posix.extname(relative).toLocaleLowerCase("en-US") === ".md")
          throw new VaultOperationError(
            "invalid_input",
            "Use read_note for Markdown files",
          );
        await rejectSymlinkSegments(this.vaultRoot, relative);
        const data = await this.readExisting(relative);
        if (data.byteLength > MAX_ATTACHMENT_BYTES)
          throw new VaultOperationError(
            "too_large",
            "Attachment exceeds the 5 MiB read limit",
          );
        return {
          ok: true,
          data: {
            path: relative,
            mime_type: mime.lookup(relative) || "application/octet-stream",
            size: data.byteLength,
            revision: revisionOf(data),
            content_base64: data.toString("base64"),
          },
          sync_state: "not_applicable",
        };
      }
    }
  }

  private async mutate(
    operation: Extract<VaultOperation, { request_id: string }>,
  ): Promise<VaultResponse> {
    await this.sync.stopContinuous();
    try {
      try {
        await this.sync.oneShot();
        await this.indexer.flush();
      } catch (error) {
        throw new VaultOperationError(
          "sync_pending",
          "Could not pull current remote state; no local mutation was applied",
          {
            phase: "pull",
            cause: error instanceof Error ? error.message : "unknown",
          },
        );
      }
      const localResult = await this.applyMutation(operation);
      try {
        await this.sync.oneShot();
        return { ok: true, data: localResult, sync_state: "synced_remote" };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "sync_pending",
            message:
              "The mutation was applied locally but could not be confirmed remotely",
            details: {
              phase: "push",
              cause: error instanceof Error ? error.message : "unknown",
            },
          },
          data: localResult,
          sync_state: "sync_pending",
        };
      }
    } finally {
      this.sync.startContinuous();
    }
  }

  private async applyMutation(
    operation: Extract<VaultOperation, { request_id: string }>,
  ): Promise<Record<string, unknown>> {
    switch (operation.kind) {
      case "create_note": {
        const relative = requireNotePath(operation.path);
        const absolute = absoluteVaultPath(this.vaultRoot, relative);
        await rejectSymlinkSegments(this.vaultRoot, relative);
        await rejectCaseCollision(this.vaultRoot, relative);
        if (await exists(absolute))
          throw new VaultOperationError(
            "already_exists",
            "Destination already exists",
          );
        await atomicWrite(absolute, Buffer.from(operation.content, "utf8"));
        await this.indexer.indexPath(relative);
        const revision = revisionOf(Buffer.from(operation.content, "utf8"));
        return { path: relative, revision };
      }
      case "patch_note": {
        const relative = requireNotePath(operation.path);
        await rejectSymlinkSegments(this.vaultRoot, relative);
        const current = await this.readExisting(relative);
        this.assertRevision(current, operation.expected_revision);
        const updated = Buffer.from(
          applyPatches(current.toString("utf8"), operation.patches),
          "utf8",
        );
        await atomicWrite(absoluteVaultPath(this.vaultRoot, relative), updated);
        await this.indexer.indexPath(relative);
        return { path: relative, revision: revisionOf(updated) };
      }
      case "put_attachment": {
        const relative = normalizeVaultPath(operation.path);
        if (path.posix.extname(relative).toLocaleLowerCase("en-US") === ".md")
          throw new VaultOperationError(
            "invalid_input",
            "Use create_note or patch_note for Markdown files",
          );
        if (!/^[\w.+-]+\/[\w.+-]+$/u.test(operation.mime_type))
          throw new VaultOperationError("invalid_input", "Invalid MIME type");
        const data = strictBase64(operation.content_base64);
        const absolute = absoluteVaultPath(this.vaultRoot, relative);
        await rejectSymlinkSegments(this.vaultRoot, relative);
        await rejectCaseCollision(this.vaultRoot, relative);
        if (operation.expected_revision) {
          this.assertRevision(
            await this.readExisting(relative),
            operation.expected_revision,
          );
        } else if (await exists(absolute)) {
          throw new VaultOperationError(
            "already_exists",
            "Attachment already exists; expected_revision is required to replace it",
          );
        }
        await atomicWrite(absolute, data);
        await this.indexer.indexPath(relative);
        return {
          path: relative,
          revision: revisionOf(data),
          size: data.byteLength,
          mime_type: operation.mime_type,
        };
      }
      case "move_file": {
        const source = normalizeVaultPath(operation.source);
        const destination = normalizeVaultPath(operation.destination);
        const sourceData = await this.readExisting(source);
        this.assertRevision(sourceData, operation.expected_revision);
        await rejectSymlinkSegments(this.vaultRoot, source);
        await rejectSymlinkSegments(this.vaultRoot, destination);
        await rejectCaseCollision(this.vaultRoot, destination, source);
        const destinationAbsolute = absoluteVaultPath(
          this.vaultRoot,
          destination,
        );
        if (await exists(destinationAbsolute))
          throw new VaultOperationError(
            "already_exists",
            "Destination already exists",
          );
        const note =
          path.posix.extname(source).toLocaleLowerCase("en-US") === ".md";
        const destinationIsNote =
          path.posix.extname(destination).toLocaleLowerCase("en-US") === ".md";
        if (note !== destinationIsNote)
          throw new VaultOperationError(
            "invalid_path",
            "Moves cannot change a note into an attachment or an attachment into a note",
          );
        const affectedBacklinks = note
          ? this.indexer.links(source).backlinks
          : [];
        await mkdir(path.dirname(destinationAbsolute), {
          recursive: true,
          mode: 0o700,
        });
        await rename(
          absoluteVaultPath(this.vaultRoot, source),
          destinationAbsolute,
        );
        this.indexer.removePath(source, false);
        await this.indexer.indexPath(destination);
        return {
          source,
          destination,
          revision: revisionOf(sourceData),
          affected_backlinks: affectedBacklinks,
          links_rewritten: false,
        };
      }
      case "delete_file": {
        const relative = normalizeVaultPath(operation.path);
        await rejectSymlinkSegments(this.vaultRoot, relative);
        const current = await this.readExisting(relative);
        this.assertRevision(current, operation.expected_revision);
        await unlink(absoluteVaultPath(this.vaultRoot, relative));
        this.indexer.removePath(relative);
        return { path: relative, deleted_revision: revisionOf(current) };
      }
    }
  }

  private async readExisting(relative: string): Promise<Buffer> {
    try {
      return await readFile(absoluteVaultPath(this.vaultRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new VaultOperationError("not_found", `${relative} was not found`);
      throw error;
    }
  }

  private assertRevision(data: Uint8Array, expected: string): void {
    const actual = revisionOf(data);
    if (actual !== expected)
      throw new VaultOperationError(
        "revision_conflict",
        "The file changed after it was read",
        { expected, actual },
      );
  }

  private async assertDiskHeadroom(): Promise<void> {
    const filesystem = await statfs(path.dirname(this.vaultRoot));
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    let vaultBytes = 0;
    const accumulate = async (target: string): Promise<void> => {
      const targetStat = await stat(target);
      if (targetStat.isFile()) {
        vaultBytes += targetStat.size;
        return;
      }
      if (!targetStat.isDirectory()) return;
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(target))
        await accumulate(path.join(target, entry));
    };
    await accumulate(this.vaultRoot);
    const required = Math.max(256 * 1024 * 1024, Math.ceil(vaultBytes * 0.2));
    if (freeBytes < required)
      throw new VaultOperationError(
        "too_large",
        "Container disk does not have safe working headroom; deploy with instance_type basic",
        { freeBytes, vaultBytes, required },
      );
  }

  private errorResponse(error: unknown): VaultResponse {
    if (error instanceof VaultOperationError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "internal_error",
        message:
          error instanceof Error ? error.message : "Unexpected container error",
      },
    };
  }

  async shutdown(): Promise<void> {
    await this.sync.stopContinuous();
    await this.indexer.stopWatching();
    this.indexer.close();
  }
}
