import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const variableNames = [
  "MCP_ALLOWED_HOSTNAMES",
  "ACCESS_CLIENT_ID",
  "ACCESS_AUTHORIZATION_URL",
  "ACCESS_TOKEN_URL",
  "ACCESS_JWKS_URL",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
];

const [command, ...commandArguments] = process.argv.slice(2);
if (command !== "dev" && command !== "deploy") {
  console.error(
    "Usage: node scripts/wrangler-with-vars.mjs <dev|deploy> [wrangler options]",
  );
  process.exit(1);
}

const variablesPath = resolve(process.env.WORKER_VARS_FILE ?? ".env");
if (!existsSync(variablesPath)) {
  console.error(
    `Missing ${variablesPath}. Copy .env.example to .env and configure the local non-secret Worker variables.`,
  );
  process.exit(1);
}

const fileVariables = parseEnv(readFileSync(variablesPath, "utf8"));
const wranglerVariables = variableNames.flatMap((name) => {
  const value = process.env[name] ?? fileVariables[name];
  if (!value) {
    console.error(`Missing ${name} in ${variablesPath}.`);
    process.exitCode = 1;
    return [];
  }
  return ["--var", `${name}:${value}`];
});

if (process.exitCode) process.exit(process.exitCode);

const wranglerPath = resolve("node_modules/wrangler/bin/wrangler.js");
const environmentFileArguments =
  command === "dev" ? ["--env-file", variablesPath] : [];
const result = spawnSync(
  process.execPath,
  [
    wranglerPath,
    command,
    ...environmentFileArguments,
    ...wranglerVariables,
    ...commandArguments,
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
