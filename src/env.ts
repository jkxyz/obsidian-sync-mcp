import type { VaultContainer } from "./vault-container.js";

export type AppEnv = Omit<Env, "VAULT_CONTAINER"> & {
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_JWKS_URL: string;
  ACCESS_TOKEN_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_SLUG: string;
  INTERNAL_CONTAINER_TOKEN: string;
  MCP_ALLOWED_HOSTNAMES: string;
  VAULT_CONTAINER: DurableObjectNamespace<VaultContainer>;
};

export type AuthProps = {
  email: string;
  name: string;
  sub: string;
};
