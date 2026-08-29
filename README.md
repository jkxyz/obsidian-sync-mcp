# Obsidian Sync MCP on Cloudflare

A single-vault, remote MCP server backed by official Obsidian Sync. A Cloudflare Worker handles MCP and OAuth, one named Durable Object serializes vault activity and records idempotency state, and a Cloudflare Container runs the official `obsidian-headless` client plus a local SQLite FTS5 index.

This is an implementation for one private vault, not a multi-tenant service. It is intentionally deny-by-default around paths, outbound network access, OAuth scopes, and destructive writes.

## What it provides

- Streamable HTTP MCP v2 at `/mcp`, with OAuth discovery, dynamic client registration, PKCE, consent, and `vault.read` / `vault.write` scopes.
- Cloudflare Access as the upstream identity provider for both MCP authorization and the bootstrap admin UI.
- Ranked full-text search over note bodies, titles, headings, scalar frontmatter, and tags, with pagination and filters.
- Revision-guarded note patches, attachment writes, moves, and deletes; UUID request IDs make MCP mutation retries idempotent.
- A pull-before-write and push-after-write pipeline using official Obsidian Headless, with explicit `sync_pending` results when remote confirmation fails.
- Full-vault three-way reconciliation with a selected GitHub repository, including `.obsidian`, `.agents`, attachments, Git LFS, and independently reported Git convergence.
- An isolated read-only Sync mirror, recoverable live checkpoints, and deletion quarantine before destructive remote state can become authoritative.
- Protected `.obsidian` configuration, traversal/symlink/case-collision defenses, bounded request bodies, and a 5 MiB MCP attachment limit.

## Architecture

```mermaid
flowchart LR
  C[MCP client] -->|OAuth + Streamable HTTP| W[Cloudflare Worker]
  W -->|Access OIDC| A[Cloudflare Access]
  W -->|RPC to primary-vault| D[Durable Object]
  D -->|serialized internal HTTP + short-lived Git token| X[Cloudflare Container]
  X --> I[(SQLite FTS5 index)]
  X <-->|native TLS and WebSocket| O[Obsidian Sync]
  X <-->|normal fetch and push; no force push| G[(GitHub repository)]
  D --> S[(DO SQLite: encrypted credential envelope and idempotency)]
```

The vault and search index live on the Container disk. The encrypted Obsidian token, selected GitHub App installation/repository, reconciliation mode, last reconciled Git commit, quarantine metadata, and mutation receipts live in Durable Object SQLite. Reconciliation changes files in place under a crash journal and never replaces the vault root. A repository is connected in paused preflight mode and cannot write until an administrator approves its exact candidate. See [architecture and Durable Object decision](docs/architecture.md) for lifecycle details.

## MCP tools

| Tool             | Scope | Behavior                                                                             |
| ---------------- | ----- | ------------------------------------------------------------------------------------ |
| `vault_status`   | read  | Readiness, Sync state, Git heads/retries/conflicts/LFS, counts, and Headless version |
| `list_files`     | read  | Filtered cursor-paginated note and attachment metadata                               |
| `read_note`      | read  | Exact Markdown, metadata, line slicing, and SHA-256 revision                         |
| `search_notes`   | read  | Ranked lexical search with prefix, tag, and property filters                         |
| `get_links`      | read  | Wikilink outgoing links, backlinks, and unresolved links                             |
| `get_attachment` | read  | Base64 embedded MCP resource up to 5 MiB                                             |
| `create_note`    | write | Create-only atomic Markdown write                                                    |
| `patch_note`     | write | Ordered exact patches guarded by a revision                                          |
| `put_attachment` | write | Create or revision-guarded replace up to 5 MiB                                       |
| `move_file`      | write | No-overwrite move with affected backlinks reported                                   |
| `delete_file`    | write | Revision-guarded hard delete                                                         |

Every mutation requires a fresh UUID `request_id`. Results that may include a local change are recorded: reusing their UUID with identical input returns the recorded result, while reusing it with different input fails. A failure that provably happened before any local change is not retained, so the same request can be retried after the underlying condition recovers.

## Deploy

Read [deployment](docs/deployment.md) before deploying. In short:

1. Create a Cloudflare Access generic OIDC SaaS application with callback URLs `https://YOUR_WORKER/callback` and `https://YOUR_WORKER/admin/callback`, then restrict it with an Access Allow policy.
2. Register a repository-scoped GitHub App, configure its public IDs as remote Worker variables, and store its client secret and private key with the Access and application secrets.
3. Copy `.env.example` to the ignored `.env` for ordinary variables. Production secrets remain in Cloudflare and are not copied into local files.
4. Run `npm run check`, then `npm run deploy:configured` from an environment with a Docker-compatible CLI and daemon. Later code-only deployments may use `npm run deploy` to retain the remote variables.
5. Open `/admin`, authenticate to Obsidian, connect the GitHub App, select its repository and branch, review the initial candidate, and explicitly approve it.

The Worker creates the `OAUTH_KV` namespace during deployment. A Workers Paid plan, Cloudflare Containers access, Cloudflare Access, and an active Obsidian Sync subscription are required.

## Development

Node.js 22 or newer is required. Install locked dependencies with `npm ci`, then use:

```text
npm run typecheck
npm test
npm run build
npm run deploy:dry-run:worker
npm run deploy:dry-run
```

The last command also builds the Container image and therefore requires Docker or a Wrangler-compatible alternative. The Worker-only dry-run still validates bundling, bindings, Durable Object migrations, and the Container declaration.

Operational limitations and recovery procedures are documented in [security and operations](docs/security-operations.md). The headless-client investigation and rationale for the selected integration are in [headless access options](docs/headless-access.md).

## License

Copyright (C) 2026 jkxyz.

The original code in this repository is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). The corresponding source is available at [github.com/jkxyz/obsidian-sync-mcp](https://github.com/jkxyz/obsidian-sync-mcp).

Dependencies and other third-party components remain under their own terms and are not relicensed by the AGPL. In particular, `obsidian-headless` declares `UNLICENSED`; this project provides source and build instructions but does not publish prebuilt container images for third-party download. See [third-party notices](THIRD_PARTY_NOTICES.md).
