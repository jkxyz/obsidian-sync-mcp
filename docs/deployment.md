# Deployment

## Prerequisites

- A Cloudflare Workers Paid account with Containers enabled.
- A Cloudflare Zero Trust organization with an identity provider.
- An active Obsidian Sync subscription and the credentials for the account that can access the target vault.
- A GitHub App installed on the backup repository with repository Contents read/write permission and no Workflows permission.
- Node.js 22+, npm, Wrangler authentication, and a running Docker-compatible CLI/daemon for image builds.

The deployment uses a `basic` Container because reconciliation temporarily needs the live vault, a candidate tree, rollback backups, Git objects, LFS transfer space, two independent Obsidian state directories, and the SQLite index. The runtime refuses reconciliation without at least 512 MiB and 120% of the current vault size free. Cloudflare publishes the current [Container instance limits](https://developers.cloudflare.com/containers/platform-details/limits/).

## 1. Configure Cloudflare Access OIDC

Create a generic OIDC SaaS application in Zero Trust → Access controls → Applications. Add both production redirect URLs:

```text
https://YOUR_WORKER_HOST/callback
https://YOUR_WORKER_HOST/admin/callback
```

Enable the `openid`, `email`, and `profile` claims. Add an Allow policy containing only the people or groups allowed to read or administer this vault. Access applications deny by default, but the policy is the authorization boundary for this server.

Copy the application's Client ID, Client secret, Authorization endpoint, Token endpoint, and Key endpoint. Use the values issued for the Access SaaS application, not the endpoints of the identity provider behind Access. Cloudflare's [generic OIDC SaaS guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/) shows the exact endpoint shapes, and its [secure MCP server guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) describes the same Access-to-MCP pattern.

## 2. Register the GitHub App

Create a GitHub App with:

- Callback URL: `https://YOUR_WORKER_HOST/admin/github/callback`
- Setup URL: `https://YOUR_WORKER_HOST/admin`
- Repository permission: Contents — Read and write
- Repository access: selected repositories
- No Workflows permission and no webhook subscription

The flow follows GitHub's [GitHub App authentication model](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app) and its [repository-permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). Installation tokens are minted per operation for only the selected repository and are never stored or embedded in a Git remote URL.

Generate a private key. The App client ID, App ID, and slug are ordinary Worker variables; the private key and client secret are Worker secrets. The admin GitHub OAuth flow is independent from Cloudflare Access; the Access session is still required to begin and bind it.

## 3. Set configuration and secrets

Environment-specific values are deliberately absent from `wrangler.jsonc`. Configure these ordinary Worker variables during the first deployment:

| Variable                   | Value                                                    |
| -------------------------- | -------------------------------------------------------- |
| `MCP_ALLOWED_HOSTNAMES`    | Exact public Worker host; multiple hosts comma-separated |
| `ACCESS_CLIENT_ID`         | Access SaaS Client ID                                    |
| `ACCESS_AUTHORIZATION_URL` | Access Authorization endpoint                            |
| `ACCESS_TOKEN_URL`         | Access Token endpoint                                    |
| `ACCESS_JWKS_URL`          | Access Key endpoint                                      |
| `GITHUB_APP_CLIENT_ID`     | GitHub App client ID                                     |
| `GITHUB_APP_ID`            | GitHub App ID                                            |
| `GITHUB_APP_SLUG`          | GitHub App slug                                          |

These identifiers, hostnames, and endpoints are configuration rather than credentials. `keep_vars` is enabled in `wrangler.jsonc`, so subsequent `npm run deploy` calls retain their current remote values. To configure or replace them from the CLI, include all of them in one deployment:

```bash
npx wrangler deploy \
  --var "MCP_ALLOWED_HOSTNAMES:YOUR_WORKER_HOST" \
  --var "ACCESS_CLIENT_ID:YOUR_ACCESS_CLIENT_ID" \
  --var "ACCESS_AUTHORIZATION_URL:https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/sso/oidc/YOUR_APP_ID/authorization" \
  --var "ACCESS_TOKEN_URL:https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/sso/oidc/YOUR_APP_ID/token" \
  --var "ACCESS_JWKS_URL:https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/sso/oidc/YOUR_APP_ID/jwks" \
  --var "GITHUB_APP_CLIENT_ID:YOUR_GITHUB_APP_CLIENT_ID" \
  --var "GITHUB_APP_ID:YOUR_GITHUB_APP_ID" \
  --var "GITHUB_APP_SLUG:YOUR_GITHUB_APP_SLUG"
```

The values are non-secret, but this command will be retained in shell history. Use the Cloudflare dashboard instead if even those identifiers should not appear locally.

As a shorter equivalent, populate the ignored `.env` from `.env.example`, verify the resulting bindings, and deploy them with:

```bash
npm run deploy:dry-run:configured
npm run deploy:configured
```

These commands parse only the eight public variable names listed above and pass them to Wrangler as `--var` bindings. They do not read or upload secrets. The normal `npm run deploy` deliberately does not read `.env`; it retains variables that are already configured remotely.

Run that complete command once when upgrading an existing deployment. It replaces the old committed GitHub placeholders and reclassifies the Access endpoints, Access client ID, and allowed hostname from secret bindings to plain variables. Later code deployments can use `npm run deploy` without repeating them.

Create only the following Worker secrets with `npx wrangler secret put NAME`:

| Secret                      | Value                                                  |
| --------------------------- | ------------------------------------------------------ |
| `ACCESS_CLIENT_SECRET`      | Access SaaS Client secret                              |
| `COOKIE_ENCRYPTION_KEY`     | Independent random secret, at least 32 bytes           |
| `CREDENTIAL_ENCRYPTION_KEY` | Different independent random secret, at least 32 bytes |
| `INTERNAL_CONTAINER_TOKEN`  | Third independent random secret, at least 32 bytes     |
| `GITHUB_APP_CLIENT_SECRET`  | GitHub App client secret                               |
| `GITHUB_APP_PRIVATE_KEY`    | GitHub App PEM private key (PKCS#1 or PKCS#8)          |

For an existing Worker, set or rotate secrets interactively, for example:

```bash
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
```

For a first deployment, Worker secrets cannot be installed before the Worker exists. Supply all six in a protected secret-format or JSON file outside the repository and add `--secrets-file PATH` to the initial `wrangler deploy` command. Omitted secrets are preserved on later deployments.

For local development or a configured deployment, copy `.env.example` to `.env` for the ordinary variables:

```bash
cp .env.example .env
npm run dev
```

The populated `.env` is ignored and contains no secrets. `npm run dev` passes those values as local bindings and explicitly ignores `.dev.vars`; `npm run deploy:configured` passes the same named values to the production deployment. Production secrets installed with Wrangler remain only in Cloudflare and are inherited by deployments without being downloaded into the local process. If a developer needs to exercise a secret-dependent flow locally, inject separate disposable development secrets into the command's process environment from a secret manager. Do not copy production secrets into local files.

Keep production credentials in a managed secret store; do not put them in local development files, shell history, the repository, or command arguments. To upload several secrets interactively from a protected file, use `npx wrangler secret bulk PATH_TO_SECRET_FILE` on an existing Worker.

Generate the three application secrets with a trusted password manager or cryptographic random generator.

Changing `CREDENTIAL_ENCRYPTION_KEY` makes the stored Obsidian envelope unreadable. Reset the integration and bootstrap it again as part of an intentional rotation. Changing `COOKIE_ENCRYPTION_KEY` invalidates admin sessions and pending OIDC state. Changing `INTERNAL_CONTAINER_TOKEN` requires a Container restart before Worker and Container agree on the new value.

## 4. Validate and deploy

```text
npm ci
npm run check
npm run deploy
```

`npm run check` regenerates binding types, type-checks both runtimes, runs all tests, and performs a Wrangler dry-run including the image build. If Docker is intentionally unavailable, `npm run deploy:dry-run:worker` validates the Worker bundle and bindings without updating the Container rollout, but it is not a substitute for building the image before production.

Dry-run deployments do not turn `.env` entries into Worker bindings, do not fetch remote variable values, and do not require credentials. Their binding summary therefore shows only bindings declared directly in `wrangler.jsonc`; it is a build check, not a production-configuration audit. `npm run dev` is the command that validates and loads the local public-variable file.

The `OAUTH_KV` declaration uses Wrangler's automatic resource provisioning. The first production deploy also applies Durable Object migration `v1` for `VaultContainer`.

## 5. Bootstrap the vault and Git repository

Open `https://YOUR_WORKER_HOST/admin`. After the Cloudflare Access login:

1. Enter the Obsidian account email, password, and MFA code if required. The password and MFA code are used only by a transient `ob login` process and are not persisted.
2. Select a returned remote vault and provide its E2E password when applicable.
3. Wait for the isolated safety mirror, guarded bootstrap Sync, and indexing to complete. If a deletion review appears, do not approve it until the path manifest is understood.
4. Select **Connect GitHub**, authorize the separate GitHub App, choose one of its installed repositories, then choose a branch. An empty repository initializes `main`.
5. Repository selection leaves reconciliation in `paused` mode. Select **Preview initial reconciliation**, review the exact candidate, and approve it only if the file/byte counts and path sample are expected. Approval records the base but deliberately remains paused.
6. Confirm `/admin` reports both Obsidian and Git as converged, run two **manual reconciliation** no-ops, then select **Enable one-minute schedule**.

The first reconciliation unions Git-only and Obsidian-only files and uses Obsidian for same-path differences. Later runs use the last reconciled commit as a three-way base. `.github/workflows/**` is deliberately excluded because the App has no Workflows permission. Git LFS rules are honored only when already declared by `.gitattributes`; every machine using those rules must have Git LFS installed.

The stored envelope contains the Obsidian auth token, selected vault, and optional E2E password because fresh Container disks must be able to rehydrate without an interactive login.

### Guarded recovery for the August 2026 incident

Keep GitHub reconciliation disconnected until the guarded build is deployed and the live vault agrees with the isolated safety mirror. Then:

1. Reconnect `jkxyz/vault`; it will remain paused.
2. In the historical recovery field, enter `ff78dc1af0ca1a4a0810b8353671e1003cce4a0f`.
3. Review the safe-union preview. It restores paths missing since that commit, retains current-only paths and current versions of surviving paths, and preserves workflows from the current branch.
4. Approve the exact event. A stale Git head, Sync version/digest, live safe tree, or candidate digest invalidates the action instead of applying it.
5. Verify the resulting commit is a descendant of the latest remote head, the full live tree matches it except excluded workflows, the safety mirror contains the supported Obsidian subset, and scheduled one-shot Sync is healthy.
6. Run two manual no-op reconciliations, then select **Enable one-minute schedule**.

Never deploy this recovery by resetting or force-pushing the branch. The losing deletion commit remains part of Git history.

## 6. Connect an MCP client

Use this URL in a Streamable HTTP MCP client:

```text
https://YOUR_WORKER_HOST/mcp
```

The server publishes OAuth protected-resource metadata and supports dynamic client registration. Request `vault.read` for read-only clients and both `vault.read vault.write` for mutation clients. The user is redirected through the server's consent page and Cloudflare Access before the MCP OAuth token is issued.

## Placement and data residency

By default, Cloudflare places the Container near the request that first starts it. If residency or predictable latency matters, add a Container `constraints` block as described in [Container placement](https://developers.cloudflare.com/containers/platform-details/placement/). The vault plaintext, E2E key material in process memory, local index, logs, and Durable Object records must all be included in the deployment's data-handling review.
