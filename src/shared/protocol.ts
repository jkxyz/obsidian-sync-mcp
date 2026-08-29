export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export type FileKind = "note" | "attachment";
export type SyncState = "synced_remote" | "sync_pending" | "not_applicable";
export type GitState =
  "converged" | "pending" | "not_configured" | "not_applicable";

export type GitConflict = {
  path: string;
  base_oid: string | null;
  git_oid: string | null;
  obsidian_oid: string | null;
  resolution: "obsidian";
};

export type GitSafetyPhase =
  "preflight" | "remote_mirror" | "live_pull" | "post_apply_sync" | "restore";

export type GitSafetyEvent = {
  event_id: string;
  phase: GitSafetyPhase;
  created_at: string;
  safe_tree: string;
  candidate_tree: string;
  remote_head?: string;
  remote_version?: number;
  remote_digest?: string;
  previous_files: number;
  candidate_files: number;
  deleted_files: number;
  previous_bytes: number;
  deleted_bytes: number;
  reasons: string[];
  paths: string[];
  path_count: number;
  sync?: {
    downloaded: number;
    restored: number;
    removed_local: number;
    deleted_remote: number;
    deleted_local: number;
  };
  restore_commit?: string;
};

export type GitReconcileResult = {
  state: "converged" | "pending" | "blocked";
  base_commit?: string;
  remote_head?: string;
  backup_commit?: string;
  transaction_id?: string;
  retries: number;
  conflict_count: number;
  conflicts: GitConflict[];
  unsupported_workflow_count: number;
  unsupported_workflow_paths: string[];
  attempted_at?: string;
  succeeded_at?: string;
  blocked_reason?:
    | "history_rewritten"
    | "branch_deleted"
    | "destructive_change"
    | "preflight_required";
  safety_event?: GitSafetyEvent;
  error?: string;
  lfs: { available: boolean; healthy: boolean; error?: string };
};

export type VaultErrorCode =
  | "already_exists"
  | "internal_error"
  | "invalid_input"
  | "invalid_path"
  | "not_configured"
  | "not_found"
  | "not_ready"
  | "patch_conflict"
  | "revision_conflict"
  | "sync_pending"
  | "too_large";

export type VaultError = {
  code: VaultErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type VaultResponse<T = unknown> =
  | { ok: true; data: T; sync_state?: SyncState; git_state?: GitState }
  | {
      ok: false;
      error: VaultError;
      data?: T;
      sync_state?: SyncState;
      git_state?: GitState;
    };

export type PatchOperation =
  | {
      type: "replace";
      old_text: string;
      new_text: string;
      expected_occurrences?: number;
    }
  | {
      type: "insert_before";
      anchor: string;
      text: string;
      expected_occurrences?: number;
    }
  | {
      type: "insert_after";
      anchor: string;
      text: string;
      expected_occurrences?: number;
    }
  | { type: "prepend"; text: string }
  | { type: "append"; text: string };

type MutationBase = { request_id: string };

export type VaultOperation =
  | { kind: "vault_status" }
  | {
      kind: "list_files";
      prefix?: string;
      file_kind?: FileKind;
      extension?: string;
      mime_type?: string;
      cursor?: string;
      limit?: number;
    }
  | { kind: "read_note"; path: string; start_line?: number; end_line?: number }
  | {
      kind: "search_notes";
      query: string;
      match?: "all" | "phrase";
      prefix?: string;
      tags?: string[];
      properties?: Record<string, string | number | boolean>;
      cursor?: string;
      limit?: number;
    }
  | { kind: "get_links"; path: string }
  | { kind: "get_attachment"; path: string }
  | (MutationBase & { kind: "create_note"; path: string; content: string })
  | (MutationBase & {
      kind: "patch_note";
      path: string;
      expected_revision: string;
      patches: PatchOperation[];
    })
  | (MutationBase & {
      kind: "put_attachment";
      path: string;
      mime_type: string;
      content_base64: string;
      expected_revision?: string;
    })
  | (MutationBase & {
      kind: "move_file";
      source: string;
      destination: string;
      expected_revision: string;
    })
  | (MutationBase & {
      kind: "delete_file";
      path: string;
      expected_revision: string;
    });

export const MUTATION_KINDS = new Set<VaultOperation["kind"]>([
  "create_note",
  "patch_note",
  "put_attachment",
  "move_file",
  "delete_file",
]);

export function isMutation(
  operation: VaultOperation,
): operation is Extract<VaultOperation, MutationBase> {
  return MUTATION_KINDS.has(operation.kind);
}
