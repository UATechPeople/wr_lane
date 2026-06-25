import { Database } from "bun:sqlite";
import { config } from "./config";

// The cabinet base. This is the ONLY place real numbers live — entirely client-side.
// We store the full player record (external_id, name, country, language, segment,
// cohort) so it can be pushed to WinRiders as-is; only `real` is secret, and only its
// `token` ever leaves. Decryption does NOT read this table (FF3-1 reverses from the key).
const db = new Database(config.dbPath);
db.run(`
  CREATE TABLE IF NOT EXISTS numbers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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

const COLS =
  "id, real, token, external_id, first_name, last_name, country, language, segment, cohort, created_at, pushed_at";

const META_FIELDS = ["external_id", "first_name", "last_name", "country", "language", "segment", "cohort"] as const;

export function insertNumbers(rows: NewNumber[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO numbers
       (real, token, external_id, first_name, last_name, country, language, segment, cohort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items: NewNumber[]) => {
    for (const r of items) {
      stmt.run(
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

function likeClause(q?: string): { sql: string; params: string[] } {
  if (!q || !q.trim()) return { sql: "", params: [] };
  const like = `%${q.trim()}%`;
  return { sql: " WHERE real LIKE ? OR token LIKE ? OR external_id LIKE ? OR segment LIKE ?", params: [like, like, like, like] };
}

export function listNumbers(limit = 50, offset = 0, q?: string): NumberRow[] {
  const w = likeClause(q);
  return db
    .query(`SELECT ${COLS} FROM numbers${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...w.params, limit, offset) as NumberRow[];
}

export function getNumber(id: number): NumberRow | null {
  return (db.query(`SELECT ${COLS} FROM numbers WHERE id = ?`).get(id) as NumberRow) ?? null;
}

export function allRecords(): NumberRow[] {
  return db.query(`SELECT ${COLS} FROM numbers ORDER BY id`).all() as NumberRow[];
}

// Patch any provided columns. If `real`/`token` change, push state is reset.
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
  const res = db.prepare(`UPDATE numbers SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as any[]));
  return res.changes > 0;
}

export function deleteNumber(id: number): boolean {
  return db.prepare("DELETE FROM numbers WHERE id = ?").run(id).changes > 0;
}

export function allTokens(): string[] {
  const rows = db.query("SELECT token FROM numbers ORDER BY id").all() as { token: string }[];
  return rows.map((r) => r.token);
}

export function markPushed(tokens: string[]): void {
  const stmt = db.prepare("UPDATE numbers SET pushed_at = datetime('now') WHERE token = ?");
  const tx = db.transaction((items: string[]) => {
    for (const t of items) stmt.run(t);
  });
  tx(tokens);
}

export function countNumbers(q?: string): number {
  const w = likeClause(q);
  return (db.query(`SELECT COUNT(*) AS n FROM numbers${w.sql}`).get(...w.params) as { n: number }).n;
}

export { db };
