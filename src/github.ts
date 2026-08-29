import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { AppEnv } from "./env.js";
import { createPkce } from "./auth/crypto.js";
import { storeFlow } from "./auth/oidc.js";

const API_VERSION = "2026-03-10";

const accessTokenSchema = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({
    error: z.string().min(1),
    error_description: z.string().optional(),
  }),
]);
const installationsSchema = z.object({
  installations: z.array(z.object({ id: z.number().int().positive() })),
});
const repositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int().positive(),
      full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      default_branch: z.string().nullable().optional(),
      private: z.boolean(),
    }),
  ),
});
const installationTokenSchema = z.object({
  token: z.string().min(1),
  permissions: z.record(z.string(), z.string()).optional(),
});

const GITHUB_BINDING_NAMES = [
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
] as const;

export type GitHubRepositoryChoice = {
  installationId: number;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export function missingGitHubBindings(env: AppEnv): string[] {
  return GITHUB_BINDING_NAMES.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

function githubHeaders(token?: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": "obsidian-sync-mcp",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  operation: string,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => issue.path.join(".") || "response"),
      ),
    ].join(", ");
    throw new Error(
      `${operation} returned an unexpected response${fields ? ` (${fields})` : ""}`,
    );
  }
  return parsed.data;
}

export async function githubAuthorizeRedirect(
  request: Request,
  env: AppEnv,
  adminSub: string,
): Promise<Response> {
  const { verifier, challenge } = await createPkce();
  const state = await storeFlow(env, {
    kind: "github-oauth",
    verifier,
    adminSub,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  url.searchParams.set(
    "redirect_uri",
    new URL("/admin/github/callback", request.url).href,
  );
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.href, 302);
}

export async function exchangeGitHubCode(
  request: Request,
  env: AppEnv,
  verifier: string,
): Promise<string> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("GitHub did not return an authorization code");
  const result = await githubJson(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/admin/github/callback", request.url).href,
        code_verifier: verifier,
      }),
    },
    accessTokenSchema,
    "GitHub OAuth token exchange",
  );
  if ("error" in result) {
    const description = result.error_description
      ? `: ${result.error_description.slice(0, 300)}`
      : "";
    throw new Error(
      `GitHub OAuth token exchange failed (${result.error})${description}`,
    );
  }
  return result.access_token;
}

export async function listGitHubRepositories(
  userToken: string,
): Promise<GitHubRepositoryChoice[]> {
  const installationIds: number[] = [];
  for (let page = 1; ; page += 1) {
    const installations = await githubJson(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      { headers: githubHeaders(userToken) },
      installationsSchema,
      "GitHub installation listing",
    );
    installationIds.push(
      ...installations.installations.map((installation) => installation.id),
    );
    if (installations.installations.length < 100) break;
  }
  const repositories: GitHubRepositoryChoice[] = [];
  for (const installationId of installationIds) {
    for (let page = 1; ; page += 1) {
      const listed = await githubJson(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        { headers: githubHeaders(userToken) },
        repositoriesSchema,
        "GitHub repository listing",
      );
      repositories.push(
        ...listed.repositories.map((repository) => ({
          installationId,
          repositoryId: repository.id,
          fullName: repository.full_name,
          defaultBranch: repository.default_branch || "main",
          private: repository.private,
        })),
      );
      if (listed.repositories.length < 100) break;
    }
  }
  return repositories.sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );
}

export async function listGitHubBranches(
  userToken: string,
  repository: string,
): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/branches?per_page=100&page=${page}`,
      { headers: githubHeaders(userToken) },
    );
    if (response.status === 409) return [];
    if (!response.ok)
      throw new Error(`GitHub branch listing failed (${response.status})`);
    const listed = z
      .array(z.object({ name: z.string().min(1) }))
      .parse(await response.json());
    branches.push(...listed.map((branch) => branch.name));
    if (listed.length < 100) break;
  }
  return branches.sort((left, right) => left.localeCompare(right));
}

async function appJwt(env: AppEnv): Promise<string> {
  const privateKey = env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n");
  const pkcs8 = createPrivateKey(privateKey)
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const key = await importPKCS8(pkcs8, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

export async function createInstallationToken(
  env: AppEnv,
  installationId: number,
  repositoryId: number,
): Promise<string> {
  const result = await githubJson(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(await appJwt(env)),
        "content-type": "application/json",
      },
      body: JSON.stringify({ repository_ids: [repositoryId] }),
    },
    installationTokenSchema,
    "GitHub installation-token creation",
  );
  if (result.permissions?.contents !== "write")
    throw new Error("The GitHub App installation lacks Contents write access");
  return result.token;
}

export async function validateGitHubBranch(
  token: string,
  repository: string,
  branch: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("Invalid GitHub repository");
  if (!branch || branch.length > 255) throw new Error("Invalid Git branch");
  const ref = await fetch(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: githubHeaders(token) },
  );
  if (ref.ok) return;
  const repositoryResponse = await fetch(
    `https://api.github.com/repos/${repository}`,
    { headers: githubHeaders(token) },
  );
  if (!repositoryResponse.ok)
    throw new Error(
      `GitHub repository validation failed (${repositoryResponse.status})`,
    );
  const metadata = z
    .object({
      size: z.number(),
      default_branch: z.string().nullable().optional(),
    })
    .parse(await repositoryResponse.json());
  if (metadata.size === 0 && branch === "main") return;
  throw new Error("The selected Git branch does not exist");
}
