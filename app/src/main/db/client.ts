import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const OPENTRADE_HOME = process.env.OPENTRADE_HOME ?? join(homedir(), ".opentrade");

function ensureHome() {
  // 0700: the home holds plaintext broker tokens (no safeStorage under
  // ELECTRON_RUN_AS_NODE), so confidentiality rests on file permissions.
  if (!existsSync(OPENTRADE_HOME)) mkdirSync(OPENTRADE_HOME, { recursive: true, mode: 0o700 });
  const agentsDir = join(OPENTRADE_HOME, "agents");
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
  try {
    chmodSync(OPENTRADE_HOME, 0o700);
  } catch {
    // best-effort (e.g. not owner)
  }
}

/**
 * Open the app DB and create tables if missing. We use idempotent CREATE TABLE
 * statements here for M0 rather than migrations; drizzle-kit migrations land in M1+.
 */
export function createDb() {
  ensureHome();
  const dbPath = join(OPENTRADE_HOME, "app.db");
  const sqlite = new Database(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // best-effort
  }
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT 'default',
      approval_mode TEXT NOT NULL DEFAULT 'approve',
      last_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      parsed TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      note TEXT,
      outcome TEXT,
      requested_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_agent_at ON audit_log (agent_id, at);
    CREATE TABLE IF NOT EXISTS broker_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_fire_at INTEGER,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_agent ON schedules (agent_id);
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitors_agent ON monitors (agent_id);
    CREATE TABLE IF NOT EXISTS wakes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      background INTEGER NOT NULL,
      fired_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wakes_agent_fired ON wakes (agent_id, fired_at);
  `);

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
