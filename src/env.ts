import type { VaultContainer } from "./vault-container.js";

export type AppEnv = Omit<Env, "VAULT_CONTAINER"> & {
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_JWKS_URL: string;
  ACCESS_TOKEN_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  INTERNAL_CONTAINER_TOKEN: string;
  VAULT_CONTAINER: DurableObjectNamespace<VaultContainer>;
};

export type AuthProps = {
  email: string;
  name: string;
  sub: string;
};
