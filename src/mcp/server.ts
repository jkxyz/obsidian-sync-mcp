import { McpServer } from "@modelcontextprotocol/server";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type VaultOperation,
  type VaultResponse,
} from "../shared/protocol.js";

const requestId = z
  .string()
  .uuid()
  .describe("A UUID used to make retries idempotent.");
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .describe("The exact SHA-256 revision returned by a prior read.");
const path = z
  .string()
  .min(1)
  .max(1024)
  .describe("NFC-normalized, vault-relative POSIX path.");
const pageLimit = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

type TokenScopeReader = {
  unwrapToken(token: string): Promise<{ scope: string[] } | null>;
};

export async function effectiveScopesForRequest(
  request: Request,
  oauth: TokenScopeReader,
): Promise<string[]> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return [];
  const accessToken = authorization.slice("Bearer ".length);
  if (!accessToken) return [];
  const token = await oauth.unwrapToken(accessToken);
  return token ? [...token.scope] : [];
}

const patch = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace"),
    old_text: z.string().min(1),
    new_text: z.string(),
    expected_occurrences: z.number().int().min(1).default(1),
  }),
  z.object({
    type: z.literal("insert_before"),
    anchor: z.string().min(1),
    text: z.string(),
    expected_occurrences: z.number().int().min(1).default(1),
  }),
  z.object({
    type: z.literal("insert_after"),
    anchor: z.string().min(1),
    text: z.string(),
    expected_occurrences: z.number().int().min(1).default(1),
  }),
  z.object({ type: z.literal("prepend"), text: z.string() }),
  z.object({ type: z.literal("append"), text: z.string() }),
]);

function textResult(response: VaultResponse) {
  return {
    isError: !response.ok,
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

function createServer(env: AppEnv, scopes: string[]): McpServer {
  const server = new McpServer({ name: "Obsidian Sync MCP", version: "0.1.0" });
  const stub = env.VAULT_CONTAINER.getByName("primary-vault");

  const invoke = async (
    scope: "vault.read" | "vault.write",
    operation: VaultOperation,
  ) => {
    if (!scopes.includes(scope)) {
      return textResult({
        ok: false,
        error: {
          code: "invalid_input",
          message: `OAuth scope ${scope} is required`,
        },
      });
    }
    return textResult((await stub.invoke(operation)) as VaultResponse);
  };

  server.registerTool(
    "vault_status",
    {
      description:
        "Return vault readiness, synchronization health, queue state, disk use, and indexed file counts.",
      inputSchema: z.object({}),
    },
    async () => invoke("vault.read", { kind: "vault_status" }),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List notes or attachments with revisions using efficient cursor pagination.",
      inputSchema: z.object({
        prefix: z.string().optional(),
        file_kind: z.enum(["note", "attachment"]).optional(),
        extension: z.string().optional(),
        mime_type: z.string().optional(),
        cursor: z.string().optional(),
        limit: pageLimit,
      }),
    },
    async (input) => invoke("vault.read", { kind: "list_files", ...input }),
  );

  server.registerTool(
    "read_note",
    {
      description:
        "Read exact Markdown and its revision, optionally limited to an inclusive line range.",
      inputSchema: z.object({
        path,
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
    },
    async (input) => invoke("vault.read", { kind: "read_note", ...input }),
  );

  server.registerTool(
    "search_notes",
    {
      description:
        "Run ranked lexical search over note text, paths, headings, frontmatter, and tags.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        match: z.enum(["all", "phrase"]).default("all"),
        prefix: z.string().optional(),
        tags: z.array(z.string().min(1)).max(20).optional(),
        properties: z.record(z.string(), scalar).optional(),
        cursor: z.string().optional(),
        limit: pageLimit,
      }),
    },
    async (input) => invoke("vault.read", { kind: "search_notes", ...input }),
  );

  server.registerTool(
    "get_links",
    {
      description:
        "Return a note's outgoing links, backlinks, and unresolved wikilinks.",
      inputSchema: z.object({ path }),
    },
    async (input) => invoke("vault.read", { kind: "get_links", ...input }),
  );

  server.registerTool(
    "get_attachment",
    {
      description:
        "Read an attachment up to 5 MiB as an MCP embedded resource.",
      inputSchema: z.object({ path }),
    },
    async (input) => {
      if (!scopes.includes("vault.read"))
        return textResult({
          ok: false,
          error: {
            code: "invalid_input",
            message: "OAuth scope vault.read is required",
          },
        });
      const response = (await stub.invoke({
        kind: "get_attachment",
        ...input,
      })) as VaultResponse;
      if (!response.ok) return textResult(response);
      const data = response.data as {
        path: string;
        mime_type: string;
        content_base64: string;
        revision: string;
        size: number;
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              path: data.path,
              mime_type: data.mime_type,
              revision: data.revision,
              size: data.size,
            }),
          },
          {
            type: "resource" as const,
            resource: {
              uri: `obsidian://vault/${encodeURIComponent(data.path)}`,
              mimeType: data.mime_type,
              blob: data.content_base64,
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_note",
    {
      description:
        "Create a new Markdown note, failing rather than overwriting an existing path.",
      inputSchema: z.object({
        request_id: requestId,
        path,
        content: z.string(),
      }),
    },
    async (input) => invoke("vault.write", { kind: "create_note", ...input }),
  );

  server.registerTool(
    "patch_note",
    {
      description:
        "Atomically apply exact text patches guarded by the note's current revision.",
      inputSchema: z.object({
        request_id: requestId,
        path,
        expected_revision: revision,
        patches: z.array(patch).min(1).max(100),
      }),
    },
    async (input) => invoke("vault.write", { kind: "patch_note", ...input }),
  );

  server.registerTool(
    "put_attachment",
    {
      description:
        "Create or revision-guardedly replace an attachment from base64, up to 5 MiB decoded.",
      inputSchema: z.object({
        request_id: requestId,
        path,
        mime_type: z.string().min(1).max(255),
        content_base64: z.string(),
        expected_revision: revision.optional(),
      }),
    },
    async (input) =>
      invoke("vault.write", { kind: "put_attachment", ...input }),
  );

  server.registerTool(
    "move_file",
    {
      description:
        "Move a note or attachment without overwriting. Note links are not rewritten; affected backlinks are returned.",
      inputSchema: z.object({
        request_id: requestId,
        source: path,
        destination: path,
        expected_revision: revision,
      }),
    },
    async (input) => invoke("vault.write", { kind: "move_file", ...input }),
  );

  server.registerTool(
    "delete_file",
    {
      description:
        "Hard-delete a note or attachment guarded by its exact current revision.",
      inputSchema: z.object({
        request_id: requestId,
        path,
        expected_revision: revision,
      }),
    },
    async (input) => invoke("vault.write", { kind: "delete_file", ...input }),
  );

  return server;
}

export const mcpApiHandler = {
  fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const oauth = (
      env as AppEnv & {
        OAUTH_PROVIDER: OAuthHelpers;
      }
    ).OAUTH_PROVIDER;
    const allowedHostnames = env.MCP_ALLOWED_HOSTNAMES.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const handler = createMcpHandler(
      async (requestContext) =>
        createServer(
          env,
          requestContext.authInfo?.scopes ??
            (await effectiveScopesForRequest(request, oauth)),
        ),
      {
        route: "/mcp",
        ...(allowedHostnames.length > 0
          ? { allowedHostnames, allowedOriginHostnames: allowedHostnames }
          : {}),
        onerror(error) {
          console.error(
            JSON.stringify({
              event: "mcp_handler_error",
              error: error.message,
            }),
          );
        },
      },
    );
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
