import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

export function resolveDataPaths() {
  const legacyDb = join(projectRoot, "backend/db/database.db");
  const dataDir = resolve(process.env.DATA_DIR ?? join(projectRoot, "data"));
  const useLegacy = !process.env.DATA_DIR;
  const dbPath = resolve(process.env.DATABASE_PATH ?? (useLegacy && existsSync(legacyDb) ? legacyDb : join(dataDir, "database.sqlite")));
  const legacyStorage = join(projectRoot, "backend/storage");
  const storagePath = resolve(process.env.STORAGE_PATH ?? (useLegacy && existsSync(legacyStorage) ? legacyStorage : join(dataDir, "storage")));
  return { dbPath, storagePath };
}

export function openDatabase(path = resolveDataPaths().dbPath) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    migrateDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrateDatabase(db: Database, migrationsDir = join(import.meta.dir, "db/migrations")) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const files = Array.from(new Bun.Glob("*.sql").scanSync({ cwd: migrationsDir })).sort();
  if (files.length === 0) throw new Error(`No SQL migrations found in ${migrationsDir}`);
  for (const file of files) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`Invalid migration filename: ${file}`);
  }
  const applied = db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>;
  for (const [index, row] of applied.entries()) {
    if (files[index] !== row.version) {
      throw new Error(`Migration history differs from the SQL files at ${row.version}`);
    }
  }
  for (const version of files) {
    const sql = readFileSync(join(migrationsDir, version), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = db.query("SELECT checksum FROM schema_migrations WHERE version = ?").get(version) as { checksum: string } | null;
    if (existing) {
      if (existing.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${version}`);
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(version, checksum, new Date().toISOString());
    })();
  }
}
