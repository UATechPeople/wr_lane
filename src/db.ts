import { Database } from "bun:sqlite";
import { config } from "./config";

// The cabinet base. Real numbers live ONLY here (client-side). Numbers belong to an
// `upload` (a batch). Decryption does NOT read this table (FF3-1 reverses from the key);
// the base is kept for the operator UI, audit, CSV export, and push.
const db = new Database(config.dbPath);
db.run(`
  CREATE TABLE IF NOT EXISTS uploads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS numbers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id   INTEGER,
    real        TEXT NOT NULL UNIQUE,
    token       TEXT NOT NULL UNIQUE,
    external_id TEXT,
    first_name  TEXT,
    last_name   TEXT,
    country     TEXT,
    language    TEXT,
    segment     TEXT,
    cohort      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    pushed_at   TEXT
  )
`);

export type NumberRow = {
  id: number;
  upload_id: number | null;
  real: string;
  token: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  language: string | null;
  segment: string | null;
  cohort: string | null;
  created_at: string;
  pushed_at: string | null;
};

export type NewNumber = {
  real: string;
  token: string;
  external_id?: string;
  first_name?: string;
  last_name?: string;
  country?: string;
  language?: string;
  segment?: string;
  cohort?: string;
};

export type UploadRow = { id: number; label: string; created_at: string; count: number };

const COLS =
  "id, upload_id, real, token, external_id, first_name, last_name, country, language, segment, cohort, created_at, pushed_at";

// ── uploads ──────────────────────────────────────────────────────────────────

export function createUpload(label: string): number {
  return Number(db.prepare("INSERT INTO uploads (label) VALUES (?)").run(label).lastInsertRowid);
}

export function listUploads(): UploadRow[] {
  return db
    .query(
      `SELECT u.id, u.label, u.created_at, COUNT(n.id) AS count
       FROM uploads u LEFT JOIN numbers n ON n.upload_id = u.id
       GROUP BY u.id ORDER BY u.id DESC`,
    )
    .all() as UploadRow[];
}

export function getUpload(id: number): UploadRow | null {
  return (
    (db
      .query(
        `SELECT u.id, u.label, u.created_at, COUNT(n.id) AS count
         FROM uploads u LEFT JOIN numbers n ON n.upload_id = u.id
         WHERE u.id = ? GROUP BY u.id`,
      )
      .get(id) as UploadRow) ?? null
  );
}

export function deleteUpload(id: number): boolean {
  db.prepare("DELETE FROM numbers WHERE upload_id = ?").run(id);
  return db.prepare("DELETE FROM uploads WHERE id = ?").run(id).changes > 0;
}

export function rowsForUpload(id: number): NumberRow[] {
  return db.query(`SELECT ${COLS} FROM numbers WHERE upload_id = ? ORDER BY id`).all(id) as NumberRow[];
}

// ── numbers ──────────────────────────────────────────────────────────────────

export function insertNumbers(uploadId: number, rows: NewNumber[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO numbers
       (upload_id, real, token, external_id, first_name, last_name, country, language, segment, cohort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items: NewNumber[]) => {
    for (const r of items) {
      stmt.run(
        uploadId,
        r.real,
        r.token,
        r.external_id ?? null,
        r.first_name ?? null,
        r.last_name ?? null,
        r.country ?? null,
        r.language ?? null,
        r.segment ?? null,
        r.cohort ?? null,
      );
    }
  });
  tx(rows);
}

function filterClause(q?: string, uploadId?: number): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (uploadId != null && !Number.isNaN(uploadId)) {
    conds.push("upload_id = ?");
    params.push(uploadId);
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    conds.push("(real LIKE ? OR token LIKE ? OR external_id LIKE ? OR segment LIKE ?)");
    params.push(like, like, like, like);
  }
  return { sql: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
}

export function listNumbers(limit = 50, offset = 0, q?: string, uploadId?: number): NumberRow[] {
  const w = filterClause(q, uploadId);
  return db
    .query(`SELECT ${COLS} FROM numbers${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...(w.params as any[]), limit, offset) as NumberRow[];
}

export function countNumbers(q?: string, uploadId?: number): number {
  const w = filterClause(q, uploadId);
  return (db.query(`SELECT COUNT(*) AS n FROM numbers${w.sql}`).get(...(w.params as any[])) as { n: number }).n;
}

export function getNumber(id: number): NumberRow | null {
  return (db.query(`SELECT ${COLS} FROM numbers WHERE id = ?`).get(id) as NumberRow) ?? null;
}

export function allRecords(): NumberRow[] {
  return db.query(`SELECT ${COLS} FROM numbers ORDER BY id`).all() as NumberRow[];
}

const META_FIELDS = ["external_id", "first_name", "last_name", "country", "language", "segment", "cohort"] as const;

export function updateNumber(id: number, patch: Partial<NewNumber>): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.real !== undefined) {
    sets.push("real = ?");
    vals.push(patch.real);
  }
  if (patch.token !== undefined) {
    sets.push("token = ?");
    vals.push(patch.token);
  }
  for (const f of META_FIELDS) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(patch[f]);
    }
  }
  if (sets.length === 0) return false;
  sets.push("pushed_at = NULL");
  vals.push(id);
  return db.prepare(`UPDATE numbers SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as any[])).changes > 0;
}

export function deleteNumber(id: number): boolean {
  return db.prepare("DELETE FROM numbers WHERE id = ?").run(id).changes > 0;
}

export function markPushed(tokens: string[]): void {
  const stmt = db.prepare("UPDATE numbers SET pushed_at = datetime('now') WHERE token = ?");
  const tx = db.transaction((items: string[]) => {
    for (const t of items) stmt.run(t);
  });
  tx(tokens);
}

export { db };
