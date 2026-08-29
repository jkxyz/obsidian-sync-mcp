import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";

const SOURCE_URL = "https://github.com/jkxyz/obsidian-sync-mcp";
const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui;max-width:50rem;margin:3rem auto;padding:0 1rem;color:#1f2937}main{border:1px solid #d1d5db;border-radius:12px;padding:1.5rem}footer{font-size:.875rem;margin:1rem 0;text-align:center;color:#4b5563}label{display:block;margin:.8rem 0 .25rem}input,select,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box}button{margin-top:1rem;cursor:pointer}code{background:#f3f4f6;padding:.15rem .3rem}nav a{margin-right:1rem}.notice{background:#fef3c7;padding:.75rem;border-radius:6px}.error{background:#fee2e2;padding:.75rem;border-radius:6px}</style></head><body><main>${body}</main><footer><a href="${SOURCE_URL}">Source code</a> · <a href="${LICENSE_URL}" rel="license">AGPL-3.0-or-later</a> · No warranty</footer></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
      },
    },
  );
}

export function homePage(): Response {
  return page(
    "Obsidian Sync MCP",
    `<h1>Obsidian Sync MCP</h1><p>The MCP endpoint is <code>/mcp</code>.</p><nav><a href="/admin">Vault administration</a><a href="/health">Worker health</a></nav>`,
  );
}

export function approvalPage(
  client: ClientInfo | null,
  requestInfo: AuthRequest,
  state: string,
  csrf: string,
): Response {
  const clientName = escapeHtml(client?.clientName ?? requestInfo.clientId);
  const scopes = requestInfo.scope.map(escapeHtml).join(", ");
  const body = `<h1>Authorize MCP client</h1><p><strong>${clientName}</strong> is requesting access to this vault.</p><p>Scopes: <code>${scopes}</code></p><form method="post" action="/authorize"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Approve</button></form>`;
  return page("Authorize MCP client", body);
}

export type AdminView = {
  email: string;
  csrf: string;
  configured: boolean;
  vault?: string;
  remoteVaults?: Array<{ id?: string; name?: string }>;
  status?: unknown;
  git?: {
    configured: boolean;
    repository?: string;
    branch?: string;
    baseCommit?: string;
    mode?: "paused" | "active" | "quarantined";
    status?: {
      state?: string;
      blocked_reason?: string;
      error?: string;
      safety_event?: {
        event_id: string;
        phase: string;
        previous_files: number;
        candidate_files: number;
        deleted_files: number;
        previous_bytes: number;
        deleted_bytes: number;
        reasons: string[];
        paths: string[];
        path_count: number;
        restore_commit?: string;
      };
    };
  };
  githubConfigurationError?: string;
  message?: string;
  error?: string;
};

export function adminPage(view: AdminView): Response {
  const runtime =
    view.status && typeof view.status === "object"
      ? (view.status as { runtime?: { state?: unknown } }).runtime
      : undefined;
  const verifying = runtime?.state === "verifying";
  const feedback = view.error
    ? `<p class="error">${escapeHtml(view.error)}</p>`
    : view.message
      ? `<p class="notice">${escapeHtml(view.message)}</p>`
      : "";
  const verificationNotice = verifying
    ? `<p class="notice">A destructive-looking Sync observation is being rechecked independently. Vault writes and Git reconciliation remain paused until the next scheduled pass confirms or clears it.</p>`
    : "";
  const vaultOptions = (view.remoteVaults ?? [])
    .map((vault) => {
      const value = vault.id ?? vault.name ?? "";
      const label = vault.name
        ? `${vault.name}${vault.id ? ` (${vault.id})` : ""}`
        : value;
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const setup = view.configured
    ? `<p>Configured vault: <strong>${escapeHtml(view.vault ?? "unknown")}</strong></p><pre>${escapeHtml(JSON.stringify(view.status ?? {}, null, 2))}</pre><form method="post" action="/admin/reset"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><label>Type <code>RESET</code> to remove the local configuration</label><input name="confirmation" required><button type="submit">Reset local configuration</button></form>`
    : vaultOptions
      ? `<h2>Select remote vault</h2><form method="post" action="/admin/configure"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><label>Remote vault</label><select name="vault" required>${vaultOptions}</select><label>E2E password (leave empty for managed encryption)</label><input type="password" name="vault_password" autocomplete="off"><button type="submit">Configure and synchronize</button></form>`
      : `<h2>Sign in to Obsidian Sync</h2><p>Account password and MFA are passed once to the private container and are never retained.</p><form method="post" action="/admin/obsidian-login"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><label>Email</label><input type="email" name="email" required autocomplete="username"><label>Password</label><input type="password" name="password" required autocomplete="current-password"><label>MFA code (if enabled)</label><input name="mfa" inputmode="numeric" autocomplete="one-time-code"><button type="submit">Sign in and list vaults</button></form>`;
  const git = view.git?.configured
    ? (() => {
        const event = view.git?.status?.safety_event;
        const eventControls = event
          ? `<section><h3>Reconciliation safety review</h3><p>Phase: <code>${escapeHtml(event.phase)}</code><br>Files: ${event.previous_files} → ${event.candidate_files}<br>Proposed deletions: ${event.deleted_files} files / ${event.deleted_bytes} bytes<br>Reasons: ${escapeHtml(event.reasons.join(", "))}</p><pre>${escapeHtml(event.paths.join("\n"))}</pre>${view.git?.mode === "quarantined" && event.path_count > event.paths.length ? `<p><a href="/admin/github/safety-manifest?event_id=${encodeURIComponent(event.event_id)}">Download the complete manifest</a></p>` : ""}<form method="post" action="/admin/github/safety"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="event_id" value="${escapeHtml(event.event_id)}"><button name="action" value="approve" type="submit">Approve this exact candidate</button>${view.git?.mode === "quarantined" ? `<button name="action" value="reject" type="submit">Reject and republish safe vault</button>` : ""}</form>${view.git?.mode === "quarantined" ? `<form method="post" action="/admin/github/safety-refresh"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="event_id" value="${escapeHtml(event.event_id)}"><button type="submit">Refresh this preview</button></form>` : ""}</section>`
          : "";
        const activeControls = verifying
          ? ""
          : view.git?.mode === "active"
            ? `<form method="post" action="/admin/github/reconcile"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button type="submit">Reconcile now</button></form>`
            : view.git?.mode === "paused" && view.git.baseCommit && !event
              ? `<form method="post" action="/admin/github/reconcile"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button type="submit">Run manual reconciliation</button></form><form method="post" action="/admin/github/enable"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button type="submit">Enable one-minute schedule</button></form>`
              : !event
                ? `<form method="post" action="/admin/github/preview"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button type="submit">Preview initial reconciliation</button></form>`
                : "";
        return `<h2>GitHub backup and reconciliation</h2><p>Repository: <strong>${escapeHtml(view.git?.repository ?? "unknown")}</strong><br>Branch: <code>${escapeHtml(view.git?.branch ?? "unknown")}</code><br>Mode: <code>${escapeHtml(view.git?.mode ?? "paused")}</code><br>Base: <code>${escapeHtml(view.git?.baseCommit ?? "not established")}</code></p><pre>${escapeHtml(JSON.stringify(view.git?.status ?? {}, null, 2))}</pre>${eventControls}${activeControls}<form method="post" action="/admin/github/restore"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><label>Historical commit to restore as a safe union</label><input name="restore_commit" pattern="[a-f0-9]{40,64}" required><button type="submit">Preview historical recovery</button></form>${view.git?.status?.blocked_reason === "history_rewritten" || view.git?.status?.blocked_reason === "branch_deleted" ? `<form method="post" action="/admin/github/resolve"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button name="resolution" value="adopt_remote" type="submit">${view.git.status.blocked_reason === "branch_deleted" ? "Recreate branch from vault" : "Adopt rewritten remote"}</button>${view.git.status.blocked_reason === "history_rewritten" ? `<button name="resolution" value="reconnect_base" type="submit">Reconnect previous backup</button>` : ""}</form>` : ""}<form method="post" action="/admin/github/disconnect"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button type="submit">Disconnect GitHub repository</button></form>`;
      })()
    : view.githubConfigurationError
      ? `<h2>GitHub backup and reconciliation</h2><p class="error">${escapeHtml(view.githubConfigurationError)}</p>`
      : `<h2>GitHub backup and reconciliation</h2><p>Connect a separately authorized GitHub App and select its repository.</p><p><a href="/admin/github/connect">Connect GitHub</a></p>`;
  return page(
    "Vault administration",
    `<h1>Vault administration</h1><p>Signed in through Cloudflare Access as ${escapeHtml(view.email)}.</p>${feedback}${verificationNotice}${setup}${git}`,
  );
}

export function githubRepositoryPage(input: {
  email: string;
  csrf: string;
  state: string;
  repositories: Array<{
    fullName: string;
    defaultBranch: string;
    private: boolean;
  }>;
  installUrl: string;
}): Response {
  if (input.repositories.length === 0)
    return page(
      "Install GitHub App",
      `<h1>Install the GitHub App</h1><p>No accessible installations or repositories were found.</p><p><a href="${escapeHtml(input.installUrl)}">Install or update repository access on GitHub</a></p><p><a href="/admin">Return to administration</a></p>`,
    );
  const options = input.repositories
    .map(
      (repository, index) =>
        `<option value="${index}">${escapeHtml(repository.fullName)}${repository.private ? " (private)" : ""} — default ${escapeHtml(repository.defaultBranch)}</option>`,
    )
    .join("");
  return page(
    "Select GitHub repository",
    `<h1>Select GitHub repository</h1><p>Connected as ${escapeHtml(input.email)}. The temporary GitHub user token is encrypted, expires after ten minutes, and is discarded after branch listing.</p><form method="post" action="/admin/github/repository"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><input type="hidden" name="github_state" value="${escapeHtml(input.state)}"><label>Repository</label><select name="repository_index" required>${options}</select><button type="submit">Choose branch</button></form>`,
  );
}

export function githubBranchPage(input: {
  email: string;
  csrf: string;
  state: string;
  repository: string;
  branches: string[];
}): Response {
  const branchControl = input.branches.length
    ? `<select name="branch" required>${input.branches.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join("")}</select>`
    : `<input type="hidden" name="branch" value="main"><p>This repository is empty; the server will initialize <code>main</code>.</p>`;
  return page(
    "Select GitHub branch",
    `<h1>Select GitHub branch</h1><p>Repository: <strong>${escapeHtml(input.repository)}</strong><br>Connected as ${escapeHtml(input.email)}. Reconciliation will remain paused until its initial candidate is reviewed.</p><form method="post" action="/admin/github/configure"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><input type="hidden" name="github_state" value="${escapeHtml(input.state)}"><label>Branch</label>${branchControl}<button type="submit">Configure paused Git reconciliation</button></form>`,
  );
}

export function errorPage(message: string, status = 400): Response {
  const response = page(
    "Request failed",
    `<h1>Request failed</h1><p class="error">${escapeHtml(message)}</p><p><a href="/">Return home</a></p>`,
  );
  return new Response(response.body, { status, headers: response.headers });
}
