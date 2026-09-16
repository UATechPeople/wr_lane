import { createHmac, timingSafeEqual } from "crypto";
import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config";
import { buildInfo } from "./version";
import { encryptPhone, decryptToken } from "./fpe";
import {
  createUpload,
  listUploads,
  getUpload,
  deleteUpload,
  rowsForUpload,
  insertNumbers,
  listNumbers,
  getNumber,
  updateNumber,
  deleteNumber,
  allRecords,
  countNumbers,
  type NewNumber,
} from "./db";
import { toCoreCsv } from "./csv";
import { fetchLeadTranscript, retryPushes, startPushRetryCron } from "./winriders";
import { parseRecords, previewFile, type UploadRecord, type HeaderMap } from "./upload";
import { hooks } from "./hooks";
import { drainOutbox, startOutboxCron } from "./outbox";
import { sendToCrm } from "./crm";
import {
  DEFAULT_CRM_CONFIG,
  buildResultBody,
  getCoreKey,
  getCrmConfig,
  getInboundKey,
  saveCrmConfig,
  getWrConfig,
  saveWrConfig,
  setCoreKey,
  setInboundKey,
  WR_SOURCE_FIELDS,
  WR_TARGET_FIELDS,
  TOKEN_ONLY_TARGETS,
} from "./webhook";
import {
  getRequest,
  outboxRequeueForCall,
  outboxRequeueForNumber,
  requestsForNumber,
  setDeliveryState,
  setRequestDeliveryState,
} from "./db";

function coerceHeaderMap(hm: unknown): HeaderMap | undefined {
  if (!hm) return undefined;
  if (typeof hm === "string") return JSON.parse(hm) as HeaderMap;
  return hm as HeaderMap;
}

type IngestRow = { real: string; token: string | null; ok: boolean; error?: string };

// Tokenize the phone of each record and store the full player row. Shared by the
// JSON, file-upload, and (single) create paths.
function ingest(records: UploadRecord[], label: string): { uploadId: number; accepted: number; total: number; rows: IngestRow[] } {
  const ok: NewNumber[] = [];
  const rows: IngestRow[] = records.map((rec) => {
    try {
      const token = encryptPhone(rec.phone);
      ok.push({
        real: rec.phone,
        token,
        user_id: rec.user_id,
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
  const uploadId = createUpload(label);
  insertNumbers(uploadId, ok);
  return { uploadId, accepted: ok.length, total: rows.length, rows };
}

const metaBody = {
  user_id: t.Optional(t.String()),
  external_id: t.Optional(t.String()),
  first_name: t.Optional(t.String()),
  last_name: t.Optional(t.String()),
  country: t.Optional(t.String()),
  language: t.Optional(t.String()),
  segment: t.Optional(t.String()),
  cohort: t.Optional(t.String()),
};

// Session auth: a signed, expiring httpOnly cookie (no server-side session store).
const SESSION_TTL_S = 7 * 24 * 3600;

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}
function secretEquals(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function makeToken(): string {
  const payload = Buffer.from(`${config.auth.user}:${Date.now() + SESSION_TTL_S * 1000}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token?: string): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !secretEquals(sign(payload), sig)) return false;
  const [user, exp] = Buffer.from(payload, "base64url").toString().split(":");
  return user === config.auth.user && Number(exp) > Date.now();
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

const api = new Elysia({ prefix: "/api" })
  // Session guard. /login and /decrypt are exempt; auth is off when no creds are set.
  .onBeforeHandle(({ request, headers, set }) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/login")) return;
    if (path.endsWith("/health") || path.endsWith("/up")) return;
    if (!config.auth.user || !config.auth.pass) return;
    if (!verifyToken(readCookie(headers.cookie, "cabinet_session"))) {
      set.status = 401;
      return { error: "unauthorized" };
    }
  })
  .post(
    "/login",
    ({ body, set }) => {
      const ok = !!config.auth.user && secretEquals(body.user, config.auth.user) && secretEquals(body.pass, config.auth.pass);
      if (!ok) {
        set.status = 401;
        return { ok: false, error: "Invalid credentials" };
      }
      set.headers["Set-Cookie"] = `cabinet_session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}`;
      return { ok: true };
    },
    { body: t.Object({ user: t.String(), pass: t.String() }) },
  )
  .post("/logout", ({ set }) => {
    set.headers["Set-Cookie"] = "cabinet_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    return { ok: true };
  })
  .get("/me", () => ({ user: config.auth.user ?? "operator", build: buildInfo }))
  // Create from a JSON list of phones (paste box).
  .post("/numbers", ({ body }) => ingest(body.numbers.map((p) => ({ phone: p })), body.label?.trim() || "Pasted list"), {
    body: t.Object({ numbers: t.Array(t.String()), label: t.Optional(t.String()) }),
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
        return { filename: body.file.name, ...ingest(records, body.file.name || "Upload") };
      } catch (e) {
        set.status = 400;
        return { error: `could not parse file: ${String((e as Error).message)}` };
      }
    },
    { body: t.Object({ file: t.File({ maxSize: "20m" }), header_map: t.Optional(t.Any()) }) },
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
    { body: t.Object({ file: t.File({ maxSize: "20m" }), header_map: t.Optional(t.Any()) }) },
  )

  // Paginated list. ?limit=&offset= (limit capped at 500).
  .get(
    "/numbers",
    ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 500);
      const offset = Math.max(Number(query.offset ?? 0), 0);
      const q = query.q;
      const uploadId = query.upload_id ? Number(query.upload_id) : undefined;
      return { total: countNumbers(q, uploadId), limit, offset, numbers: listNumbers(limit, offset, q, uploadId) };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
        q: t.Optional(t.String()),
        upload_id: t.Optional(t.String()),
      }),
    },
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

  // Uploads (batches): list, detail, per-upload CSV export, delete.
  .get("/uploads", () => ({ uploads: listUploads() }))
  .get("/uploads/:id", ({ params, set }) => {
    const upload = getUpload(Number(params.id));
    if (!upload) {
      set.status = 404;
      return { error: "not found" };
    }
    return { upload, numbers: rowsForUpload(Number(params.id)) };
  })
  .get("/uploads/:id/export.csv", ({ params, set }) => {
    const upload = getUpload(Number(params.id));
    if (!upload) {
      set.status = 404;
      return { error: "not found" };
    }
    set.headers["content-type"] = "text/csv; charset=utf-8";
    set.headers["content-disposition"] = `attachment; filename="upload-${upload.id}-tokens.csv"`;
    return toCoreCsv(rowsForUpload(upload.id));
  })
  .delete("/uploads/:id", ({ params, set }) => {
    if (!deleteUpload(Number(params.id))) {
      set.status = 404;
      return { error: "not found" };
    }
    return { deleted: true };
  })

  // Whole base as a core-shape CSV (tokens in phone_e164).
  .get("/export.csv", ({ set }) => {
    set.headers["content-type"] = "text/csv; charset=utf-8";
    set.headers["content-disposition"] = `attachment; filename="tokens.csv"`;
    return toCoreCsv(allRecords());
  })


  .get("/settings", () => ({
    crm: getCrmConfig(),
    wr: getWrConfig(),
    inboundKey: getInboundKey(),
    coreKey: getCoreKey(),
    wrTargetFields: WR_TARGET_FIELDS,
    wrSourceFields: WR_SOURCE_FIELDS,
    tokenOnlyTargets: TOKEN_ONLY_TARGETS,
    defaults: DEFAULT_CRM_CONFIG,
  }))

  .put(
    "/settings/crm",
    ({ body, set }) => {
      try {
        return { crm: saveCrmConfig(body) };
      } catch (e) {
        set.status = 422;
        return { error: String((e as Error).message) };
      }
    },
    { body: t.Any() },
  )

  .put(
    "/settings/wr",
    ({ body, set }) => {
      try {
        return { wr: saveWrConfig(body) };
      } catch (e) {
        set.status = 422;
        return { error: String((e as Error).message) };
      }
    },
    { body: t.Any() },
  )

  .post(
    "/settings/keys/:which",
    ({ params, set }) => {
      const value = crypto.randomUUID().replace(/-/g, "");
      if (params.which === "inbound") {
        setInboundKey(value);
        return { key: value };
      }
      if (params.which === "core") {
        setCoreKey(value);
        return { key: value };
      }
      set.status = 404;
      return { error: "unknown key" };
    },
  )

  .post("/settings/test", async ({ set }) => {
    const crm = getCrmConfig();
    if (!crm.url) {
      set.status = 422;
      return { error: "set the CRM url first" };
    }
    const body = buildResultBody({
      phone: "+380000000000",
      call_id: "00000000-0000-0000-0000-000000000000",
      result: "send_sms",
      payload: { user_id: "test-user" },
    });
    return { sent: body, response: await sendToCrm(crm, body) };
  })

  .post("/numbers/:id/resend", ({ params, set }) => {
    const id = Number(params.id);
    if (!getNumber(id)) {
      set.status = 404;
      return { error: "not found" };
    }
    if (!outboxRequeueForNumber(id)) {
      set.status = 409;
      return { error: "nothing to resend for this number" };
    }
    setDeliveryState(id, "pending");
    return { queued: true };
  })

  .post("/requests/:callId/resend", ({ params, set }) => {
    const request = getRequest(params.callId);
    if (!request) {
      set.status = 404;
      return { error: "not found" };
    }
    if (!outboxRequeueForCall(request.call_id)) {
      set.status = 409;
      return { error: "nothing to resend for this call" };
    }
    setRequestDeliveryState(request.call_id, "pending");
    return { queued: true };
  })

  .get("/numbers/:id/requests", ({ params, set }) => {
    const id = Number(params.id);
    if (!getNumber(id)) {
      set.status = 404;
      return { error: "not found" };
    }
    return { requests: requestsForNumber(id) };
  })

  .post("/outbox/drain", () => drainOutbox())
  .post("/push/retry", () => retryPushes())

  .get("/numbers/:id/transcript", async ({ params, set }) => {
    const row = getNumber(Number(params.id));
    if (!row) {
      set.status = 404;
      return { error: "not found" };
    }
    if (!row.external_id) {
      return { available: false, calls: [], error: "no call result received for this number yet" };
    }
    return { leadId: row.external_id, ...(await fetchLeadTranscript(row.external_id)) };
  });

// Serve the pre-built React UI (run `bun run build:web` → dist/) as static files.
// Pre-building runs the Tailwind plugin so utility classes are generated (the dev
// fullstack server does this at runtime, but production bundling does not).
const app = new Elysia()
  .use(
    openapi({
      path: "/docs",
      exclude: { paths: [/^\/api(\/|$)/, /^\/docs/, /^\/?\*?$/] },
      documentation: {
        info: {
          title: "Hidden Numbers cabinet",
          version: buildInfo.version,
          description:
            "Client-side tokenisation gateway between your CRM and WinRiders. Real phone numbers never leave this server: players come in here, only tokens go out to WinRiders, call results come back here and are delivered to your CRM with the real number restored.",
        },
        tags: [
          { name: "Players", description: "Your CRM → cabinet. Authenticate with the inbound key from Settings." },
          { name: "WinRiders", description: "WinRiders → cabinet. Authenticate with the core key from Settings." },
          { name: "Service", description: "Liveness and build info. No authentication." },
        ],
        components: {
          securitySchemes: {
            inboundKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Inbound key. `Authorization: Bearer <key>` is accepted too." },
            coreKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Core key. `Authorization: Bearer <key>` is accepted too." },
          },
        },
      },
    }),
  )
  .get("/health", () => ({ ok: true, count: countNumbers(), clientPrefix: config.clientPrefix ?? null, build: buildInfo }), {
    detail: { tags: ["Service"], summary: "Liveness" },
  })
  .get("/version", () => buildInfo, { detail: { tags: ["Service"], summary: "Build info" } })
  .use(hooks)
  .use(api)
  .use(staticPlugin({ assets: "dist", prefix: "/", indexHTML: true }))
  .listen(config.port);

startOutboxCron();
startPushRetryCron();
console.log(`[hidden-numbers] cabinet listening on :${config.port}`);
if (!config.auth.user || !config.auth.pass) {
  console.warn("[hidden-numbers] ⚠ Auth DISABLED — set CABINET_USER and CABINET_PASSWORD to protect the cabinet.");
}

// Internal-only detokenize listener (token -> real number). Reached by the SIP proxy
// over the internal network, guarded by X-Decrypt-Key. Never exposed on the public port.
Bun.serve({
  hostname: config.internal.host,
  port: config.internal.port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/detokenize") return new Response("not found", { status: 404 });
    if (!secretEquals(req.headers.get("x-decrypt-key"), config.decryptKey)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const raw = url.searchParams.get("t");
    if (!raw) return Response.json({ error: "missing t" }, { status: 400 });
    // Kamailio may forward the whole dialed number (<clientPrefix><token>) or a bare
    // token. Strip our client prefix if present, then decrypt.
    let digits = raw.replace(/\D/g, "");
    const pfx = config.clientPrefix;
    if (pfx && digits.length === pfx.length + 15 && digits.startsWith(pfx)) {
      digits = digits.slice(pfx.length);
    }
    try {
      return Response.json({ phone: decryptToken(digits) });
    } catch {
      return Response.json({ error: "bad token" }, { status: 422 });
    }
  },
});
console.log(`[hidden-numbers] detokenize (internal) on ${config.internal.host}:${config.internal.port}`);

export type App = typeof app;
