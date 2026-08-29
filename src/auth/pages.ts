import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";

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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui;max-width:50rem;margin:3rem auto;padding:0 1rem;color:#1f2937}main{border:1px solid #d1d5db;border-radius:12px;padding:1.5rem}label{display:block;margin:.8rem 0 .25rem}input,select,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box}button{margin-top:1rem;cursor:pointer}code{background:#f3f4f6;padding:.15rem .3rem}nav a{margin-right:1rem}.notice{background:#fef3c7;padding:.75rem;border-radius:6px}.error{background:#fee2e2;padding:.75rem;border-radius:6px}</style></head><body><main>${body}</main></body></html>`,
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
  message?: string;
  error?: string;
};

export function adminPage(view: AdminView): Response {
  const feedback = view.error
    ? `<p class="error">${escapeHtml(view.error)}</p>`
    : view.message
      ? `<p class="notice">${escapeHtml(view.message)}</p>`
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
  return page(
    "Vault administration",
    `<h1>Vault administration</h1><p>Signed in through Cloudflare Access as ${escapeHtml(view.email)}.</p>${feedback}${setup}`,
  );
}

export function errorPage(message: string, status = 400): Response {
  const response = page(
    "Request failed",
    `<h1>Request failed</h1><p class="error">${escapeHtml(message)}</p><p><a href="/">Return home</a></p>`,
  );
  return new Response(response.body, { status, headers: response.headers });
}
