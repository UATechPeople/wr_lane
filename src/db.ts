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

const ADDED_NUMBER_COLUMNS: Record<string, string> = {
  user_id: "TEXT",
  webhook_id: "TEXT",
  outcome: "TEXT",
  result: "TEXT",
  call_attempts: "INTEGER",
  result_at: "TEXT",
  delivery_status: "TEXT",
  delivered_at: "TEXT",
  delivery_error: "TEXT",
};

const presentColumns = new Set((db.query("PRAGMA table_info(numbers)").all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of Object.entries(ADDED_NUMBER_COLUMNS)) {
  if (!presentColumns.has(name)) db.run(`ALTER TABLE numbers ADD COLUMN ${name} ${type}`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    number_id    INTEGER NOT NULL,
    dedupe_key   TEXT NOT NULL UNIQUE,
    payload      TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_try_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_error   TEXT,
    delivered_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run("CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (delivered_at, next_try_at)");

const ADDED_OUTBOX_COLUMNS: Record<string, string> = { url: "TEXT" };

const presentOutboxColumns = new Set((db.query("PRAGMA table_info(outbox)").all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of Object.entries(ADDED_OUTBOX_COLUMNS)) {
  if (!presentOutboxColumns.has(name)) db.run(`ALTER TABLE outbox ADD COLUMN ${name} ${type}`);
}

export type NumberRow = {
  id: number;
  upload_id: number | null;
  real: string;
  token: string;
  user_id: string | null;
  webhook_id: string | null;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  language: string | null;
  segment: string | null;
  cohort: string | null;
  created_at: string;
  pushed_at: string | null;
  outcome: string | null;
  result: string | null;
  call_attempts: number | null;
  result_at: string | null;
  delivery_status: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
};

export type NewNumber = {
  real: string;
  token: string;
  user_id?: string;
  webhook_id?: string;
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
  "id, upload_id, real, token, user_id, webhook_id, external_id, first_name, last_name, country, language, segment, cohort, created_at, pushed_at, outcome, result, call_attempts, result_at, delivery_status, delivered_at, delivery_error";

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
    `INSERT INTO numbers
       (upload_id, real, token, user_id, webhook_id, external_id, first_name, last_name, country, language, segment, cohort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(real) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, numbers.user_id),
       webhook_id = COALESCE(excluded.webhook_id, numbers.webhook_id)`,
  );
  const tx = db.transaction((items: NewNumber[]) => {
    for (const r of items) {
      stmt.run(
        uploadId,
        r.real,
        r.token,
        r.user_id ?? null,
        r.webhook_id ?? null,
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
    conds.push("(real LIKE ? OR token LIKE ? OR user_id LIKE ? OR external_id LIKE ? OR segment LIKE ?)");
    params.push(like, like, like, like, like);
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

const META_FIELDS = ["user_id", "external_id", "first_name", "last_name", "country", "language", "segment", "cohort"] as const;

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

export function uploadIdByLabel(label: string): number {
  const row = db.query("SELECT id FROM uploads WHERE label = ? ORDER BY id LIMIT 1").get(label) as { id: number } | undefined;
  if (row) return row.id;
  return createUpload(label);
}

export function getByReal(real: string): NumberRow | null {
  return (db.query(`SELECT ${COLS} FROM numbers WHERE real = ?`).get(real) as NumberRow) ?? null;
}

export function getByToken(token: string): NumberRow | null {
  return (db.query(`SELECT ${COLS} FROM numbers WHERE token = ?`).get(token) as NumberRow) ?? null;
}

export type CallResult = {
  leadId: string | null;
  outcome: string | null;
  result: string | null;
  attempts: number | null;
};

export function recordCallResult(id: number, r: CallResult): void {
  db.prepare(
    `UPDATE numbers
       SET external_id = COALESCE(?, external_id),
           outcome = ?, result = ?, call_attempts = ?, result_at = datetime('now'),
           delivery_status = CASE WHEN ? IS NULL THEN delivery_status ELSE 'pending' END,
           delivery_error = NULL
     WHERE id = ?`,
  ).run(r.leadId, r.outcome, r.result, r.attempts, r.result, id);
}

export function setDeliveryState(id: number, status: string, error?: string | null): void {
  db.prepare(
    `UPDATE numbers
       SET delivery_status = ?,
           delivery_error = ?,
           delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END
     WHERE id = ?`,
  ).run(status, error ?? null, status, id);
}

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export type OutboxRow = {
  id: number;
  number_id: number;
  dedupe_key: string;
  payload: string;
  url: string | null;
  attempts: number;
  next_try_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
};

const OUTBOX_COLS = "id, number_id, dedupe_key, payload, url, attempts, next_try_at, last_error, delivered_at, created_at";

export function outboxEnqueue(numberId: number, dedupeKey: string, payload: unknown, url?: string | null): boolean {
  return (
    db
      .prepare("INSERT OR IGNORE INTO outbox (number_id, dedupe_key, payload, url) VALUES (?, ?, ?, ?)")
      .run(numberId, dedupeKey, JSON.stringify(payload), url ?? null).changes > 0
  );
}

export function outboxClaim(limit = 50, leaseSeconds = 300): OutboxRow[] {
  return db
    .query(
      `UPDATE outbox SET next_try_at = datetime('now', ?)
        WHERE id IN (
          SELECT id FROM outbox
           WHERE delivered_at IS NULL AND next_try_at <= datetime('now')
           ORDER BY next_try_at LIMIT ?
        )
        RETURNING ${OUTBOX_COLS}`,
    )
    .all(`+${leaseSeconds} seconds`, limit) as OutboxRow[];
}

export function outboxMarkDelivered(id: number): void {
  db.prepare("UPDATE outbox SET delivered_at = datetime('now'), last_error = NULL WHERE id = ?").run(id);
}

export function outboxMarkFailed(id: number, error: string, delaySeconds: number): void {
  db.prepare(
    `UPDATE outbox
       SET attempts = attempts + 1,
           last_error = ?,
           next_try_at = datetime('now', ?)
     WHERE id = ?`,
  ).run(error, `+${Math.max(1, Math.round(delaySeconds))} seconds`, id);
}

export function outboxRequeueForNumber(numberId: number): boolean {
  return (
    db
      .prepare("UPDATE outbox SET delivered_at = NULL, next_try_at = datetime('now'), attempts = 0 WHERE number_id = ?")
      .run(numberId).changes > 0
  );
}

export { db };
