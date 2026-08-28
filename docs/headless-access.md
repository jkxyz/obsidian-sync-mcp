# Headless access to Obsidian Sync

Assessment date: 2026-08-29.

## Selected solution: official Obsidian Headless

The implementation pins `obsidian-headless` 0.0.14 and Node.js 22. The official client supports account login, remote-vault discovery, E2E setup, one-shot Sync, continuous Sync, status, bidirectional mode, attachments, and disabling `.obsidian` configuration sync. Its CLI also accepts `OBSIDIAN_AUTH_TOKEN`, which lets the server persist an encrypted token instead of an account password. The [official repository](https://github.com/obsidianmd/obsidian-headless) and [npm package](https://www.npmjs.com/package/obsidian-headless) are the primary references.

This is the best available fit because it is maintained under the `obsidianmd` organization and implements the actual Obsidian Sync encryption and wire protocol without requiring Electron. The Container wraps the CLI rather than importing its minified internal implementation, keeping the integration on its documented command surface.

There are caveats:

- Obsidian documents [Headless Sync](https://help.obsidian.md/sync/headless) as open beta, and the installed npm package reports `UNLICENSED`. Confirm that your private deployment and any redistribution of a built image comply with Obsidian's terms; this repository makes no license determination.
- The protocol has no documented remote CAS API. Revision guards protect the MCP server's local snapshot but cannot lock other Obsidian clients.
- Open upstream reports have described conflict-strategy behavior and other early-client defects, including [a concurrent-edit report against 0.0.12](https://github.com/obsidianmd/obsidian-headless/issues/42). Pinning the exact version and testing restore, conflicts, large vaults, shared vaults, and E2E behavior against a disposable vault before production is prudent. The project deliberately does not patch the distributed CLI bundle.
- Obsidian credentials are supplied to the documented non-interactive CLI flags during bootstrap. They are visible only within the isolated Container's short-lived process environment/argument surface and are not stored; the returned token is stored in an encrypted Durable Object envelope.

## Other ways to get at a vault headlessly

| Option                                                                                       | Accesses official Obsidian Sync?    | Cloudflare fit         | Assessment                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Obsidian Headless                                                                   | Yes                                 | Strong                 | Selected; official, no GUI, full Sync/E2E, but still beta                                                                                                                                                   |
| Official Obsidian desktop CLI                                                                | Indirectly                          | Poor                   | The [desktop CLI](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Obsidian%20CLI.md) requires the Obsidian app to run; an Electron desktop is unsuitable for this Container |
| Community protocol clients such as [`obsync`](https://github.com/bpauli/obsync)              | Yes, via a community implementation | Technically possible   | More hooks and daemon features, but adds protocol-compatibility, security-review, and maintenance risk compared with the official client                                                                    |
| Experimental [`obsidian-sync-headless`](https://github.com/brendongl/obsidian-sync-headless) | Intended to                         | Not production-ready   | Its published roadmap still shows incomplete push work; useful protocol research, not a foundation for robust writes                                                                                        |
| Local REST API plugin plus an MCP bridge                                                     | Through a running Obsidian app      | Poor                   | Mature note APIs, but requires a desktop Obsidian process and community plugin; examples include [`obsidian-mcp-server`](https://github.com/cyanheads/obsidian-mcp-server)                                  |
| Self-hosted LiveSync with CouchDB/R2                                                         | No                                  | Different architecture | A capable replacement backend, but its own documentation says it is incompatible with official Obsidian Sync; see [Self-hosted LiveSync](https://community.obsidian.md/plugins/obsidian-livesync)           |
| Git, Syncthing, WebDAV, Remotely Save, or cloud-drive sync                                   | No                                  | Varies                 | These synchronize files through a different backend and require every client to adopt that backend; they cannot authenticate to or operate the existing official Sync vault                                 |

## Why not speak the Sync protocol directly

A direct Worker WebSocket implementation could avoid the Container and filesystem, but it would need to reproduce authentication, E2E key derivation, deterministic path encryption, chunking, version tracking, rename/delete semantics, conflict behavior, filters, and ongoing protocol changes. That expands the security boundary around plaintext and keys while depending on an undocumented service. The official headless process already implements those details and provides a filesystem that can be indexed efficiently, so a constrained Container is the smaller and more maintainable integration.
