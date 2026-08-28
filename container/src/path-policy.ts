import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { VaultOperationError } from "./protocol.js";

const PROTECTED_TOP_LEVEL = new Set([".obsidian", ".obsidian-sync-mcp"]);

export function normalizeVaultPath(input: string): string {
  if (!input || input.includes("\0") || input.includes("\\"))
    throw new VaultOperationError(
      "invalid_path",
      "Path is empty or contains forbidden characters",
    );
  const normalized = input.normalize("NFC");
  if (path.posix.isAbsolute(normalized))
    throw new VaultOperationError(
      "invalid_path",
      "Absolute paths are not allowed",
    );
  if (
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new VaultOperationError(
      "invalid_path",
      "Traversal path segments are not allowed",
    );
  const clean = path.posix.normalize(normalized).replace(/^\.\//u, "");
  if (!clean || clean === "." || clean === ".." || clean.startsWith("../"))
    throw new VaultOperationError(
      "invalid_path",
      "Path must stay inside the vault",
    );
  const first = clean.split("/")[0]?.toLocaleLowerCase("en-US");
  if (first && PROTECTED_TOP_LEVEL.has(first))
    throw new VaultOperationError(
      "invalid_path",
      "The requested path is protected",
    );
  if (first?.startsWith("."))
    throw new VaultOperationError(
      "invalid_path",
      "Root-level hidden paths are not synchronized by Obsidian Headless",
    );
  return clean;
}

export function absoluteVaultPath(vaultRoot: string, relative: string): string {
  const normalized = normalizeVaultPath(relative);
  const absolute = path.resolve(vaultRoot, ...normalized.split("/"));
  const rootWithSeparator = `${path.resolve(vaultRoot)}${path.sep}`;
  if (!absolute.startsWith(rootWithSeparator))
    throw new VaultOperationError("invalid_path", "Path escapes the vault");
  return absolute;
}

export function requireNotePath(relative: string): string {
  const normalized = normalizeVaultPath(relative);
  if (path.posix.extname(normalized).toLocaleLowerCase("en-US") !== ".md")
    throw new VaultOperationError(
      "invalid_path",
      "Notes must use the .md extension",
    );
  return normalized;
}

export async function rejectSymlinkSegments(
  vaultRoot: string,
  relative: string,
): Promise<void> {
  const normalized = normalizeVaultPath(relative);
  let current = path.resolve(vaultRoot);
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new VaultOperationError(
          "invalid_path",
          "Symbolic links are not allowed in vault paths",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function rejectCaseCollision(
  vaultRoot: string,
  relative: string,
  ignore?: string,
): Promise<void> {
  const normalized = normalizeVaultPath(relative);
  let directory = path.resolve(vaultRoot);
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const collision = entries.find((entry) => {
      const normalizedEntry = entry.normalize("NFC");
      return (
        normalizedEntry.toLocaleLowerCase("en-US") ===
          segment.toLocaleLowerCase("en-US") && normalizedEntry !== segment
      );
    });
    const relativeCollision = collision
      ? [...segments.slice(0, index), collision].join("/")
      : undefined;
    if (collision && relativeCollision !== ignore)
      throw new VaultOperationError(
        "already_exists",
        `Case-insensitive path collision with ${relativeCollision}`,
      );
    directory = path.join(directory, segment);
  }
}
