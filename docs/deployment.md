# Deployment

## Prerequisites

- A Cloudflare Workers Paid account with Containers enabled.
- A Cloudflare Zero Trust organization with an identity provider.
- An active Obsidian Sync subscription and the credentials for the account that can access the target vault.
- Node.js 22+, npm, Wrangler authentication, and a running Docker-compatible CLI/daemon for image builds.

The default `lite` Container provides 256 MiB memory and 2 GB ephemeral disk. Use `basic` in `wrangler.jsonc` for a vault or initial index that does not fit comfortably after the image, Obsidian local sync state, SQLite index, and at least 256 MiB of working headroom. Cloudflare publishes the current [Container instance limits](https://developers.cloudflare.com/containers/platform-details/limits/).

## 1. Configure Cloudflare Access OIDC

Create a generic OIDC SaaS application in Zero Trust → Access controls → Applications. Add both production redirect URLs:

```text
https://YOUR_WORKER_HOST/callback
https://YOUR_WORKER_HOST/admin/callback
```

Enable the `openid`, `email`, and `profile` claims. Add an Allow policy containing only the people or groups allowed to read or administer this vault. Access applications deny by default, but the policy is the authorization boundary for this server.

Copy the application's Client ID, Client secret, Authorization endpoint, Token endpoint, and Key endpoint. Use the values issued for the Access SaaS application, not the endpoints of the identity provider behind Access. Cloudflare's [generic OIDC SaaS guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/) shows the exact endpoint shapes, and its [secure MCP server guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) describes the same Access-to-MCP pattern.

## 2. Set configuration and secrets

Set `MCP_ALLOWED_HOSTNAMES` in `wrangler.jsonc` to the exact public Worker host. Multiple hosts are comma-separated. Leaving it empty is useful for initial local development, but is not recommended in production.

Create these Worker secrets with `wrangler secret put NAME`:

| Secret                      | Value                                                  |
| --------------------------- | ------------------------------------------------------ |
| `ACCESS_CLIENT_ID`          | Access SaaS Client ID                                  |
| `ACCESS_CLIENT_SECRET`      | Access SaaS Client secret                              |
| `ACCESS_AUTHORIZATION_URL`  | Access Authorization endpoint                          |
| `ACCESS_TOKEN_URL`          | Access Token endpoint                                  |
| `ACCESS_JWKS_URL`           | Access Key endpoint                                    |
| `COOKIE_ENCRYPTION_KEY`     | Independent random secret, at least 32 bytes           |
| `CREDENTIAL_ENCRYPTION_KEY` | Different independent random secret, at least 32 bytes |
| `INTERNAL_CONTAINER_TOKEN`  | Third independent random secret, at least 32 bytes     |

Generate secrets with a trusted password manager or cryptographic random generator. Do not put production values in `.dev.vars`, shell history, the repository, or command arguments. `.dev.vars.example` contains only placeholders.

Changing `CREDENTIAL_ENCRYPTION_KEY` makes the stored Obsidian envelope unreadable. Reset the integration and bootstrap it again as part of an intentional rotation. Changing `COOKIE_ENCRYPTION_KEY` invalidates admin sessions and pending OIDC state. Changing `INTERNAL_CONTAINER_TOKEN` requires a Container restart before Worker and Container agree on the new value.

## 3. Validate and deploy

```text
npm ci
npm run check
npm run deploy
```

`npm run check` regenerates binding types, type-checks both runtimes, runs all tests, and performs a Wrangler dry-run including the image build. If Docker is intentionally unavailable, `npm run deploy:dry-run:worker` validates the Worker bundle and bindings without updating the Container rollout, but it is not a substitute for building the image before production.

The `OAUTH_KV` declaration uses Wrangler's automatic resource provisioning. The first production deploy also applies Durable Object migration `v1` for `VaultContainer`.

## 4. Bootstrap the vault

Open `https://YOUR_WORKER_HOST/admin`. After the Cloudflare Access login:

1. Enter the Obsidian account email, password, and MFA code if required. The password and MFA code are used only by a transient `ob login` process and are not persisted.
2. Select a returned remote vault and provide its E2E password when applicable.
3. Wait for initial Sync and indexing to complete. `lite` has only 2 GB disk; a headroom failure means you should redeploy with at least `basic`.
4. Confirm `/admin` reports the configured vault and a ready runtime.

The stored envelope contains the Obsidian auth token, selected vault, and optional E2E password because fresh Container disks must be able to rehydrate without an interactive login.

## 5. Connect an MCP client

Use this URL in a Streamable HTTP MCP client:

```text
https://YOUR_WORKER_HOST/mcp
```

The server publishes OAuth protected-resource metadata and supports dynamic client registration. Request `vault.read` for read-only clients and both `vault.read vault.write` for mutation clients. The user is redirected through the server's consent page and Cloudflare Access before the MCP OAuth token is issued.

## Placement and data residency

By default, Cloudflare places the Container near the request that first starts it. If residency or predictable latency matters, add a Container `constraints` block as described in [Container placement](https://developers.cloudflare.com/containers/platform-details/placement/). The vault plaintext, E2E key material in process memory, local index, logs, and Durable Object records must all be included in the deployment's data-handling review.
