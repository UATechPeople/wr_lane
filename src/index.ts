import { Elysia, t } from "elysia";
import { config } from "./config";
import index from "../public/index.html";
import { encryptPhone, decryptToken } from "./fpe";
import {
  insertNumbers,
  listNumbers,
  getNumber,
  updateNumber,
  deleteNumber,
  allTokens,
  allRecords,
  countNumbers,
  markPushed,
  type NewNumber,
} from "./db";
import { pushRecords } from "./platform";
import { parseRecords, previewFile, type UploadRecord, type HeaderMap } from "./upload";

function coerceHeaderMap(hm: unknown): HeaderMap | undefined {
  if (!hm) return undefined;
  if (typeof hm === "string") return JSON.parse(hm) as HeaderMap;
  return hm as HeaderMap;
}

type IngestRow = { real: string; token: string | null; ok: boolean; error?: string };

// Tokenize the phone of each record and store the full player row. Shared by the
// JSON, file-upload, and (single) create paths.
function ingest(records: UploadRecord[]): { accepted: number; total: number; rows: IngestRow[] } {
  const ok: NewNumber[] = [];
  const rows: IngestRow[] = records.map((rec) => {
    try {
      const token = encryptPhone(rec.phone);
      ok.push({
        real: rec.phone,
        token,
        external_id: rec.external_id,
        first_name: rec.first_name,
        last_name: rec.last_name,
        country: rec.country,
        language: rec.language,
        segment: rec.segment,
        cohort: rec.cohort,
      });
      return { real: rec.phone, token, ok: true };
    } catch (e) {
      return { real: rec.phone, token: null, ok: false, error: String((e as Error).message) };
    }
  });
  insertNumbers(ok);
  return { accepted: ok.length, total: rows.length, rows };
}

const metaBody = {
  external_id: t.Optional(t.String()),
  first_name: t.Optional(t.String()),
  last_name: t.Optional(t.String()),
  country: t.Optional(t.String()),
  language: t.Optional(t.String()),
  segment: t.Optional(t.String()),
  cohort: t.Optional(t.String()),
};

// HTTP Basic Auth for operator endpoints. Disabled when creds are unset (dev).
function checkBasicAuth(header?: string): boolean {
  const { user, pass } = config.auth;
  if (!user || !pass) return true;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  const i = decoded.indexOf(":");
  return decoded.slice(0, i) === user && decoded.slice(i + 1) === pass;
}

const api = new Elysia({ prefix: "/api" })
  .onBeforeHandle(({ request, headers, set }) => {
    // /api/decrypt is machine-to-machine (kamailio) — guarded by X-Decrypt-Key, not Basic Auth.
    if (new URL(request.url).pathname.endsWith("/decrypt")) return;
    if (!checkBasicAuth(headers.authorization)) {
      set.status = 401;
      set.headers["WWW-Authenticate"] = 'Basic realm="Hidden Numbers Cabinet"';
      return { error: "unauthorized" };
    }
  })
  // Create from a JSON list of phones (paste box).
  .post("/numbers", ({ body }) => ingest(body.numbers.map((p) => ({ phone: p }))), {
    body: t.Object({ numbers: t.Array(t.String()) }),
  })

  // Create from an uploaded CSV / XLSX file (multipart field `file`). Captures all
  // documented columns; see README for the format.
  .post(
    "/numbers/upload",
    async ({ body, set }) => {
      try {
        const records = parseRecords(await body.file.arrayBuffer(), coerceHeaderMap(body.header_map));
        if (records.length === 0) {
          set.status = 422;
          return { error: "no phone column found / file empty" };
        }
        return { filename: body.file.name, ...ingest(records) };
      } catch (e) {
        set.status = 400;
        return { error: `could not parse file: ${String((e as Error).message)}` };
      }
    },
    { body: t.Object({ file: t.File(), header_map: t.Optional(t.Any()) }) },
  )

  // Preview a file (headers + auto-detected mapping + sample rows) WITHOUT storing —
  // drives the UI column mapper.
  .post(
    "/numbers/preview",
    async ({ body, set }) => {
      try {
        return previewFile(await body.file.arrayBuffer(), coerceHeaderMap(body.header_map));
      } catch (e) {
        set.status = 400;
        return { error: `could not parse file: ${String((e as Error).message)}` };
      }
    },
    { body: t.Object({ file: t.File(), header_map: t.Optional(t.Any()) }) },
  )

  // Paginated list. ?limit=&offset= (limit capped at 500).
  .get(
    "/numbers",
    ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 500);
      const offset = Math.max(Number(query.offset ?? 0), 0);
      const q = query.q;
      return { total: countNumbers(q), limit, offset, numbers: listNumbers(limit, offset, q) };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()), q: t.Optional(t.String()) }) },
  )

  .get("/numbers/:id", ({ params, set }) => {
    const row = getNumber(Number(params.id));
    if (!row) {
      set.status = 404;
      return { error: "not found" };
    }
    return row;
  })

  // Update: any subset of fields. Changing `real` re-encrypts -> new token.
  .patch(
    "/numbers/:id",
    ({ params, body, set }) => {
      const id = Number(params.id);
      if (!getNumber(id)) {
        set.status = 404;
        return { error: "not found" };
      }
      const patch: Partial<NewNumber> = { ...body };
      if (body.real !== undefined) {
        try {
          patch.token = encryptPhone(body.real);
        } catch (e) {
          set.status = 422;
          return { error: String((e as Error).message) };
        }
      }
      try {
        updateNumber(id, patch);
      } catch {
        set.status = 409;
        return { error: "number or token already exists" };
      }
      return getNumber(id);
    },
    { body: t.Object({ real: t.Optional(t.String()), ...metaBody }) },
  )

  .delete("/numbers/:id", ({ params, set }) => {
    if (!deleteNumber(Number(params.id))) {
      set.status = 404;
      return { error: "not found" };
    }
    return { deleted: true };
  })

  // Tokens to ship to Platform (drop into `phone_e164`).
  .get("/export", () => ({ tokens: allTokens() }))

  // Push the whole base to Platform as player events. Idempotent (WR dedupes on event_id).
  .post("/push", async ({ set }) => {
    try {
      const results = await pushRecords(allRecords());
      const sentTokens = results.filter((r) => r.ok).map((r) => r.token);
      markPushed(sentTokens);
      return {
        sent: sentTokens.length,
        deduped: results.filter((r) => r.deduped).length,
        failed: results.filter((r) => !r.ok).length,
        total: results.length,
        results,
      };
    } catch (e) {
      set.status = 400;
      return { error: String((e as Error).message) };
    }
  })

  // Called on the egress SIP leg: token -> real number. Stateless (FF3).
  .get(
    "/decrypt",
    ({ query, headers, set }) => {
      if (headers["x-decrypt-key"] !== config.decryptKey) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      try {
        return { phone: decryptToken(query.t) };
      } catch (e) {
        set.status = 422;
        return { error: "bad token", detail: String((e as Error).message) };
      }
    },
    { query: t.Object({ t: t.String() }) },
  );

const app = new Elysia().get("/health", () => ({ ok: true, count: countNumbers() })).use(api);

// React lives inside this app: the HTML import makes Bun bundle public/index.tsx (and
// App.tsx, React, …) — no Vite, no separate build. Bun.serve routes "/" to the bundled
// SPA and falls through to Elysia for the API. `development` adds HMR.
Bun.serve({
  port: config.port,
  development: process.env.NODE_ENV !== "production",
  routes: { "/": index },
  fetch: app.fetch,
});

console.log(`[hidden-numbers] cabinet listening on :${config.port}`);
if (!config.auth.user || !config.auth.pass) {
  console.warn("[hidden-numbers] ⚠ Basic Auth DISABLED — set CABINET_USER and CABINET_PASSWORD to protect the cabinet.");
}

export type App = typeof app;
