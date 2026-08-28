# Security and operations

## Security boundaries

- Cloudflare Access policy decides which people may reach the consent and admin flows. The MCP OAuth server separately issues `vault.read` and `vault.write` grants.
- OAuth authorization state is signed and stored as a one-time, ten-minute KV record. The upstream Access flow uses authorization code plus PKCE, and Access ID tokens are verified against the configured JWKS, audience, and issuer origin.
- Admin sessions are encrypted, `HttpOnly`, `Secure`, `SameSite=Lax` cookies with double-submit CSRF checks and same-origin POST enforcement.
- Obsidian tokens and optional E2E passwords are AES-GCM encrypted before entering Durable Object SQLite. Account passwords and MFA codes are used in a transient login directory and are never persisted.
- The Container's internal HTTP service requires an independent bearer token, returns a generic 404 on unauthenticated calls, and is reached only through its managing DO.
- Container egress is disabled by default and allowlisted to `api.obsidian.md` and `*.obsidian.md`. Cloudflare requires the exported `ContainerProxy` for this enforcement; see [Container outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).
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

## Backup and recovery

Obsidian Sync is synchronization, not the only backup. Keep an independent versioned backup of the vault and test restoration. In particular, a remote client can race the short pull-to-push interval because Obsidian Headless exposes no global transactional lock.

Recovery paths:

- Container replacement: automatic rehydrate from the encrypted DO envelope and Obsidian Sync.
- Continuous process exit: supervised restart with exponential backoff capped at 60 seconds; status reports the exit and attempt count.
- `degraded` after bootstrap: inspect Container/Worker logs, verify vault size and E2E password, then use `/admin` reset and bootstrap again if needed.
- Lost or rotated credential key: reset and re-enter Obsidian credentials. The old encrypted envelope cannot be recovered without the old key.
- Obsidian token revocation: reset, log in again, and review active sessions in the Obsidian account.
- Full reset: `/admin` requires the literal `RESET`; it removes local Container configuration and the DO credential/idempotency tables but does not delete the remote vault or guarantee remote token revocation.

Logs intentionally record operation paths and error messages but not request bodies, tokens, passwords, attachment data, or note contents. Treat paths and remote error strings as potentially sensitive and set an appropriate log retention policy.

## Cost and sizing

The current design keeps one `lite` Container active. At the published [Container pricing](https://developers.cloudflare.com/containers/pricing/), a 730-hour month provisions 182.5 GiB-hours of memory and 1,460 GB-hours of disk. After the Workers Paid included allotments, that is approximately $1.74 in memory and disk overage, plus the $5 Workers Paid base plan, actual CPU, network beyond the regional allowance, Worker/DO use, and logs. If the 1/16-vCPU `lite` instance consumed its maximum CPU continuously, the additional CPU overage would be roughly $2.84; idle continuous Sync should use less, but measure the deployed workload rather than budgeting from that assumption.

Cloudflare currently gives `lite` 256 MiB memory and 2 GB disk and `basic` 1 GiB memory and 4 GB disk. The runtime performs a post-sync headroom check, but the initial pull itself can exhaust a too-small disk. Choose `basic` before bootstrap for a large vault, a high attachment count, or uncertain SQLite/index growth.

## Production checklist

- Restrict the Access SaaS application to named users/groups and require the desired MFA/device posture.
- Set a nonempty `MCP_ALLOWED_HOSTNAMES`.
- Use three independent high-entropy application secrets and retain them in a managed secret store.
- Test official Headless 0.0.14 with a disposable vault matching the production encryption and sharing configuration.
- Exercise concurrent edits from desktop and MCP and decide on an operational conflict policy.
- Verify independent backups and deletion recovery.
- Set Cloudflare budget alerts and log retention.
- Monitor `vault_status` for `degraded`, `sync_pending`, continuous exits, queue growth, and unexpected file-count changes.
- Re-run the full image build, tests, and bootstrap smoke test before changing the pinned Headless package.
