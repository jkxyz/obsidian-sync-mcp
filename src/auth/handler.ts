import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AppEnv, AuthProps } from "../env.js";
import type { AdminStatus } from "../vault-container.js";
import type { VaultResponse } from "../shared/protocol.js";
import {
  adminPage,
  approvalPage,
  errorPage,
  githubBranchPage,
  githubRepositoryPage,
  homePage,
} from "./pages.js";
import {
  constantTimeEqual,
  cookieValue,
  decryptJson,
  encryptJson,
  randomToken,
} from "./crypto.js";
import {
  exchangeAccessCode,
  oidcRedirect,
  storeFlow,
  takeFlow,
} from "./oidc.js";
import {
  exchangeGitHubCode,
  githubAuthorizeRedirect,
  listGitHubBranches,
  listGitHubRepositories,
  missingGitHubBindings,
} from "../github.js";

const SESSION_COOKIE = "__Host-OBSIDIAN_ADMIN";
const CSRF_COOKIE = "__Host-OBSIDIAN_CSRF";
const ALLOWED_SCOPES = new Set(["vault.read", "vault.write"]);

type OAuthEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };
type AdminSession = AuthProps & { csrf: string; expiresAt: number };

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 65_536) throw new Error("Form body is too large");
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 65_536) {
      await reader.cancel();
      throw new Error("Form body is too large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(combined));
}

async function adminSession(
  request: Request,
  env: AppEnv,
): Promise<AdminSession | null> {
  const encrypted = cookieValue(request, SESSION_COOKIE);
  if (!encrypted) return null;
  const session = await decryptJson<AdminSession>(
    encrypted,
    env.COOKIE_ENCRYPTION_KEY,
  );
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

async function requireAdminPost(
  request: Request,
  env: AppEnv,
): Promise<{ form: URLSearchParams; session: AdminSession }> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    throw new Error("Invalid request origin");
  const session = await adminSession(request, env);
  if (!session) throw new Error("Admin session expired");
  const form = await readForm(request);
  const supplied = form.get("csrf") ?? "";
  const csrfCookie = cookieValue(request, CSRF_COOKIE) ?? "";
  if (
    !(await constantTimeEqual(supplied, session.csrf)) ||
    !(await constantTimeEqual(csrfCookie, session.csrf))
  ) {
    throw new Error("Invalid CSRF token");
  }
  return { form, session };
}

async function renderAdmin(
  env: AppEnv,
  session: AdminSession,
  message?: string,
  error?: string,
): Promise<Response> {
  const stub = env.VAULT_CONTAINER.getByName("primary-vault");
  const status = (await stub.adminStatus()) as AdminStatus;
  const missingGitHub = missingGitHubBindings(env);
  const response = adminPage({
    email: session.email,
    csrf: session.csrf,
    configured: status.configured,
    ...(status.vault ? { vault: status.vault } : {}),
    ...(status.remoteVaults ? { remoteVaults: status.remoteVaults } : {}),
    status,
    ...(status.git ? { git: status.git } : {}),
    ...(missingGitHub.length > 0
      ? {
          githubConfigurationError: `GitHub integration is missing Worker bindings: ${missingGitHub.join(", ")}. Configure them and deploy again.`,
        }
      : {}),
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
  });
  return withCookie(response, secureCookie(CSRF_COOKIE, session.csrf, 28_800));
}

async function handleGitHubCallback(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await adminSession(request, env);
  if (!session)
    return Response.redirect(new URL("/admin/login", request.url), 302);
  const flow = await takeFlow(
    env,
    new URL(request.url).searchParams.get("state") ?? "",
  );
  if (!flow || flow.kind !== "github-oauth" || flow.adminSub !== session.sub)
    return errorPage("GitHub authorization state expired");
  try {
    const userToken = await exchangeGitHubCode(request, env, flow.verifier);
    const repositories = await listGitHubRepositories(userToken);
    const selectionState = await storeFlow(env, {
      kind: "github-repository-selection",
      adminSub: session.sub,
      accessToken: userToken,
      repositories,
    });
    return withCookie(
      githubRepositoryPage({
        email: session.email,
        csrf: session.csrf,
        state: selectionState,
        repositories,
        installUrl: `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`,
      }),
      secureCookie(CSRF_COOKIE, session.csrf, 28_800),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub authorization failed";
    console.error(
      JSON.stringify({ event: "github_authorization_error", error: message }),
    );
    return errorPage(
      `${message}. Return to administration and start a new GitHub authorization attempt.`,
      502,
    );
  }
}

async function handleAuthorizeGet(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const requestedInvalid = oauthRequest.scope.find(
    (scope) => !ALLOWED_SCOPES.has(scope),
  );
  if (requestedInvalid)
    return errorPage(`Unsupported scope: ${requestedInvalid}`);
  const state = await storeFlow(env, { kind: "mcp-approval", oauthRequest });
  const csrf = randomToken();
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  return withCookie(
    approvalPage(client, oauthRequest, state, csrf),
    secureCookie(CSRF_COOKIE, csrf, 600),
  );
}

async function handleAuthorizePost(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const form = await readForm(request);
  const csrf = form.get("csrf") ?? "";
  if (!(await constantTimeEqual(csrf, cookieValue(request, CSRF_COOKIE) ?? "")))
    return errorPage("Invalid CSRF token");
  const flow = await takeFlow(env, form.get("state") ?? "");
  if (!flow || flow.kind !== "mcp-approval")
    return errorPage("Authorization request expired");
  return oidcRedirect(
    request,
    env,
    { kind: "mcp-oidc", oauthRequest: flow.oauthRequest },
    "/callback",
  );
}

async function handleMcpCallback(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  const flow = await takeFlow(env, state);
  if (!flow || flow.kind !== "mcp-oidc")
    return errorPage("Authorization state expired");
  const identity = await exchangeAccessCode(
    request,
    env,
    "/callback",
    flow.verifier,
  );
  const scope = flow.oauthRequest.scope.filter((candidate) =>
    ALLOWED_SCOPES.has(candidate),
  );
  const granted = scope.length > 0 ? scope : ["vault.read"];
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: flow.oauthRequest,
    userId: identity.sub,
    metadata: { label: identity.email },
    scope: granted,
    props: identity,
  });
  return Response.redirect(redirectTo, 302);
}

async function handleAdminCallback(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const flow = await takeFlow(
    env,
    new URL(request.url).searchParams.get("state") ?? "",
  );
  if (!flow || flow.kind !== "admin-oidc")
    return errorPage("Admin login state expired");
  const identity = await exchangeAccessCode(
    request,
    env,
    "/admin/callback",
    flow.verifier,
  );
  const session: AdminSession = {
    ...identity,
    csrf: randomToken(),
    expiresAt: Date.now() + 28_800_000,
  };
  const encrypted = await encryptJson(session, env.COOKIE_ENCRYPTION_KEY);
  const response = Response.redirect(
    new URL(flow.returnTo, request.url).href,
    302,
  );
  return withCookie(response, secureCookie(SESSION_COOKIE, encrypted, 28_800));
}

async function handleAdminPost(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { form, session } = await requireAdminPost(request, env);
  const stub = env.VAULT_CONTAINER.getByName("primary-vault");
  if (pathname === "/admin/github/repository") {
    const flow = await takeFlow(env, form.get("github_state") ?? "");
    if (
      !flow ||
      flow.kind !== "github-repository-selection" ||
      flow.adminSub !== session.sub
    )
      return renderAdmin(
        env,
        session,
        undefined,
        "GitHub repository selection expired",
      );
    const index = Number(form.get("repository_index") ?? "-1");
    const selected = Number.isInteger(index)
      ? flow.repositories[index]
      : undefined;
    if (!selected)
      return renderAdmin(env, session, undefined, "Select a GitHub repository");
    const branches = await listGitHubBranches(
      flow.accessToken,
      selected.fullName,
    );
    const branchState = await storeFlow(env, {
      kind: "github-branch-selection",
      adminSub: session.sub,
      repository: {
        installationId: selected.installationId,
        repositoryId: selected.repositoryId,
        fullName: selected.fullName,
      },
      branches,
    });
    return withCookie(
      githubBranchPage({
        email: session.email,
        csrf: session.csrf,
        state: branchState,
        repository: selected.fullName,
        branches,
      }),
      secureCookie(CSRF_COOKIE, session.csrf, 28_800),
    );
  }
  if (pathname === "/admin/github/configure") {
    const flow = await takeFlow(env, form.get("github_state") ?? "");
    if (
      !flow ||
      flow.kind !== "github-branch-selection" ||
      flow.adminSub !== session.sub
    )
      return renderAdmin(
        env,
        session,
        undefined,
        "GitHub repository selection expired",
      );
    const branch = form.get("branch")?.trim() ?? "";
    if (
      !branch ||
      (flow.branches.length > 0 && !flow.branches.includes(branch)) ||
      (flow.branches.length === 0 && branch !== "main")
    )
      return renderAdmin(env, session, undefined, "Select a valid Git branch");
    try {
      await stub.configureGit({
        installationId: flow.repository.installationId,
        repositoryId: flow.repository.repositoryId,
        repository: flow.repository.fullName,
        branch,
      });
      return renderAdmin(
        env,
        session,
        `Git reconciliation configured in paused mode for ${flow.repository.fullName}:${branch}. Preview it before enabling.`,
      );
    } catch (error) {
      return renderAdmin(
        env,
        session,
        undefined,
        error instanceof Error ? error.message : "GitHub setup failed",
      );
    }
  }
  if (pathname === "/admin/github/preview") {
    const result = await stub.previewGit();
    return renderAdmin(
      env,
      session,
      result?.safety_event
        ? "Initial reconciliation preview is ready."
        : undefined,
      result?.safety_event
        ? undefined
        : result?.error || "Could not prepare the reconciliation preview",
    );
  }
  if (pathname === "/admin/github/restore") {
    const restoreCommit = form.get("restore_commit")?.trim() ?? "";
    if (!/^[a-f0-9]{40,64}$/u.test(restoreCommit))
      return renderAdmin(
        env,
        session,
        undefined,
        "Enter a full Git commit SHA",
      );
    const result = await stub.previewGit(restoreCommit);
    return renderAdmin(
      env,
      session,
      result?.safety_event
        ? "Historical recovery preview is ready."
        : undefined,
      result?.safety_event
        ? undefined
        : result?.error || "Could not prepare the recovery preview",
    );
  }
  if (pathname === "/admin/github/safety") {
    const action = form.get("action");
    const eventId = form.get("event_id") ?? "";
    if (
      (action !== "approve" && action !== "reject") ||
      !/^[a-f0-9-]{36}$/u.test(eventId)
    )
      return renderAdmin(env, session, undefined, "Invalid safety action");
    const result = await stub.resolveGitSafety(action, eventId);
    return renderAdmin(
      env,
      session,
      result?.state === "converged"
        ? action === "approve"
          ? "The reviewed reconciliation candidate was applied."
          : "The deletion was rejected and the safe vault was republished."
        : undefined,
      result?.state === "converged"
        ? undefined
        : result?.error || result?.blocked_reason || "Safety resolution failed",
    );
  }
  if (pathname === "/admin/github/safety-refresh") {
    const eventId = form.get("event_id") ?? "";
    if (!/^[a-f0-9-]{36}$/u.test(eventId))
      return renderAdmin(env, session, undefined, "Invalid safety event");
    const result = await stub.refreshGitSafety(eventId);
    return renderAdmin(
      env,
      session,
      result?.safety_event
        ? "The safety preview was refreshed against current Git and Obsidian state."
        : undefined,
      result?.safety_event
        ? undefined
        : result?.error || "Could not refresh the safety preview",
    );
  }
  if (pathname === "/admin/github/reconcile") {
    const result = await stub.reconcileGit();
    return renderAdmin(
      env,
      session,
      result?.state === "converged"
        ? "Git reconciliation completed."
        : undefined,
      result?.state === "converged"
        ? undefined
        : result?.error ||
            result?.blocked_reason ||
            "Git reconciliation is pending",
    );
  }
  if (pathname === "/admin/github/enable") {
    await stub.enableScheduledGit();
    return renderAdmin(
      env,
      session,
      "Scheduled Git reconciliation is enabled.",
    );
  }
  if (pathname === "/admin/github/resolve") {
    const resolution = form.get("resolution");
    if (resolution !== "adopt_remote" && resolution !== "reconnect_base")
      return renderAdmin(env, session, undefined, "Invalid resolution action");
    const result = await stub.reconcileGit(resolution);
    return renderAdmin(
      env,
      session,
      result?.state === "converged"
        ? "Git history resolution completed."
        : undefined,
      result?.state === "converged"
        ? undefined
        : result?.error || result?.blocked_reason || "Resolution is pending",
    );
  }
  if (pathname === "/admin/github/disconnect") {
    await stub.disconnectGit();
    return renderAdmin(
      env,
      session,
      "GitHub repository disconnected. Remote data was not deleted.",
    );
  }
  if (pathname === "/admin/obsidian-login") {
    const email = form.get("email") ?? "";
    const password = form.get("password") ?? "";
    const mfa = form.get("mfa") || undefined;
    if (!email || !password)
      return renderAdmin(
        env,
        session,
        undefined,
        "Email and password are required",
      );
    const result = (await stub.bootstrapLogin({
      email,
      password,
      ...(mfa ? { mfa } : {}),
    })) as VaultResponse<{ vaults?: { id?: string; name?: string }[] }>;
    return renderAdmin(
      env,
      session,
      result.ok
        ? "Obsidian login succeeded. Select the remote vault."
        : undefined,
      result.ok ? undefined : result.error.message,
    );
  }
  if (pathname === "/admin/configure") {
    const vault = form.get("vault") ?? "";
    const vaultPassword = form.get("vault_password") || undefined;
    if (!vault)
      return renderAdmin(env, session, undefined, "Select a remote vault");
    const result = (await stub.bootstrapConfigure({
      vault,
      ...(vaultPassword ? { vaultPassword } : {}),
    })) as VaultResponse<{ vaults?: { id?: string; name?: string }[] }>;
    return renderAdmin(
      env,
      session,
      result.ok
        ? "Vault configured and initial synchronization started."
        : undefined,
      result.ok ? undefined : result.error.message,
    );
  }
  if (pathname === "/admin/reset") {
    if (form.get("confirmation") !== "RESET")
      return renderAdmin(
        env,
        session,
        undefined,
        "Reset confirmation did not match",
      );
    await stub.resetConfiguration();
    return renderAdmin(
      env,
      session,
      "Local vault configuration removed. Remote Sync data was not deleted.",
    );
  }
  return errorPage("Not found", 404);
}

export const defaultHandler = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauthEnv = env as OAuthEnv;
    try {
      if (request.method === "GET" && url.pathname === "/") return homePage();
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ ok: true });
      if (request.method === "GET" && url.pathname === "/authorize")
        return handleAuthorizeGet(request, oauthEnv);
      if (request.method === "POST" && url.pathname === "/authorize")
        return handleAuthorizePost(request, oauthEnv);
      if (request.method === "GET" && url.pathname === "/callback")
        return handleMcpCallback(request, oauthEnv);
      if (request.method === "GET" && url.pathname === "/admin/login") {
        return oidcRedirect(
          request,
          env,
          { kind: "admin-oidc", returnTo: "/admin" },
          "/admin/callback",
        );
      }
      if (request.method === "GET" && url.pathname === "/admin/callback")
        return handleAdminCallback(request, env);
      if (
        request.method === "GET" &&
        url.pathname === "/admin/github/connect"
      ) {
        const session = await adminSession(request, env);
        if (!session)
          return Response.redirect(
            new URL("/admin/login", request.url).href,
            302,
          );
        const missingGitHub = missingGitHubBindings(env);
        return missingGitHub.length > 0
          ? errorPage(
              `GitHub integration is missing Worker bindings: ${missingGitHub.join(", ")}. Configure them and deploy again.`,
              503,
            )
          : githubAuthorizeRedirect(request, env, session.sub);
      }
      if (request.method === "GET" && url.pathname === "/admin/github/callback")
        return handleGitHubCallback(request, env);
      if (request.method === "GET" && url.pathname === "/admin") {
        const session = await adminSession(request, env);
        return session
          ? renderAdmin(env, session)
          : Response.redirect(new URL("/admin/login", request.url).href, 302);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/admin/github/safety-manifest"
      ) {
        const session = await adminSession(request, env);
        if (!session)
          return Response.redirect(
            new URL("/admin/login", request.url).href,
            302,
          );
        const eventId = url.searchParams.get("event_id") ?? "";
        if (!/^[a-f0-9-]{36}$/u.test(eventId))
          return errorPage("Invalid safety event", 400);
        const manifest =
          await env.VAULT_CONTAINER.getByName(
            "primary-vault",
          ).gitSafetyManifest(eventId);
        return Response.json(manifest, {
          headers: {
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="git-safety-${eventId}.json"`,
          },
        });
      }
      if (request.method === "POST" && url.pathname.startsWith("/admin/"))
        return handleAdminPost(request, env);
      return errorPage("Not found", 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "auth_or_admin_error",
          path: url.pathname,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return errorPage("The request could not be completed", 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

export type { AuthRequest };
