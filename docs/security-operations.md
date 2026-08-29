# Security and operations

## Security boundaries

- Cloudflare Access policy decides which people may reach the consent and admin flows. The MCP OAuth server separately issues `vault.read` and `vault.write` grants.
- OAuth authorization state is signed and AES-GCM encrypted in a ten-minute KV record, then atomically claimed once in Durable Object SQLite before use. The upstream Access and GitHub flows use authorization code plus PKCE; Access ID tokens are verified against the configured JWKS, audience, and issuer origin.
- Admin sessions are encrypted, `HttpOnly`, `Secure`, `SameSite=Lax` cookies with double-submit CSRF checks and same-origin POST enforcement.
- Obsidian tokens and optional E2E passwords are AES-GCM encrypted before entering Durable Object SQLite. Account passwords and MFA codes are used in a transient login directory and are never persisted.
- The Container's internal HTTP service requires an independent bearer token, returns a generic 404 on unauthenticated calls, and is reached only through its managing DO.
- The Container has native public-internet egress because Obsidian Sync uses WSS, which cannot be carried transparently through Cloudflare's HTTP-level HTTPS interception. The pinned Headless client accepts Sync WebSocket hosts only under `*.obsidian.md`, and its account API host is hard-coded to `api.obsidian.md`, but this is an application restriction rather than a platform egress allowlist. Keep the Container service private, retain its internal bearer authentication, and revisit the restriction if Cloudflare adds protocol-transparent hostname allowlisting; see [Container outbound traffic](https://developers.cloudflare.com/containers/guides/outbound-traffic/).
- The Container runs as a non-root user. `.obsidian`, root-level hidden paths that Headless would not sync, traversal components, absolute paths, backslashes, NULs, symlink segments, and case/Unicode-normalization collisions are rejected. Notes must retain the `.md` class across moves.

This service intentionally permits an authorized `vault.write` client to hard-delete vault files. Cloudflare Access should therefore use the narrowest practical user and device policy, and clients that only search should receive only `vault.read`.

## Mutation result semantics

| Result                        | Meaning                                                            | Caller action                                                                                               |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ok: true`, `synced_remote`   | Pull, local guarded write, and subsequent Sync completed           | Accept the returned revision                                                                                |
| `revision_conflict`           | Current bytes did not match `expected_revision`; no write occurred | Read again and recompute the intended edit                                                                  |
| `patch_conflict`              | An exact patch anchor count differed; no file write occurred       | Inspect the new note and send narrower anchors                                                              |
| `sync_pending` with no `data` | Pre-write pull failed; no local write occurred                     | Retry with the same request ID after Sync recovers                                                          |
| `sync_pending` with `data`    | The local write occurred, but the push was not confirmed           | Do not issue a new mutation blindly; inspect status and read the file, then verify from another Sync client |

The Durable Object records the complete response for each mutation UUID. A repeated identical request returns that response even if continuous Sync later converges. This prevents an ambiguous retry from applying a write twice.

`git_state` is independent from `sync_state`. A successful Obsidian mutation remains successful when Git is pending. When a local mutation exists but its Obsidian push is pending, the server attempts an emergency Git commit so the data has a second durable copy without claiming full convergence.

## Destructive-change quarantine

Before a live one-shot, the Container refreshes a separate `mirror-remote` vault, checkpoints the complete live tree, and compares the mirror with the last accepted remote snapshot. After the one-shot it compares the live result with both the checkpoint and the predicted remote delta. Reconciliation performs the same checks before and after applying its candidate.

The server quarantines when a nonempty vault would become empty, at least half of tracked paths or one quarter of tracked bytes would be deleted, at least 20 paths and 10% of paths would be deleted, or Headless reports an unplanned remote deletion. The exact path list is kept in a protected admin manifest; logs and ordinary status retain only counts, hashes, and a capped preview.

While quarantined:

- Continuous Sync and all Git triggers remain stopped, including after restart.
- MCP reads continue from the restored checkpoint and existing index.
- MCP mutations return `not_ready`.
- The Git base is unchanged and no destructive content commit is pushed.
- `/admin` offers one-time approve/reject actions bound to the event ID and exact Git, remote, safe-tree, and candidate digests. Any change makes the approval stale.

Approval applies only the reviewed candidate and leaves Git in manual-only mode. Rejection archives the live Headless state, republishes the preserved tree, verifies it through the read-only mirror, and only then resumes service. If Git or Obsidian changed while the review was open, use **Refresh this preview** to obtain a new event ID; the stale action is never reused. After approval, run two manual no-op reconciliations before explicitly enabling the schedule. Large renames may require approval because file-level reconciliation represents them as delete/add batches.

## Backup and recovery

Obsidian Sync is synchronization, not the only backup. Keep an independent versioned backup of the vault and test restoration. In particular, a remote client can race the short pull-to-push interval because Obsidian Headless exposes no global transactional lock.

Recovery paths:

- Container replacement: automatic rehydrate from the encrypted DO envelope and Obsidian Sync.
- Continuous process exit: supervised restart with exponential backoff capped at 60 seconds; status reports the exit and attempt count.
- `degraded` after bootstrap: inspect Container/Worker logs, verify vault size and E2E password, then use `/admin` reset and bootstrap again if needed.
- Lost or rotated credential key: reset and re-enter Obsidian credentials. The old encrypted envelope cannot be recovered without the old key.
- Obsidian token revocation: reset, log in again, and review active sessions in the Obsidian account.
- Full reset: `/admin` requires the literal `RESET`; it removes local Container configuration plus the DO credential, idempotency, and Git pairing records, but does not delete either remote or uninstall/revoke the GitHub App.
- Historical Git recovery: enter an ancestor commit in `/admin` to preview a safe union. Missing historical paths are restored, current-only paths and surviving current versions are retained, and current `.github/workflows/**` remains untouched. Approval creates a normal commit descending from the latest branch head; force-push is never used.

Logs intentionally record operation paths and error messages but not request bodies, tokens, passwords, attachment data, or note contents. Treat paths and remote error strings as potentially sensitive and set an appropriate log retention policy.

## Cost and sizing

The current design keeps one `basic` Container active. Consult the current [Container pricing](https://developers.cloudflare.com/containers/pricing/) for the resulting memory, disk, CPU, network, Worker, Durable Object, and log charges; they change independently of this repository.

The runtime requires the `basic` tier and refuses reconciliation unless the live vault has staging headroom of at least 512 MiB and 120% of its current size. The initial Obsidian pull and Git/LFS fetch occur before that check, so size the deployment conservatively and monitor disk use for attachment-heavy vaults.

## Production checklist

- Restrict the Access SaaS application to named users/groups and require the desired MFA/device posture.
- Set a nonempty `MCP_ALLOWED_HOSTNAMES` Worker variable.
- Use three independent high-entropy application secrets and retain them in a managed secret store.
- Test official Headless 0.0.14 with a disposable vault matching the production encryption and sharing configuration.
- Exercise concurrent edits from desktop and MCP and decide on an operational conflict policy.
- Verify independent backups and deletion recovery.
- Set Cloudflare budget alerts and log retention.
- Monitor `vault_status` for `degraded`, `sync_pending`, `destructive_change`, continuous exits, queue growth, and unexpected file-count changes.
- Monitor Git status for paused/quarantined mode, pending retries, LFS failures, conflicts, and `history_rewritten`. The server never force-pushes and requires an administrator to approve initial candidates and resolve rewritten history.
- Treat the Git repository as sensitive plaintext. Obsidian Sync end-to-end encryption does not extend to GitHub, and `.obsidian` plugin data may contain secrets.
- Re-run the full image build, tests, and bootstrap smoke test before changing the pinned Headless package.
