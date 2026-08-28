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
});
