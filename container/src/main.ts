import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { VaultService } from "./service.js";
import {
  configureSchema,
  gitFinalizeSchema,
  gitReconcileSchema,
  gitSafetyManifestSchema,
  loginSchema,
  vaultOperationSchema,
} from "./validation.js";

const port = Number(process.env.PORT ?? "8080");
const vaultRoot = process.env.VAULT_ROOT ?? "/data/vault";
const indexPath = process.env.INDEX_PATH ?? "/data/index.sqlite";
const deviceName = process.env.DEVICE_NAME ?? "Cloudflare Obsidian MCP";
const internalToken = process.env.INTERNAL_CONTAINER_TOKEN ?? "";

if (!internalToken) throw new Error("INTERNAL_CONTAINER_TOKEN is required");

const service = await VaultService.create(vaultRoot, indexPath, deviceName);

function authorized(request: IncomingMessage): boolean {
  const provided =
    request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(internalToken).digest();
  return timingSafeEqual(left, right);
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > maxBytes) throw new Error("Request body is too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const started = Date.now();
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || !authorized(request)) {
    json(response, 404, {
      ok: false,
      error: { code: "not_found", message: "Not found" },
    });
    return;
  }
  try {
    let result: unknown;
    if (pathname === "/bootstrap/login")
      result = await service.login(
        loginSchema.parse(await readJson(request, 65_536)),
      );
    else if (
      pathname === "/bootstrap/configure" ||
      pathname === "/bootstrap/restore"
    )
      result = await service.configure(
        configureSchema.parse(await readJson(request, 65_536)),
      );
    else if (pathname === "/bootstrap/reset") {
      await readJson(request, 1024);
      result = await service.reset();
    } else if (pathname === "/runtime/status") {
      await readJson(request, 1024);
      result = await service.runtimeStatus();
    } else if (pathname === "/sync/safety-check") {
      await readJson(request, 1024);
      result = await service.scheduledSafetyCheck();
    } else if (pathname === "/git/reconcile") {
      result = await service.reconcileGit(
        gitReconcileSchema.parse(await readJson(request, 65_536)),
      );
    } else if (pathname === "/git/reset") {
      await readJson(request, 1024);
      result = await service.resetGit();
    } else if (pathname === "/git/safety-manifest") {
      const input = gitSafetyManifestSchema.parse(
        await readJson(request, 65_536),
      );
      result = await service.gitSafetyManifest(input.event_id);
    } else if (pathname === "/git/finalize") {
      const input = gitFinalizeSchema.parse(await readJson(request, 65_536));
      result = await service.finalizeGitTransaction(input.transaction_id);
    } else if (pathname === "/rpc")
      result = await service.handle(
        vaultOperationSchema.parse(await readJson(request, 8 * 1024 * 1024)),
      );
    else {
      json(response, 404, {
        ok: false,
        error: { code: "not_found", message: "Not found" },
      });
      return;
    }
    json(response, 200, result);
    console.log(
      JSON.stringify({
        event: "container_request",
        path: pathname,
        durationMs: Date.now() - started,
        ok: true,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "container_request",
        path: pathname,
        durationMs: Date.now() - started,
        ok: false,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    json(response, 400, {
      ok: false,
      error: { code: "invalid_input", message: "The request was invalid" },
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "container_listening", port }));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => void service.shutdown().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 330_000).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
