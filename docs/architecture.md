# Architecture and Durable Object decision

## Decision

Use exactly one named Durable Object, `primary-vault`, as the authoritative coordinator for the one configured vault. It is the right Cloudflare primitive for this deployment, with one important qualification: Durable Object single-threading alone does not serialize asynchronous Container I/O, so the implementation also maintains an explicit promise-tail queue around every public vault RPC.

Cloudflare documents that Durable Objects are single-threaded but requests can interleave at non-storage `await` points. The runtime's input/output gates protect storage operations, not an arbitrary sequence of external calls such as pull → local write → push. See [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). The explicit queue is therefore correctness logic, not merely a performance choice.

## Responsibilities by layer

| Layer                | Responsibility                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Worker               | OAuth protocol, Access OIDC, MCP validation, scopes, response framing                       |
| Named Durable Object | Per-vault ordering, encrypted bootstrap envelope, idempotency receipts, Container lifecycle |
| Container service    | Filesystem safety, index, serialized Obsidian one-shots, and Git tree reconciliation        |
| Obsidian Sync        | Canonical remote vault and cross-device replication                                         |

Public calls use Durable Object RPC, the currently recommended invocation model. The DO then calls a token-protected HTTP service on localhost inside its managed Container. Cloudflare's `Container` class itself extends Durable Object and provides lifecycle integration plus SQLite-backed DO storage; see [Durable Object Container](https://developers.cloudflare.com/durable-objects/api/container/).

## Why a Durable Object is appropriate here

- The workload deliberately has one mutable identity: one vault. All MCP mutations must share a total order.
- A DO name gives stable routing to that identity without another coordinator.
- SQLite-backed DO storage survives Container replacement and atomically records encrypted bootstrap state and UUID mutation receipts.
- The DO manages the corresponding single Container and can restore its ephemeral filesystem from Obsidian Sync.
- Expected request volume is low enough that the one-object throughput ceiling is irrelevant.

Cloudflare generally warns against global singleton Durable Objects because they prevent horizontal scaling. This project is the narrow exception by product definition: it serves one vault, and horizontally processing writes against separate replicas would be incorrect. If the service later supports multiple vaults, use one DO name and one Container per vault, never one DO for the whole installation.

## What the DO cannot serialize

The DO serializes operations entering this MCP server. It cannot lock the same vault in Obsidian desktop, mobile, another headless process, or the Sync service itself. Each MCP mutation reduces the race window by:

1. Completing a serialized one-shot pull.
2. Checking the caller's SHA-256 revision and all patch anchors.
3. Applying one atomic local rename or move.
4. Completing a serialized one-shot push before reporting `synced_remote`.

A different Obsidian client can still write between steps 1 and 4. Obsidian Headless does not expose a remote compare-and-swap transaction, so no server-side design can provide a global serializable write across independent Sync clients. Treat `synced_remote` as successful convergence observed by this client, not a permanent remote lock. This is why callers must preserve revisions, use narrow patches, and respond carefully to `sync_pending`.

## Container lifecycle and persistence

Cloudflare Container disks are ephemeral and start fresh after sleep or replacement. The current `onActivityExpired()` renews the timeout, keeping the one Container and its index warm. Cloudflare's [Container lifecycle documentation](https://developers.cloudflare.com/containers/platform-details/architecture/) explicitly states that fresh starts receive a fresh disk.

Unexpected restarts are handled as follows:

- Durable Object SQLite retains the encrypted token, selected vault, E2E password, and mutation receipts.
- `onStart()` passes the decrypted envelope to the new Container over its private token-authenticated service.
- The Container configures the live Headless client without synchronizing it, refreshes a separate download-only safety mirror, checkpoints the complete live vault, and only then permits a bidirectional one-shot. It never starts a long-lived Headless process; scheduled and mutation-triggered one-shots are serialized with reconciliation.
- When GitHub is configured, the DO mints a short-lived installation token and the Container performs a full-vault `B/G/O` three-way reconciliation. Git metadata, safety mirrors, checkpoints, and the index remain outside the vault. Candidate trees are applied with crash-journaled per-file renames; the live vault root inode is never replaced.
- Repository selection records a paused preflight. Scheduled, startup, and mutation-triggered reconciliation remain disabled until an administrator reviews and approves the candidate bound to the current Git head, remote Sync version/digest, safe tree, and candidate tree.
- A retained last-accepted live tree and the minute safety pass detect destructive changes before they become authoritative. The first destructive observation is restored and persisted as `verifying`; only an identical observation with the same Sync version/digest and deletion manifest on the next pass creates durable quarantine. Changed or clean observations supersede or clear the first while retaining bounded diagnostic history.
- Vault calls return `not_ready` until this completes or `degraded` status if it fails.

Scale-to-zero is possible by removing the `onActivityExpired()` override. Every wake would then require a complete remote rehydration and index rebuild, giving lower idle cost but potentially substantial first-request latency and more Sync traffic. It is not the default for an efficient always-current vault server.

## Index design

SQLite FTS5 is local derived state. Notes, attachments, tags, scalar frontmatter, headings, and wikilinks are indexed after initial Sync and after each local or watched change. Searches and listings are paginated; file contents are not put in Durable Object storage or KV. `.obsidian` and the server's own protected directory are neither exposed nor indexed.

This division keeps the DO's durable state small. Obsidian Sync and Git are both inputs to reconciliation; neither transient local Headless state nor an unexpectedly sparse remote snapshot is accepted as authoritative without the deletion guards.
