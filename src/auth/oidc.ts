import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { AppEnv, AuthProps } from "../env.js";
import { createPkce, signValue, verifySignedValue } from "./crypto.js";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  token_type: z.string().optional(),
});

export type StoredFlow =
  | { kind: "mcp-approval"; oauthRequest: AuthRequest }
  | { kind: "mcp-oidc"; oauthRequest: AuthRequest; verifier: string }
  | { kind: "admin-oidc"; verifier: string; returnTo: string };

type OidcFlowInput =
  | { kind: "mcp-oidc"; oauthRequest: AuthRequest }
  | { kind: "admin-oidc"; returnTo: string };

export async function storeFlow(
  env: AppEnv,
  flow: StoredFlow,
): Promise<string> {
  const nonce = crypto.randomUUID();
  await env.OAUTH_KV.put(`flow:${nonce}`, JSON.stringify(flow), {
    expirationTtl: 600,
  });
  return signValue(nonce, env.COOKIE_ENCRYPTION_KEY);
}

export async function takeFlow(
  env: AppEnv,
  signedState: string,
): Promise<StoredFlow | null> {
  const nonce = await verifySignedValue(signedState, env.COOKIE_ENCRYPTION_KEY);
  if (!nonce) return null;
  const key = `flow:${nonce}`;
  const stored = await env.OAUTH_KV.get(key);
  if (!stored) return null;
  await env.OAUTH_KV.delete(key);
  return JSON.parse(stored) as StoredFlow;
}

export async function oidcRedirect(
  request: Request,
  env: AppEnv,
  flow: OidcFlowInput,
  callbackPath: string,
): Promise<Response> {
  const { verifier, challenge } = await createPkce();
  const state = await storeFlow(env, { ...flow, verifier } as StoredFlow);
  const url = new URL(env.ACCESS_AUTHORIZATION_URL);
  url.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL(callbackPath, request.url).href);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(url.href, 302);
}

export async function exchangeAccessCode(
  request: Request,
  env: AppEnv,
  callbackPath: string,
  verifier: string,
): Promise<AuthProps> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code)
    throw new Error(
      "The identity provider did not return an authorization code",
    );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.ACCESS_CLIENT_ID,
    client_secret: env.ACCESS_CLIENT_SECRET,
    code,
    redirect_uri: new URL(callbackPath, request.url).href,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenResponse.ok)
    throw new Error(`Access token exchange failed (${tokenResponse.status})`);
  const tokens = tokenResponseSchema.parse(await tokenResponse.json());
  const jwks = createRemoteJWKSet(new URL(env.ACCESS_JWKS_URL));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    audience: env.ACCESS_CLIENT_ID,
  });
  const issuer = typeof payload.iss === "string" ? new URL(payload.iss) : null;
  if (
    !issuer ||
    issuer.origin !== new URL(env.ACCESS_AUTHORIZATION_URL).origin
  ) {
    throw new Error(
      "Access ID token issuer did not match the configured Access organization",
    );
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Access ID token is missing a subject or email claim");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : payload.email,
  };
}
