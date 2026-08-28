import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { watch, type FSWatcher } from "chokidar";
import mime from "mime-types";
import YAML from "yaml";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  VaultOperationError,
  type FileKind,
} from "./protocol.js";
import { normalizeVaultPath } from "./path-policy.js";

type Scalar = string | number | boolean;
type NoteMetadata = {
  title: string;
  headings: string[];
  frontmatter: Record<string, Scalar>;
  tags: string[];
};

type IndexedFileRow = {
  path: string;
  kind: FileKind;
  mime_type: string;
  size: number;
  mtime_ms: number;
  revision: string;
  title: string | null;
  headings_json: string | null;
  frontmatter_json: string | null;
  tags_json: string | null;
};

const IGNORED_DIRECTORIES = new Set([".obsidian", ".obsidian-sync-mcp"]);

export function revisionOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function flattenFrontmatter(value: unknown): Record<string, Scalar> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, Scalar> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      result[key] = item;
  }
  return result;
}

function noteMetadata(relativePath: string, body: string): NoteMetadata {
  let frontmatter: Record<string, Scalar> = {};
  let rawFrontmatter: Record<string, unknown> = {};
  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(body);
    if (match?.[1]) {
      try {
        const parsed = YAML.parse(match[1]) as unknown;
        rawFrontmatter =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        frontmatter = flattenFrontmatter(rawFrontmatter);
      } catch {
        frontmatter = {};
        rawFrontmatter = {};
      }
    }
  }
  const headings = Array.from(
    body.matchAll(/^#{1,6}\s+(.+)$/gmu),
    (match) => match[1]?.trim() ?? "",
  ).filter(Boolean);
  const inlineTags = Array.from(
    body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gmu),
    (match) => match[1]?.toLocaleLowerCase("en-US") ?? "",
  ).filter(Boolean);
  const frontmatterTag = rawFrontmatter.tags;
  const frontmatterTags = (
    Array.isArray(frontmatterTag)
      ? frontmatterTag.filter((tag): tag is string => typeof tag === "string")
      : typeof frontmatterTag === "string"
        ? frontmatterTag.split(/[\s,]+/u)
        : []
  ).map((tag) => tag.replace(/^#/u, "").toLocaleLowerCase("en-US"));
  const tags = Array.from(
    new Set([...inlineTags, ...frontmatterTags].filter(Boolean)),
  );
  const title =
    typeof frontmatter.title === "string"
      ? frontmatter.title
      : (headings[0] ?? path.posix.basename(relativePath, ".md"));
  return { title, headings, frontmatter, tags };
}

function wikilinks(body: string): string[] {
  return Array.from(
    body.matchAll(/\[\[([^\]]+)\]\]/gu),
    (match) => match[1]?.split("|")[0]?.split("#")[0]?.trim() ?? "",
  ).filter(Boolean);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown };
    if (
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    )
      throw new Error("invalid");
    return parsed.offset;
  } catch {
    throw new VaultOperationError("invalid_input", "Invalid pagination cursor");
  }
}

function ftsQuery(query: string, match: "all" | "phrase"): string {
  const tokens = query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  if (tokens.length === 0)
    throw new VaultOperationError(
      "invalid_input",
      "Search query must contain text",
    );
  return match === "phrase"
    ? `"${query.trim().replaceAll('"', '""')}"`
    : tokens.join(" AND ");
}

export class VaultIndexer {
  readonly db: Database.Database;
  private watcher: FSWatcher | null = null;
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly vaultRoot: string,
    indexPath: string,
  ) {
    this.db = new Database(indexPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY COLLATE BINARY,
        kind TEXT NOT NULL CHECK(kind IN ('note', 'attachment')),
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        revision TEXT NOT NULL,
        title TEXT,
        headings_json TEXT,
        frontmatter_json TEXT,
        tags_json TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(path UNINDEXED, title, body, headings, frontmatter, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS tags (path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(path, tag));
      CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag, path);
      CREATE TABLE IF NOT EXISTS properties (path TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(path, key));
      CREATE INDEX IF NOT EXISTS properties_lookup_idx ON properties(key, value, path);
      CREATE TABLE IF NOT EXISTS links (source TEXT NOT NULL, raw TEXT NOT NULL, target TEXT, resolved INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS links_source_idx ON links(source);
      CREATE INDEX IF NOT EXISTS links_target_idx ON links(target, resolved);
    `);
  }

  async rebuild(): Promise<void> {
    this.db.exec(
      "BEGIN IMMEDIATE; DELETE FROM links; DELETE FROM properties; DELETE FROM tags; DELETE FROM note_fts; DELETE FROM files; COMMIT;",
    );
    const files = await this.walk(this.vaultRoot);
    for (const absolute of files) await this.indexAbsolute(absolute, false);
    this.resolveAllLinks();
  }

  private async walk(directory: string): Promise<string[]> {
    const result: string[] = [];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))
      )
        continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await this.walk(absolute)));
      else if (entry.isFile()) result.push(absolute);
    }
    return result;
  }

  async indexPath(relative: string): Promise<void> {
    const normalized = normalizeVaultPath(relative);
    await this.indexAbsolute(
      path.join(this.vaultRoot, ...normalized.split("/")),
      true,
    );
  }

  private async indexAbsolute(
    absolute: string,
    resolveLinks: boolean,
  ): Promise<void> {
    const relative = path
      .relative(this.vaultRoot, absolute)
      .split(path.sep)
      .join("/")
      .normalize("NFC");
    let stats;
    try {
      stats = await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.removePath(relative);
        return;
      }
      throw error;
    }
    if (!stats.isFile()) return;
    const data = await readFile(absolute);
    const note =
      path.posix.extname(relative).toLocaleLowerCase("en-US") === ".md";
    const mimeType = note
      ? "text/markdown"
      : mime.lookup(relative) || "application/octet-stream";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.removePath(relative, false);
      if (note) {
        const body = data.toString("utf8");
        const metadata = noteMetadata(relative, body);
        this.db
          .prepare(
            "INSERT INTO files VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            relative,
            mimeType,
            data.byteLength,
            stats.mtimeMs,
            revisionOf(data),
            metadata.title,
            JSON.stringify(metadata.headings),
            JSON.stringify(metadata.frontmatter),
            JSON.stringify(metadata.tags),
          );
        this.db
          .prepare(
            "INSERT INTO note_fts (path, title, body, headings, frontmatter) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            relative,
            metadata.title,
            body,
            metadata.headings.join("\n"),
            Object.entries(metadata.frontmatter)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join("\n"),
          );
        const insertTag = this.db.prepare(
          "INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)",
        );
        for (const tag of metadata.tags) insertTag.run(relative, tag);
        const insertProperty = this.db.prepare(
          "INSERT OR REPLACE INTO properties (path, key, value) VALUES (?, ?, ?)",
        );
        for (const [key, value] of Object.entries(metadata.frontmatter))
          insertProperty.run(relative, key, String(value));
        const insertLink = this.db.prepare(
          "INSERT INTO links (source, raw, target, resolved) VALUES (?, ?, NULL, 0)",
        );
        for (const link of wikilinks(body)) insertLink.run(relative, link);
      } else {
        this.db
          .prepare(
            "INSERT INTO files (path, kind, mime_type, size, mtime_ms, revision) VALUES (?, 'attachment', ?, ?, ?, ?)",
          )
          .run(
            relative,
            mimeType,
            data.byteLength,
            stats.mtimeMs,
            revisionOf(data),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (resolveLinks) this.resolveAllLinks();
  }

  removePath(relative: string, resolveLinks = true): void {
    const remove = this.db.transaction((target: string) => {
      this.db.prepare("DELETE FROM note_fts WHERE path = ?").run(target);
      this.db.prepare("DELETE FROM tags WHERE path = ?").run(target);
      this.db.prepare("DELETE FROM properties WHERE path = ?").run(target);
      this.db.prepare("DELETE FROM links WHERE source = ?").run(target);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(target);
      this.db
        .prepare(
          "UPDATE links SET target = NULL, resolved = 0 WHERE target = ?",
        )
        .run(target);
    });
    remove(relative);
    if (resolveLinks) this.resolveAllLinks();
  }

  private resolveAllLinks(): void {
    const links = this.db
      .prepare("SELECT rowid, source, raw FROM links")
      .all() as Array<{ rowid: number; source: string; raw: string }>;
    const exact = this.db.prepare(
      "SELECT path FROM files WHERE kind = 'note' AND path = ? COLLATE NOCASE LIMIT 1",
    );
    const byBase = this.db.prepare(
      "SELECT path FROM files WHERE kind = 'note' AND lower(path) LIKE ? ORDER BY path LIMIT 2",
    );
    const update = this.db.prepare(
      "UPDATE links SET target = ?, resolved = ? WHERE rowid = ?",
    );
    const transaction = this.db.transaction(() => {
      for (const link of links) {
        const raw = link.raw.replaceAll("\\", "/").normalize("NFC");
        const targetWithExtension = raw
          .toLocaleLowerCase("en-US")
          .endsWith(".md")
          ? raw
          : `${raw}.md`;
        const relativeCandidate = path.posix.normalize(
          path.posix.join(path.posix.dirname(link.source), targetWithExtension),
        );
        const rootCandidate = path.posix
          .normalize(targetWithExtension)
          .replace(/^\.\//u, "");
        const direct = (exact.get(relativeCandidate) ??
          exact.get(rootCandidate)) as { path: string } | undefined;
        let resolved = direct?.path;
        if (!resolved && !raw.includes("/")) {
          const matches = byBase.all(
            `%/${targetWithExtension.toLocaleLowerCase("en-US")}`,
          ) as Array<{ path: string }>;
          if (matches.length === 1) resolved = matches[0]?.path;
          if (!resolved) {
            const root = exact.get(targetWithExtension) as
              { path: string } | undefined;
            resolved = root?.path;
          }
        }
        update.run(resolved ?? null, resolved ? 1 : 0, link.rowid);
      }
    });
    transaction();
  }

  startWatching(): void {
    if (this.watcher) return;
    this.watcher = watch(this.vaultRoot, {
      ignoreInitial: true,
      ignored: (watchedPath) =>
        watchedPath
          .split(path.sep)
          .some((segment) =>
            IGNORED_DIRECTORIES.has(segment.toLocaleLowerCase("en-US")),
          ),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    });
    const schedule = (absolute: string, removed: boolean) => {
      const relative = path
        .relative(this.vaultRoot, absolute)
        .split(path.sep)
        .join("/");
      if (!relative || relative.startsWith("../")) return;
      const task = (
        removed
          ? Promise.resolve(this.removePath(relative))
          : this.indexPath(relative)
      )
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: "vault_index_error",
              path: relative,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
        })
        .finally(() => this.pending.delete(task));
      this.pending.add(task);
    };
    this.watcher.on("add", (file) => schedule(file, false));
    this.watcher.on("change", (file) => schedule(file, false));
    this.watcher.on("unlink", (file) => schedule(file, true));
  }

  async stopWatching(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
    await this.flush();
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  file(relative: string): IndexedFileRow | null {
    return (
      (this.db.prepare("SELECT * FROM files WHERE path = ?").get(relative) as
        IndexedFileRow | undefined) ?? null
    );
  }

  counts(): { files: number; notes: number; attachments: number } {
    return this.db
      .prepare(
        "SELECT COUNT(*) files, COALESCE(SUM(kind = 'note'), 0) notes, COALESCE(SUM(kind = 'attachment'), 0) attachments FROM files",
      )
      .get() as {
      files: number;
      notes: number;
      attachments: number;
    };
  }

  list(input: {
    prefix?: string;
    file_kind?: FileKind;
    extension?: string;
    mime_type?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = decodeCursor(input.cursor);
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.prefix) {
      where.push("path LIKE ? ESCAPE '\\'");
      parameters.push(
        `${input.prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
      );
    }
    if (input.file_kind) {
      where.push("kind = ?");
      parameters.push(input.file_kind);
    }
    if (input.extension) {
      where.push("lower(path) LIKE ?");
      parameters.push(
        `%.${input.extension.replace(/^\./u, "").toLocaleLowerCase("en-US")}`,
      );
    }
    if (input.mime_type) {
      where.push("mime_type = ?");
      parameters.push(input.mime_type);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT path, kind, mime_type, size, mtime_ms, revision FROM files ${clause} ORDER BY path LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit + 1, offset);
    return {
      items: rows.slice(0, limit),
      ...(rows.length > limit ? { cursor: encodeCursor(offset + limit) } : {}),
    };
  }

  search(input: {
    query: string;
    match?: "all" | "phrase";
    prefix?: string;
    tags?: string[];
    properties?: Record<string, Scalar>;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = decodeCursor(input.cursor);
    const where = ["note_fts MATCH ?"];
    const parameters: Array<string | number> = [
      ftsQuery(input.query, input.match ?? "all"),
    ];
    if (input.prefix) {
      where.push("f.path LIKE ? ESCAPE '\\'");
      parameters.push(
        `${input.prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
      );
    }
    for (const tag of input.tags ?? []) {
      where.push(
        "EXISTS (SELECT 1 FROM tags t WHERE t.path = f.path AND t.tag = ?)",
      );
      parameters.push(tag.replace(/^#/u, "").toLocaleLowerCase("en-US"));
    }
    for (const [key, value] of Object.entries(input.properties ?? {})) {
      where.push(
        "EXISTS (SELECT 1 FROM properties p WHERE p.path = f.path AND p.key = ? AND p.value = ?)",
      );
      parameters.push(key, String(value));
    }
    const rows = this.db
      .prepare(
        `SELECT f.path, f.title, f.revision, f.tags_json, f.frontmatter_json, bm25(note_fts) AS score,
          snippet(note_fts, 2, '[', ']', '…', 32) AS snippet
         FROM note_fts JOIN files f ON f.path = note_fts.path
         WHERE ${where.join(" AND ")} ORDER BY score, f.path LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit + 1, offset) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map((row) => ({
      ...row,
      tags: JSON.parse(String(row.tags_json ?? "[]")) as string[],
      frontmatter: JSON.parse(String(row.frontmatter_json ?? "{}")) as Record<
        string,
        Scalar
      >,
      tags_json: undefined,
      frontmatter_json: undefined,
    }));
    return {
      items,
      ...(rows.length > limit ? { cursor: encodeCursor(offset + limit) } : {}),
    };
  }

  links(relative: string) {
    const outgoing = this.db
      .prepare(
        "SELECT raw, target, resolved FROM links WHERE source = ? ORDER BY raw",
      )
      .all(relative);
    const backlinks = this.db
      .prepare(
        "SELECT source, raw FROM links WHERE target = ? AND resolved = 1 ORDER BY source",
      )
      .all(relative);
    const unresolved = this.db
      .prepare(
        "SELECT raw FROM links WHERE source = ? AND resolved = 0 ORDER BY raw",
      )
      .all(relative);
    return { outgoing, backlinks, unresolved };
  }

  close(): void {
    this.db.close();
  }
}
