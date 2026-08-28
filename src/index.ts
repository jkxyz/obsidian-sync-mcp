import { ContainerProxy } from "@cloudflare/containers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./env.js";
import { defaultHandler } from "./auth/handler.js";
import { mcpApiHandler } from "./mcp/server.js";

export { VaultContainer } from "./vault-container.js";
export { ContainerProxy };

const oauthProvider = new OAuthProvider<AppEnv>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["vault.read", "vault.write"],
  allowPlainPKCE: false,
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    scopes_supported: ["vault.read", "vault.write"],
    resource_name: "Obsidian Sync vault",
  },
  onError(error) {
    console.error(
      JSON.stringify({
        event: "oauth_provider_error",
        code: error.code,
        status: error.status,
        internal: error.internal?.category,
      }),
    );
  },
});

export default {
  fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(oauthProvider.purgeExpiredData(env).then(() => undefined));
  },
} satisfies ExportedHandler<AppEnv>;
