import { z } from "zod";

const requestId = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(1024);
const cursor = z.string().max(1024).optional();
const limit = z.number().int().min(1).max(50).optional();
const patch = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace"),
    old_text: z.string().min(1),
    new_text: z.string(),
    expected_occurrences: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal("insert_before"),
    anchor: z.string().min(1),
    text: z.string(),
    expected_occurrences: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal("insert_after"),
    anchor: z.string().min(1),
    text: z.string(),
    expected_occurrences: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal("prepend"), text: z.string() }),
  z.object({ type: z.literal("append"), text: z.string() }),
]);

export const vaultOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vault_status") }),
  z.object({
    kind: z.literal("list_files"),
    prefix: z.string().optional(),
    file_kind: z.enum(["note", "attachment"]).optional(),
    extension: z.string().optional(),
    mime_type: z.string().optional(),
    cursor,
    limit,
  }),
  z.object({
    kind: z.literal("read_note"),
    path,
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  z.object({
    kind: z.literal("search_notes"),
    query: z.string().min(1).max(1000),
    match: z.enum(["all", "phrase"]).optional(),
    prefix: z.string().optional(),
    tags: z.array(z.string()).max(20).optional(),
    properties: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    cursor,
    limit,
  }),
  z.object({ kind: z.literal("get_links"), path }),
  z.object({ kind: z.literal("get_attachment"), path }),
  z.object({
    kind: z.literal("create_note"),
    request_id: requestId,
    path,
    content: z.string(),
  }),
  z.object({
    kind: z.literal("patch_note"),
    request_id: requestId,
    path,
    expected_revision: revision,
    patches: z.array(patch).min(1).max(100),
  }),
  z.object({
    kind: z.literal("put_attachment"),
    request_id: requestId,
    path,
    mime_type: z.string().min(1).max(255),
    content_base64: z.string(),
    expected_revision: revision.optional(),
  }),
  z.object({
    kind: z.literal("move_file"),
    request_id: requestId,
    source: path,
    destination: path,
    expected_revision: revision,
  }),
  z.object({
    kind: z.literal("delete_file"),
    request_id: requestId,
    path,
    expected_revision: revision,
  }),
]);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(4096),
  mfa: z.string().min(1).max(64).optional(),
});
export const configureSchema = z.object({
  token: z.string().min(1).max(8192),
  vault: z.string().min(1).max(1024),
  vaultPassword: z.string().max(4096).optional(),
  pauseSync: z.boolean().optional(),
});

export const gitReconcileSchema = z.object({
  token: z.string().min(1).max(8192),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  branch: z.string().min(1).max(255),
  base_commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/u)
    .optional(),
  trigger: z.enum(["startup", "scheduled", "mutation", "manual"]),
  request_id: z.string().uuid().optional(),
  emergency: z.boolean().optional(),
  resolution: z.enum(["adopt_remote", "reconnect_base"]).optional(),
  action: z.enum(["apply", "preview", "approve", "reject"]).optional(),
  safety_event: z
    .object({
      event_id: z.string().uuid(),
      phase: z.enum([
        "preflight",
        "remote_mirror",
        "live_pull",
        "post_apply_sync",
        "restore",
      ]),
      created_at: z.string(),
      safe_tree: z.string().regex(/^[a-f0-9]{40,64}$/u),
      candidate_tree: z.string().regex(/^[a-f0-9]{40,64}$/u),
      remote_head: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/u)
        .optional(),
      remote_version: z.number().int().nonnegative().optional(),
      remote_digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      previous_files: z.number().int().nonnegative(),
      candidate_files: z.number().int().nonnegative(),
      deleted_files: z.number().int().nonnegative(),
      previous_bytes: z.number().int().nonnegative(),
      deleted_bytes: z.number().int().nonnegative(),
      reasons: z.array(z.string().max(100)).max(10),
      paths: z.array(path).max(100),
      path_count: z.number().int().nonnegative(),
      sync: z
        .object({
          downloaded: z.number().int().nonnegative(),
          restored: z.number().int().nonnegative(),
          removed_local: z.number().int().nonnegative(),
          deleted_remote: z.number().int().nonnegative(),
          deleted_local: z.number().int().nonnegative(),
        })
        .optional(),
      restore_commit: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/u)
        .optional(),
    })
    .optional(),
  restore_commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/u)
    .optional(),
  sync_barrier_complete: z.boolean().optional(),
});

export const gitSafetyManifestSchema = z.object({
  event_id: z.string().uuid(),
});

export const gitFinalizeSchema = z.object({
  transaction_id: z.string().uuid(),
});
