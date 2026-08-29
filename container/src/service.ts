import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import mime from "mime-types";
import {
  analyzeDeletion,
  GitRepository,
  recoverVaultSwap,
  type DeletionAnalysis,
  type Tree,
} from "./git.js";
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
  type GitReconcileInput,
  type GitReconcileResult,
  type GitSafetyEvent,
  type GitSafetyPhase,
  type VaultOperation,
  type VaultResponse,
} from "./protocol.js";
import {
  SyncSupervisor,
  type MirrorSnapshot,
  type SyncRunObservation,
} from "./sync.js";

class SyncSafetyViolation extends Error {
  constructor(readonly event: GitSafetyEvent) {
    super("A destructive synchronization change requires admin review");
    this.name = "SyncSafetyViolation";
  }
}

type RuntimeState =
  "unconfigured" | "warming" | "ready" | "quarantined" | "degraded";

function mirrorTree(snapshot: MirrorSnapshot): Tree {
  return new Map(
    Object.entries(snapshot.files).map(([pathName, entry]) => [
      pathName,
      { mode: "100644" as const, oid: entry.sha256, size: entry.size },
    ]),
  );
}

function syncEventSummary(observation?: SyncRunObservation) {
  return observation
    ? {
        downloaded: observation.summary.downloaded,
        restored: observation.summary.restored,
        removed_local: observation.summary.removedLocal,
        deleted_remote: observation.summary.deletedRemote,
        deleted_local: observation.summary.deletedLocal,
      }
    : undefined;
}

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
  private lastGitResult: GitReconcileResult | null = null;
  private safetyEvent: GitSafetyEvent | null = null;

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
    await recoverVaultSwap(vaultRoot);
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    const service = new VaultService(
      vaultRoot,
      deviceName,
      new VaultIndexer(vaultRoot, indexPath),
    );
    await service.loadSafetyEvent();
    return service;
  }

  private safetyMarkerPath(): string {
    return path.join(
      path.dirname(this.vaultRoot),
      "git-safety-quarantine.json",
    );
  }

  private safetyManifestPath(): string {
    return path.join(path.dirname(this.vaultRoot), "git-safety-manifest.json");
  }

  private acceptedCheckpointPath(): string {
    return path.join(
      path.dirname(this.vaultRoot),
      "vault-accepted-checkpoint.json",
    );
  }

  private async loadSafetyEvent(): Promise<void> {
    try {
      this.safetyEvent = JSON.parse(
        await readFile(this.safetyMarkerPath(), "utf8"),
      ) as GitSafetyEvent;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async enterQuarantine(
    event: GitSafetyEvent,
    manifestPaths: string[] = event.paths,
  ): Promise<void> {
    const marker = this.safetyMarkerPath();
    await atomicWrite(
      this.safetyManifestPath(),
      Buffer.from(
        JSON.stringify({ event_id: event.event_id, paths: manifestPaths }),
        "utf8",
      ),
    );
    await atomicWrite(marker, Buffer.from(JSON.stringify(event), "utf8"));
    this.safetyEvent = event;
    this.state = "quarantined";
    this.stateError =
      "A destructive synchronization change requires admin review";
    await this.sync.stopContinuous();
  }

  private async leaveQuarantine(): Promise<void> {
    await rm(this.safetyMarkerPath(), { force: true });
    await rm(this.safetyManifestPath(), { force: true });
    this.safetyEvent = null;
    this.state = "ready";
    this.stateError = null;
  }

  private async safetyManifest(eventId: string): Promise<string[]> {
    const value = JSON.parse(
      await readFile(this.safetyManifestPath(), "utf8"),
    ) as { event_id?: string; paths?: unknown };
    if (value.event_id !== eventId || !Array.isArray(value.paths))
      throw new Error("The destructive-change manifest is unavailable");
    return value.paths.filter(
      (item): item is string => typeof item === "string",
    );
  }

  private makeSafetyEvent(
    phase: GitSafetyPhase,
    safeTree: string,
    candidateTree: string,
    analysis: DeletionAnalysis,
    input: {
      remoteHead?: string;
      remote?: MirrorSnapshot;
      observation?: SyncRunObservation;
      restoreCommit?: string;
      reasons?: string[];
      paths?: string[];
    } = {},
  ): GitSafetyEvent {
    const paths = input.paths ?? analysis.deletedPaths;
    return {
      event_id: randomUUID(),
      phase,
      created_at: new Date().toISOString(),
      safe_tree: safeTree,
      candidate_tree: candidateTree,
      ...(input.remoteHead ? { remote_head: input.remoteHead } : {}),
      ...(input.remote
        ? {
            remote_version: input.remote.version,
            remote_digest: input.remote.digest,
          }
        : {}),
      previous_files: analysis.previousFiles,
      candidate_files: analysis.candidateFiles,
      deleted_files: analysis.deletedFiles,
      previous_bytes: analysis.previousBytes,
      deleted_bytes: analysis.deletedBytes,
      reasons: input.reasons ?? analysis.reasons,
      paths: paths.slice(0, 100),
      path_count: paths.length,
      ...(input.observation
        ? { sync: syncEventSummary(input.observation) }
        : {}),
      ...(input.restoreCommit ? { restore_commit: input.restoreCommit } : {}),
    };
  }

  private checkpointRepository(): GitRepository {
    const dataRoot = path.dirname(this.vaultRoot);
    return new GitRepository(
      this.vaultRoot,
      path.join(dataRoot, "vault-checkpoints.git"),
      {
        token: "local-checkpoint",
        repository: "local/checkpoint",
        branch: "main",
        trigger: "manual",
      },
      { remoteUrl: path.join(dataRoot, "vault-checkpoints-remote") },
    );
  }

  private async saveAcceptedCheckpoint(treeOid?: string): Promise<string> {
    const checkpoints = this.checkpointRepository();
    await checkpoints.initialize();
    const oid =
      treeOid ??
      (await checkpoints.snapshotVault(undefined, false, true)).treeOid;
    await checkpoints.readTree(oid);
    await atomicWrite(
      this.acceptedCheckpointPath(),
      Buffer.from(JSON.stringify({ tree: oid }), "utf8"),
    );
    return oid;
  }

  private async loadAcceptedCheckpoint(): Promise<string | null> {
    try {
      const value = JSON.parse(
        await readFile(this.acceptedCheckpointPath(), "utf8"),
      ) as { tree?: unknown };
      return typeof value.tree === "string" &&
        /^[a-f0-9]{40,64}$/u.test(value.tree)
        ? value.tree
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async restoreAcceptedCheckpoint(
    checkpoints: GitRepository,
    current: Awaited<ReturnType<GitRepository["snapshotVault"]>>,
  ): Promise<Awaited<ReturnType<GitRepository["snapshotVault"]>>> {
    const accepted = await this.loadAcceptedCheckpoint();
    if (!accepted || accepted === current.treeOid) return current;
    const acceptedTree = await checkpoints.readTree(accepted);
    const currentLoss = analyzeDeletion(acceptedTree, current.tree);
    if (!currentLoss.destructive) return current;
    const restore = await checkpoints.applyTree(accepted, undefined, false);
    await checkpoints.finalizeTransaction(restore.id);
    return { treeOid: accepted, tree: acceptedTree };
  }

  private async assertMirrorMatchesLive(mirror: MirrorSnapshot): Promise<void> {
    const live = await this.sync.snapshotLiveSyncSubset();
    if (live.digest !== mirror.digest)
      throw new Error(
        "The verified Obsidian mirror does not match the supported live-vault subset",
      );
  }

  private async guardedOneShot(
    phase: Extract<GitSafetyPhase, "live_pull" | "post_apply_sync">,
    plannedRemoteDeletes: ReadonlySet<string> = new Set(),
  ): Promise<SyncRunObservation> {
    const checkpoints = this.checkpointRepository();
    await checkpoints.initialize();
    let safe = await checkpoints.snapshotVault(undefined, false, true);
    const mirror = await this.sync.refreshSafetyMirror();
    const observed = safe;
    safe = await this.restoreAcceptedCheckpoint(checkpoints, observed);
    if (safe.treeOid !== observed.treeOid) {
      const continuousLoss = analyzeDeletion(safe.tree, observed.tree);
      const event = this.makeSafetyEvent(
        phase,
        safe.treeOid,
        observed.treeOid,
        continuousLoss,
        {
          remote: mirror.snapshot,
          reasons: ["continuous_sync_checkpoint_loss"],
        },
      );
      await this.enterQuarantine(event, continuousLoss.deletedPaths);
      throw new SyncSafetyViolation(event);
    }
    const baseline = await this.sync.loadMirrorBaseline();
    let predictedRemoteDeletes = new Set<string>();
    if (baseline) {
      const remoteDeletion = analyzeDeletion(
        mirrorTree(baseline),
        mirrorTree(mirror.snapshot),
      );
      predictedRemoteDeletes = new Set(remoteDeletion.deletedPaths);
      if (remoteDeletion.destructive) {
        safe = await this.restoreAcceptedCheckpoint(checkpoints, safe);
        const event = this.makeSafetyEvent(
          "remote_mirror",
          safe.treeOid,
          mirror.snapshot.digest,
          remoteDeletion,
          { remote: mirror.snapshot },
        );
        await this.enterQuarantine(event, remoteDeletion.deletedPaths);
        throw new SyncSafetyViolation(event);
      }
    }

    await this.sync.activateBidirectional();
    const observation = await this.sync.oneShot();
    const after = await checkpoints.snapshotVault(undefined, false, true);
    const deletion = analyzeDeletion(safe.tree, after.tree);
    const unexpectedLocal = baseline
      ? deletion.deletedPaths.filter(
          (pathName) => !predictedRemoteDeletes.has(pathName),
        )
      : [];
    const unexpectedRemote = observation.deletedRemotePaths.filter(
      (pathName) => !plannedRemoteDeletes.has(pathName),
    );
    if (
      deletion.destructive ||
      unexpectedLocal.length > 0 ||
      unexpectedRemote.length > 0
    ) {
      const restored = await checkpoints.applyTree(
        safe.treeOid,
        undefined,
        false,
      );
      await checkpoints.finalizeTransaction(restored.id);
      const paths = [
        ...new Set([
          ...(unexpectedRemote.length > 0 ? unexpectedRemote : []),
          ...(unexpectedLocal.length > 0 ? unexpectedLocal : []),
          ...deletion.deletedPaths,
        ]),
      ].sort();
      const reasons = [
        ...deletion.reasons,
        ...(unexpectedLocal.length > 0 ? ["remote_delta_mismatch"] : []),
        ...(unexpectedRemote.length > 0 ? ["unexpected_remote_deletion"] : []),
      ];
      const event = this.makeSafetyEvent(
        phase,
        safe.treeOid,
        after.treeOid,
        deletion,
        {
          remote: mirror.snapshot,
          observation,
          reasons: [...new Set(reasons)],
          paths,
        },
      );
      await this.enterQuarantine(event, paths);
      throw new SyncSafetyViolation(event);
    }
    const verified = await this.sync.refreshSafetyMirror();
    await this.assertMirrorMatchesLive(verified.snapshot);
    await this.sync.saveMirrorBaseline(verified.snapshot);
    await this.saveAcceptedCheckpoint(after.treeOid);
    return observation;
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
    pauseSync?: boolean;
  }): Promise<VaultResponse> {
    return this.enqueue(async () => this.configureInsideQueue(input));
  }

  private async configureInsideQueue(input: {
    token: string;
    vault: string;
    vaultPassword?: string;
    pauseSync?: boolean;
  }): Promise<VaultResponse> {
    this.state = "warming";
    this.stateError = null;
    try {
      await this.sync.stopContinuous();
      await this.indexer.stopWatching();
      await this.sync.configure(input);
      if (this.safetyEvent || input.pauseSync) {
        await this.sync.activateBidirectional();
        await this.indexer.rebuild();
        this.indexer.startWatching();
        this.state = "quarantined";
        this.stateError =
          "A destructive synchronization change requires admin review";
        return {
          ok: true,
          data: { vault: input.vault, quarantined: true },
          sync_state: "sync_pending",
        };
      }
      await this.guardedOneShot("live_pull");
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
      if (error instanceof SyncSafetyViolation) {
        await this.indexer.rebuild();
        this.indexer.startWatching();
        return {
          ok: true,
          data: {
            vault: input.vault,
            quarantined: true,
            safety_event: error.event,
          },
          sync_state: "sync_pending",
        };
      }
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
      await rm(
        path.join(path.dirname(this.vaultRoot), "obsidian-safety-mirror"),
        {
          recursive: true,
          force: true,
        },
      );
      await rm(
        path.join(path.dirname(this.vaultRoot), "config-safety-mirror"),
        {
          recursive: true,
          force: true,
        },
      );
      await rm(
        path.join(
          path.dirname(this.vaultRoot),
          "obsidian-safety-mirror-baseline.json",
        ),
        { force: true },
      );
      await rm(
        path.join(path.dirname(this.vaultRoot), "vault-checkpoints.git"),
        { recursive: true, force: true },
      );
      await rm(this.acceptedCheckpointPath(), { force: true });
      await rm(this.safetyMarkerPath(), { force: true });
      await rm(this.safetyManifestPath(), { force: true });
      await mkdir(this.vaultRoot, { recursive: true, mode: 0o700 });
      await this.indexer.rebuild();
      this.sync = new SyncSupervisor(this.vaultRoot, this.deviceName);
      this.state = "unconfigured";
      this.stateError = null;
      this.safetyEvent = null;
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
      git: this.lastGitResult,
      safetyEvent: this.safetyEvent,
      headlessVersion: "0.0.14",
    };
  }

  async reconcileGit(input: GitReconcileInput): Promise<GitReconcileResult> {
    return this.enqueue(async () => {
      const repository = new GitRepository(
        this.vaultRoot,
        path.join(path.dirname(this.vaultRoot), "git"),
        input,
      );
      let remoteHead: string | undefined;
      let indexPaused = false;
      let retries = 0;
      let conflicts: GitReconcileResult["conflicts"] = [];
      let conflictCount = 0;
      let unsupportedWorkflowPaths: string[] = [];
      let unsupportedWorkflowCount = 0;
      let retryStarted = 0;
      let transaction:
        Awaited<ReturnType<GitRepository["applyTree"]>> | undefined;
      let retryContext:
        { previousRemoteHead?: string; localBaseTree: string } | undefined;
      const resultBase = () => ({
        retries,
        conflict_count: conflictCount,
        conflicts,
        unsupported_workflow_count: unsupportedWorkflowCount,
        unsupported_workflow_paths: unsupportedWorkflowPaths,
        lfs: repository.lfsStatus(),
      });
      const blocked = (
        reason: NonNullable<GitReconcileResult["blocked_reason"]>,
        event?: GitSafetyEvent,
      ): GitReconcileResult => ({
        state: "blocked",
        ...(input.base_commit ? { base_commit: input.base_commit } : {}),
        ...(remoteHead ? { remote_head: remoteHead } : {}),
        ...resultBase(),
        blocked_reason: reason,
        ...(event ? { safety_event: event } : {}),
      });
      try {
        const action = input.action ?? "apply";
        const refreshingQuarantine =
          this.state === "quarantined" && action === "preview";
        if (
          refreshingQuarantine &&
          (!input.safety_event ||
            (this.safetyEvent &&
              input.safety_event.event_id !== this.safetyEvent.event_id))
        )
          throw new Error("The destructive-change preview is stale");
        if (
          this.state === "quarantined" &&
          this.safetyEvent &&
          action === "apply" &&
          !input.emergency
        ) {
          const result = blocked("destructive_change", this.safetyEvent);
          this.lastGitResult = result;
          return result;
        }
        if (
          this.state !== "ready" &&
          !(
            this.state === "quarantined" &&
            (action === "approve" ||
              action === "reject" ||
              action === "preview")
          )
        )
          throw new Error(`Vault is ${this.state}`);
        await repository.initialize();
        remoteHead = await repository.fetch();

        if (action === "reject") {
          await this.sync.stopContinuous();
          indexPaused = true;
          await this.indexer.stopWatching();
          const activeEvent = this.safetyEvent ?? input.safety_event;
          if (
            !activeEvent ||
            !input.safety_event ||
            input.safety_event.event_id !== activeEvent.event_id
          )
            throw new Error("The destructive-change approval is stale");
          let live = await repository.snapshotVault(undefined, false, true);
          if (live.treeOid !== activeEvent.safe_tree && !this.safetyEvent) {
            await repository.readTree(activeEvent.safe_tree);
            const restore = await repository.applyTree(
              activeEvent.safe_tree,
              undefined,
              false,
            );
            await repository.finalizeTransaction(restore.id);
            live = await repository.snapshotVault(undefined, false, true);
          }
          if (live.treeOid !== activeEvent.safe_tree)
            throw new Error("The safe vault changed while quarantined");
          if (activeEvent.remote_head !== remoteHead)
            throw new Error("The Git head changed while quarantined");
          const mirror = await this.sync.refreshSafetyMirror();
          if (
            activeEvent.remote_digest &&
            mirror.snapshot.digest !== activeEvent.remote_digest
          )
            throw new Error("Obsidian Sync changed while quarantined");
          if (
            activeEvent.remote_version !== undefined &&
            mirror.snapshot.version !== activeEvent.remote_version
          )
            throw new Error("Obsidian Sync version changed while quarantined");
          await this.sync.reinitializeStateAndRepublish();
          const republished = await repository.snapshotVault(
            undefined,
            false,
            true,
          );
          if (republished.treeOid !== live.treeOid) {
            const restore = await repository.applyTree(
              live.treeOid,
              undefined,
              false,
            );
            await repository.finalizeTransaction(restore.id);
            throw new Error(
              "Republishing changed the preserved vault; quarantine remains active",
            );
          }
          const verified = await this.sync.refreshSafetyMirror();
          await this.assertMirrorMatchesLive(verified.snapshot);
          await this.sync.saveMirrorBaseline(verified.snapshot);
          await this.saveAcceptedCheckpoint();
          await this.leaveQuarantine();
          const result: GitReconcileResult = {
            state: "converged",
            ...(input.base_commit ? { base_commit: input.base_commit } : {}),
            ...(remoteHead ? { remote_head: remoteHead } : {}),
            ...resultBase(),
          };
          this.lastGitResult = result;
          return result;
        }

        await this.sync.stopContinuous();
        indexPaused = true;
        await this.indexer.stopWatching();

        if (action === "approve") {
          const event = input.safety_event;
          if (!event)
            throw new Error("A safety event is required for approval");
          if (this.safetyEvent && event.event_id !== this.safetyEvent.event_id)
            throw new Error("The destructive-change approval is stale");
          let live = await repository.snapshotVault(undefined, false, true);
          if (live.treeOid !== event.safe_tree && !this.safetyEvent) {
            await repository.readTree(event.safe_tree);
            const restore = await repository.applyTree(
              event.safe_tree,
              undefined,
              false,
            );
            await repository.finalizeTransaction(restore.id);
            live = await repository.snapshotVault(undefined, false, true);
          }
          if (live.treeOid !== event.safe_tree)
            throw new Error("The safe vault changed before approval");
          if (event.remote_head !== remoteHead)
            throw new Error("The Git head changed before approval");
          const mirror = await this.sync.refreshSafetyMirror();
          if (
            event.remote_digest &&
            mirror.snapshot.digest !== event.remote_digest
          )
            throw new Error("Obsidian Sync changed before approval");
          if (
            event.remote_version !== undefined &&
            mirror.snapshot.version !== event.remote_version
          )
            throw new Error("Obsidian Sync version changed before approval");
          let candidateTree = event.candidate_tree;
          let approvedPaths = new Set(event.paths);
          if (this.safetyEvent)
            approvedPaths = new Set(await this.safetyManifest(event.event_id));
          if (event.phase === "remote_mirror") {
            await this.sync.activateMirrorRemote();
            let observation: SyncRunObservation;
            try {
              observation = await this.sync.oneShot();
            } finally {
              await this.sync.activateBidirectional();
            }
            const afterPull = await repository.snapshotVault(
              undefined,
              false,
              true,
            );
            const pullDeletion = analyzeDeletion(live.tree, afterPull.tree);
            const unapproved = pullDeletion.deletedPaths.filter(
              (pathName) => !approvedPaths.has(pathName),
            );
            if (unapproved.length > 0) {
              const restore = await repository.applyTree(
                live.treeOid,
                undefined,
                false,
              );
              await repository.finalizeTransaction(restore.id);
              throw new Error("The approved remote deletion set changed");
            }
            const approvedRemote = await this.sync.snapshotLiveSyncSubset();
            if (approvedRemote.digest !== event.candidate_tree) {
              const restore = await repository.applyTree(
                live.treeOid,
                undefined,
                false,
              );
              await repository.finalizeTransaction(restore.id);
              throw new Error("The approved Obsidian candidate changed");
            }
            const merged =
              input.base_commit && remoteHead
                ? await repository.mergedTree(input.base_commit, remoteHead)
                : await repository.initialUnion(remoteHead);
            candidateTree = merged.treeOid;
            conflicts = merged.conflicts;
            conflictCount = merged.conflictCount;
            unsupportedWorkflowCount = merged.unsupportedWorkflowCount;
            unsupportedWorkflowPaths = merged.unsupportedWorkflowPaths;
            void observation;
          } else {
            await repository.readTree(candidateTree);
          }
          transaction = await repository.applyTree(candidateTree, remoteHead);
          const observation = await this.sync.oneShot();
          const planned = new Set(transaction.deletion.deletedPaths);
          const unexpectedRemote = observation.deletedRemotePaths.filter(
            (pathName) => !planned.has(pathName),
          );
          const afterSync = await repository.snapshotVault(
            undefined,
            false,
            true,
          );
          const postDeletion = analyzeDeletion(
            await repository.readTree(transaction.appliedTree),
            afterSync.tree,
          );
          if (unexpectedRemote.length > 0 || postDeletion.destructive) {
            await repository.rollbackTransaction(transaction.id);
            transaction = undefined;
            const safety = this.makeSafetyEvent(
              "post_apply_sync",
              live.treeOid,
              afterSync.treeOid,
              postDeletion,
              {
                remoteHead,
                remote: mirror.snapshot,
                observation,
                reasons:
                  unexpectedRemote.length > 0
                    ? ["unexpected_remote_deletion"]
                    : postDeletion.reasons,
                paths:
                  unexpectedRemote.length > 0
                    ? unexpectedRemote
                    : postDeletion.deletedPaths,
              },
            );
            await this.enterQuarantine(
              safety,
              unexpectedRemote.length > 0
                ? unexpectedRemote
                : postDeletion.deletedPaths,
            );
            const result = blocked("destructive_change", safety);
            this.lastGitResult = result;
            return result;
          }
          const pushed = await repository.commitAndPush(
            remoteHead,
            afterSync.treeOid,
            conflictCount,
          );
          const verifiedMirror = await this.sync.refreshSafetyMirror();
          await this.assertMirrorMatchesLive(verifiedMirror.snapshot);
          await this.sync.saveMirrorBaseline(verifiedMirror.snapshot);
          await this.saveAcceptedCheckpoint();
          const transactionId = transaction.id;
          await repository.markTransactionCommitted(transactionId);
          transaction = undefined;
          const result: GitReconcileResult = {
            state: "converged",
            base_commit: pushed.commit,
            remote_head: pushed.commit,
            transaction_id: transactionId,
            safety_event: event,
            ...resultBase(),
          };
          this.lastGitResult = result;
          return result;
        }

        const safeSnapshot = await repository.snapshotVault(
          undefined,
          false,
          true,
        );
        const mirror = await this.sync.refreshSafetyMirror();
        const mirrorBaseline = await this.sync.loadMirrorBaseline();
        if (mirrorBaseline) {
          const remoteDeletion = analyzeDeletion(
            mirrorTree(mirrorBaseline),
            mirrorTree(mirror.snapshot),
          );
          if (remoteDeletion.destructive) {
            const checkpoints = this.checkpointRepository();
            await checkpoints.initialize();
            const current = await checkpoints.snapshotVault(
              undefined,
              false,
              true,
            );
            const restored = await this.restoreAcceptedCheckpoint(
              checkpoints,
              current,
            );
            const acceptedSafe =
              restored.treeOid === current.treeOid
                ? safeSnapshot
                : await repository.snapshotVault(undefined, false, true);
            let quarantineSafe = acceptedSafe;
            if (input.base_commit) {
              if (!(await repository.ensureCommit(input.base_commit)))
                throw new Error("The previous Git base is unavailable");
              const safeUnion = await repository.initialUnion(
                input.base_commit,
              );
              const restore = await repository.applyTree(
                safeUnion.treeOid,
                remoteHead,
              );
              await repository.finalizeTransaction(restore.id);
              quarantineSafe = await repository.snapshotVault(
                undefined,
                false,
                true,
              );
              await this.saveAcceptedCheckpoint();
            }
            const safety = this.makeSafetyEvent(
              "remote_mirror",
              quarantineSafe.treeOid,
              mirror.snapshot.digest,
              remoteDeletion,
              { remoteHead, remote: mirror.snapshot },
            );
            await this.enterQuarantine(safety, remoteDeletion.deletedPaths);
            const result = blocked("destructive_change", safety);
            this.lastGitResult = result;
            return result;
          }
        }

        const pullObservation = input.sync_barrier_complete
          ? undefined
          : refreshingQuarantine
            ? undefined
            : await this.sync.oneShot();
        if (pullObservation) await this.indexer.flush();
        const obsidianSnapshot = await repository.snapshotVault(
          undefined,
          false,
          true,
        );
        const liveDeletion = analyzeDeletion(
          safeSnapshot.tree,
          obsidianSnapshot.tree,
        );
        if (liveDeletion.destructive) {
          const restore = await repository.applyTree(
            safeSnapshot.treeOid,
            remoteHead,
          );
          await repository.finalizeTransaction(restore.id);
          const safety = this.makeSafetyEvent(
            "live_pull",
            safeSnapshot.treeOid,
            obsidianSnapshot.treeOid,
            liveDeletion,
            {
              remoteHead,
              remote: mirror.snapshot,
              observation: pullObservation,
            },
          );
          await this.enterQuarantine(safety, liveDeletion.deletedPaths);
          const result = blocked("destructive_change", safety);
          this.lastGitResult = result;
          return result;
        }

        remoteHead = await repository.fetch();
        retryStarted = Date.now();
        while (true) {
          retries += 1;
          let baseCommit = input.base_commit;
          let reconnectBase: string | undefined;
          if (input.resolution === "adopt_remote") baseCommit = undefined;
          if (baseCommit) {
            if (!remoteHead) {
              const blocked: GitReconcileResult = {
                state: "blocked",
                retries,
                conflict_count: 0,
                conflicts: [],
                unsupported_workflow_count: unsupportedWorkflowCount,
                unsupported_workflow_paths: unsupportedWorkflowPaths,
                blocked_reason: "branch_deleted",
                lfs: repository.lfsStatus(),
              };
              this.lastGitResult = blocked;
              return blocked;
            }
            const baseAvailable = await repository.ensureCommit(baseCommit);
            const ancestor =
              baseAvailable &&
              (await repository.isAncestor(baseCommit, remoteHead));
            if (!ancestor && input.resolution !== "reconnect_base") {
              const blocked: GitReconcileResult = {
                state: "blocked",
                remote_head: remoteHead,
                retries,
                conflict_count: 0,
                conflicts: [],
                unsupported_workflow_count: unsupportedWorkflowCount,
                unsupported_workflow_paths: unsupportedWorkflowPaths,
                blocked_reason: "history_rewritten",
                lfs: repository.lfsStatus(),
              };
              this.lastGitResult = blocked;
              return blocked;
            }
            if (!ancestor && input.resolution === "reconnect_base") {
              if (!baseAvailable)
                throw new Error(
                  "The previous base commit is no longer available",
                );
              reconnectBase = baseCommit;
            }
          }
          if (input.restore_commit) {
            if (!remoteHead)
              throw new Error(
                "Historical recovery requires an existing branch",
              );
            if (!(await repository.ensureCommit(input.restore_commit)))
              throw new Error("The recovery commit is not available");
            if (
              !(await repository.isAncestor(input.restore_commit, remoteHead))
            )
              throw new Error(
                "The recovery commit is not an ancestor of the current branch",
              );
          }
          const merged = input.restore_commit
            ? remoteHead
              ? await repository.restoreUnion(input.restore_commit, remoteHead)
              : (() => {
                  throw new Error(
                    "Historical recovery requires an existing branch",
                  );
                })()
            : retryContext && remoteHead
              ? await repository.retryMergedTree(
                  retryContext.previousRemoteHead,
                  remoteHead,
                  retryContext.localBaseTree,
                )
              : baseCommit && remoteHead
                ? await repository.mergedTree(baseCommit, remoteHead)
                : await repository.initialUnion(remoteHead);
          conflictCount += merged.conflictCount;
          for (const conflict of merged.conflicts) {
            if (conflicts.length >= 100) break;
            if (
              !conflicts.some((candidate) => candidate.path === conflict.path)
            )
              conflicts.push(conflict);
          }
          unsupportedWorkflowCount = merged.unsupportedWorkflowCount;
          unsupportedWorkflowPaths = merged.unsupportedWorkflowPaths;

          const candidate = await repository.readTree(merged.treeOid);
          const deletionReference = baseCommit
            ? await repository.readTree(baseCommit)
            : obsidianSnapshot.tree;
          const candidateDeletion = analyzeDeletion(
            deletionReference,
            candidate,
          );
          if (input.action === "preview" || input.restore_commit) {
            let previewSafeTree = obsidianSnapshot.treeOid;
            if (
              refreshingQuarantine &&
              candidateDeletion.destructive &&
              baseCommit
            ) {
              const safeUnion = await repository.initialUnion(baseCommit);
              const restore = await repository.applyTree(
                safeUnion.treeOid,
                remoteHead,
              );
              previewSafeTree = restore.appliedTree;
              await repository.finalizeTransaction(restore.id);
              await this.saveAcceptedCheckpoint();
            }
            const safety = this.makeSafetyEvent(
              input.restore_commit ? "restore" : "preflight",
              previewSafeTree,
              merged.treeOid,
              candidateDeletion,
              {
                remoteHead,
                remote: mirror.snapshot,
                restoreCommit: input.restore_commit,
                reasons: ["preflight_confirmation"],
              },
            );
            if (refreshingQuarantine)
              await this.enterQuarantine(
                safety,
                candidateDeletion.deletedPaths,
              );
            const result = blocked(
              refreshingQuarantine
                ? "destructive_change"
                : "preflight_required",
              safety,
            );
            this.lastGitResult = result;
            return result;
          }
          if (candidateDeletion.destructive) {
            let safeTree = obsidianSnapshot.treeOid;
            if (baseCommit) {
              const safeUnion = await repository.initialUnion(baseCommit);
              const restore = await repository.applyTree(
                safeUnion.treeOid,
                remoteHead,
              );
              safeTree = restore.appliedTree;
              await repository.finalizeTransaction(restore.id);
              await this.saveAcceptedCheckpoint();
            }
            const safety = this.makeSafetyEvent(
              "preflight",
              safeTree,
              merged.treeOid,
              candidateDeletion,
              { remoteHead, remote: mirror.snapshot },
            );
            await this.enterQuarantine(safety, candidateDeletion.deletedPaths);
            const result = blocked("destructive_change", safety);
            this.lastGitResult = result;
            return result;
          }

          await this.assertDiskHeadroom(true);
          transaction = await repository.applyTree(merged.treeOid, remoteHead);
          const pushObservation = await this.sync.oneShot();
          const finalSnapshot = await repository.snapshotVault(
            undefined,
            false,
            true,
          );
          const postDeletion = analyzeDeletion(
            await repository.readTree(transaction.appliedTree),
            finalSnapshot.tree,
          );
          const plannedDeletes = new Set(transaction.deletion.deletedPaths);
          const unexpectedRemote = pushObservation.deletedRemotePaths.filter(
            (pathName) => !plannedDeletes.has(pathName),
          );
          if (unexpectedRemote.length > 0 || postDeletion.destructive) {
            await repository.rollbackTransaction(transaction.id);
            transaction = undefined;
            const paths =
              unexpectedRemote.length > 0
                ? unexpectedRemote
                : postDeletion.deletedPaths;
            const safety = this.makeSafetyEvent(
              "post_apply_sync",
              obsidianSnapshot.treeOid,
              finalSnapshot.treeOid,
              postDeletion,
              {
                remoteHead,
                remote: mirror.snapshot,
                observation: pushObservation,
                reasons:
                  unexpectedRemote.length > 0
                    ? ["unexpected_remote_deletion"]
                    : postDeletion.reasons,
                paths,
              },
            );
            await this.enterQuarantine(safety, paths);
            const result = blocked("destructive_change", safety);
            this.lastGitResult = result;
            return result;
          }
          try {
            const pushed = await repository.commitAndPush(
              remoteHead,
              finalSnapshot.treeOid,
              conflictCount,
              reconnectBase,
            );
            const verifiedMirror = await this.sync.refreshSafetyMirror();
            await this.assertMirrorMatchesLive(verifiedMirror.snapshot);
            await this.sync.saveMirrorBaseline(verifiedMirror.snapshot);
            await this.saveAcceptedCheckpoint();
            if (!transaction)
              throw new Error("The reconciliation transaction was lost");
            const transactionId = transaction.id;
            await repository.markTransactionCommitted(transactionId);
            transaction = undefined;
            const result: GitReconcileResult = {
              state: "converged",
              base_commit: pushed.commit,
              remote_head: pushed.commit,
              transaction_id: transactionId,
              ...resultBase(),
            };
            this.lastGitResult = result;
            return result;
          } catch (error) {
            if (!repository.isNonFastForward(error)) throw error;
            if (retries >= 3 || Date.now() - retryStarted >= 30_000) {
              try {
                remoteHead = await repository.fetch();
              } catch {
                // Preserve the push rejection as the actionable failure.
              }
              throw error;
            }
            retryContext = remoteHead
              ? {
                  previousRemoteHead: remoteHead,
                  localBaseTree: finalSnapshot.treeOid,
                }
              : undefined;
            if (!transaction)
              throw new Error("The reconciliation transaction was lost");
            await repository.finalizeTransaction(transaction.id);
            transaction = undefined;
            remoteHead = await repository.fetch();
            if (!remoteHead) throw new Error("The Git branch was deleted");
            await this.sync.oneShot();
            await this.indexer.flush();
          }
        }
      } catch (error) {
        if (transaction) {
          try {
            await repository.rollbackTransaction(transaction.id);
          } catch {
            // Startup recovery will retry the rollback from the journal.
          }
        }
        let backupCommit: string | undefined;
        if (input.emergency && (input.action ?? "apply") === "apply") {
          try {
            await repository.initialize();
            remoteHead = await repository.fetch();
            const emergencyTree = await repository.snapshotVault(
              remoteHead,
              true,
              false,
            );
            const backup = await repository.commitAndPush(
              remoteHead,
              emergencyTree.treeOid,
              0,
            );
            backupCommit = backup.commit;
            remoteHead = backup.commit;
          } catch {
            // Preserve the original synchronization/reconciliation error.
          }
        }
        const pending: GitReconcileResult = {
          state: this.safetyEvent ? "blocked" : "pending",
          ...(input.base_commit ? { base_commit: input.base_commit } : {}),
          ...(remoteHead ? { remote_head: remoteHead } : {}),
          ...(backupCommit ? { backup_commit: backupCommit } : {}),
          ...(this.safetyEvent
            ? {
                blocked_reason: "destructive_change" as const,
                safety_event: this.safetyEvent,
              }
            : {}),
          retries,
          conflict_count: conflictCount,
          conflicts,
          unsupported_workflow_count: unsupportedWorkflowCount,
          unsupported_workflow_paths: unsupportedWorkflowPaths,
          error:
            error instanceof Error
              ? error.message
              : "Git reconciliation failed",
          lfs: repository.lfsStatus(),
        };
        this.lastGitResult = pending;
        return pending;
      } finally {
        if (indexPaused) {
          try {
            await this.indexer.rebuild();
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "git_reconcile_index_error",
                error: error instanceof Error ? error.message : "unknown",
              }),
            );
          }
        }
        this.indexer.startWatching();
        if (this.state === "ready" && !this.safetyEvent)
          this.sync.startContinuous();
      }
    });
  }

  async resetGit(): Promise<GitReconcileResult> {
    return this.enqueue(async () => {
      await recoverVaultSwap(this.vaultRoot);
      await rm(path.join(path.dirname(this.vaultRoot), "git"), {
        recursive: true,
        force: true,
      });
      this.lastGitResult = null;
      return {
        state: "pending",
        retries: 0,
        conflict_count: 0,
        conflicts: [],
        unsupported_workflow_count: 0,
        unsupported_workflow_paths: [],
        lfs: { available: true, healthy: true },
      };
    });
  }

  async scheduledSafetyCheck(): Promise<{
    state: "ready" | "quarantined" | "not_ready";
    safety_event?: GitSafetyEvent;
  }> {
    return this.enqueue(async () => {
      if (this.state !== "ready")
        return {
          state: this.state === "quarantined" ? "quarantined" : "not_ready",
          ...(this.safetyEvent ? { safety_event: this.safetyEvent } : {}),
        };
      await this.sync.stopContinuous();
      await this.indexer.stopWatching();
      try {
        await this.guardedOneShot("live_pull");
        await this.indexer.rebuild();
        return { state: "ready" };
      } catch (error) {
        if (!(error instanceof SyncSafetyViolation)) throw error;
        await this.indexer.rebuild();
        return { state: "quarantined", safety_event: error.event };
      } finally {
        this.indexer.startWatching();
        if (this.state === "ready" && !this.safetyEvent)
          this.sync.startContinuous();
      }
    });
  }

  async finalizeGitTransaction(transactionId: string): Promise<{
    finalized: true;
  }> {
    return this.enqueue(async () => {
      await this.checkpointRepository().finalizeTransaction(transactionId);
      if (this.safetyEvent) {
        await this.leaveQuarantine();
        this.sync.startContinuous();
      }
      return { finalized: true };
    });
  }

  async gitSafetyManifest(eventId: string): Promise<{
    event_id: string;
    paths: string[];
  }> {
    return this.enqueue(async () => {
      if (!this.safetyEvent || this.safetyEvent.event_id !== eventId)
        throw new Error("The Git safety event is stale");
      return { event_id: eventId, paths: await this.safetyManifest(eventId) };
    });
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
        if (this.state !== "ready" && this.state !== "quarantined")
          throw new VaultOperationError(
            "not_ready",
            `Vault is ${this.state}`,
            this.stateError ? { error: this.stateError } : undefined,
          );
        if (isMutation(operation)) {
          if (this.state === "quarantined")
            throw new VaultOperationError(
              "not_ready",
              "Vault mutations are disabled while destructive synchronization changes await admin review",
              this.safetyEvent
                ? { safety_event_id: this.safetyEvent.event_id }
                : undefined,
            );
          return await this.mutate(operation);
        }
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
        await this.guardedOneShot("live_pull");
        await this.indexer.flush();
      } catch (error) {
        if (error instanceof SyncSafetyViolation)
          throw new VaultOperationError("not_ready", error.message, {
            safety_event_id: error.event.event_id,
          });
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
        const plannedRemoteDeletes = new Set<string>();
        if (operation.kind === "delete_file")
          plannedRemoteDeletes.add(normalizeVaultPath(operation.path));
        if (operation.kind === "move_file")
          plannedRemoteDeletes.add(normalizeVaultPath(operation.source));
        await this.guardedOneShot("post_apply_sync", plannedRemoteDeletes);
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
              ...(error instanceof SyncSafetyViolation
                ? { safety_event_id: error.event.event_id }
                : {}),
            },
          },
          data: localResult,
          sync_state: "sync_pending",
        };
      }
    } finally {
      if (this.state === "ready" && !this.safetyEvent)
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

  private async assertDiskHeadroom(staging = false): Promise<void> {
    const filesystem = await statfs(path.dirname(this.vaultRoot));
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    let vaultBytes = 0;
    const accumulate = async (target: string): Promise<void> => {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink())
        throw new VaultOperationError(
          "invalid_path",
          "Symbolic links are not supported in the vault",
        );
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
    const required = Math.max(
      staging ? 512 * 1024 * 1024 : 256 * 1024 * 1024,
      Math.ceil(vaultBytes * (staging ? 1.2 : 0.2)),
    );
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
