import { createHash, createHmac } from "crypto";
import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config";
import { checkKeysAgainstBase, initKeys, keys, writeSharedDecryptKey } from "./keys";
import { DEFAULT_ROUTE, enabledModes, getManagedTelephony, getTelephony, importLegacyTelephony, isManagedMode, setRoutePrefix, trunkName, TRUNK_MODES, type ModeState, type TrunkMode } from "./telephony";
import { addRouteAndSync, changeTrunkKeyAndSync, getCoreState, modesSummary, registerWithCore, removeRouteAndSync, startManagedConfigCron } from "./core";
import { changeDecryptKey, changeEncryptionKeys, changeLogin, decryptKeyPending, encryptionKeysInfo, exportKeysEnv } from "./key-settings";
import { secretEquals } from "./equals";
import { internalFetch } from "./internal";
import { buildInfo } from "./version";
import { encryptPhone, decryptToken, looksLikeToken } from "./fpe";
import {
  listUploads,
  getUpload,
  deleteUpload,
  rowsForUpload,
  listNumbers,
  getNumber,
  updateNumber,
  deleteNumber,
  allRecords,
  countNumbers,
  batchErrors,
  getBatch,
  listBatches,
  retryAbandonedInBatch,
  type NewNumber,
} from "./db";
import { toCoreCsv } from "./csv";
import {
  fetchLeadTranscript,
  getPushRate,
  kickPushWorker,
  PUSH_MAX_ATTEMPTS,
  pushQueueHealth,
  pushRequests,
  retryPushes,
  setPushRate,
  startPushWorkerCron,
} from "./winriders";
import { parseRecords, previewFile, type UploadRecord, type HeaderMap } from "./upload";
import { hooks, STREAM_LABEL } from "./hooks";
import { ingestRecords, sendUpload } from "./uploads";
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
} from "./webhook";
import {
  getRequest,
  outboxRequeueForCall,
  outboxRequeueForNumber,
  requestsForNumber,
  resetPushSchedule,
  setDeliveryState,
  setRequestDeliveryState,
} from "./db";

function boot(): void {
  try {
    const started = initKeys(process.env);
    for (const name of started.imported) console.log(`[hidden-numbers] imported ${name} from the environment`);
    for (const name of started.generated) console.log(`[hidden-numbers] generated ${name}`);
    for (const name of started.ignoredEnv) console.warn(`[hidden-numbers] ${name} in the environment differs from the stored value and is ignored`);
    const check = checkKeysAgainstBase(encryptPhone, looksLikeToken);
    if (check.mismatched > 0) {
      throw new Error(`the FF3 key does not reproduce ${check.mismatched} of ${check.checked} stored tokens; refusing to start so no call reaches the wrong person`);
    }
    const legacyModes = importLegacyTelephony(process.env);
    if (legacyModes.length > 0) console.log(`[hidden-numbers] imported trunk modes from the environment: ${legacyModes.join(", ")}`);
    const sharedKey = writeSharedDecryptKey();
    if (sharedKey) console.log(`[hidden-numbers] SIP proxy key written to ${sharedKey}`);
  } catch (e) {
    console.error(`[hidden-numbers] ${(e as Error).message}`);
    process.exit(1);
  }
}

boot();

function coerceHeaderMap(hm: unknown): HeaderMap | undefined {
  if (!hm) return undefined;
  if (typeof hm === "string") return JSON.parse(hm) as HeaderMap;
  return hm as HeaderMap;
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

const SESSION_TTL_S = 7 * 24 * 3600;

function sessionSecret(): string {
  return createHash("sha256").update(`${keys.cabinetPassword()}|${keys.ff3Key}|wr-hidden-numbers`).digest("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function makeToken(): string {
  const payload = Buffer.from(`${keys.cabinetUser()}:${Date.now() + SESSION_TTL_S * 1000}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token?: string): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !secretEquals(sign(payload), sig)) return false;
  const [user, exp] = Buffer.from(payload, "base64url").toString().split(":");
  return user === keys.cabinetUser() && Number(exp) > Date.now();
}
function enabledMode(value: string): TrunkMode | null {
  if (!(TRUNK_MODES as readonly string[]).includes(value)) return null;
  return enabledModes().includes(value as TrunkMode) ? (value as TrunkMode) : null;
}

function trunkKeys() {
  const state = getTelephony();
  return modesSummary().map((m) => {
    const current = state.modes[m.mode] as ModeState;
    return {
      mode: m.mode,
      host: m.host,
      port: m.port,
      managed: isManagedMode(m.mode),
      routes: current.routes.map((r) => ({ id: r.id, name: trunkName(m.mode, r.id), prefix: r.prefix, key: r.key, previousKeyAccepted: Boolean(r.prevKey) })),
    };
  });
}

function refuseManaged(mode: TrunkMode): string | null {
  return isManagedMode(mode) ? `the routes of ${mode} are set in WinRiders (client card); change them there` : null;
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
  .onBeforeHandle(({ request, headers, set }) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/login")) return;
    if (path.endsWith("/health") || path.endsWith("/up")) return;
    if (!verifyToken(readCookie(headers.cookie, "cabinet_session"))) {
      set.status = 401;
      return { error: "unauthorized" };
    }
  })
  .post(
    "/login",
    ({ body, set }) => {
      const ok = secretEquals(body.user, keys.cabinetUser()) && secretEquals(body.pass, keys.cabinetPassword());
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
  .get("/me", () => ({ user: keys.cabinetUser(), build: buildInfo }))
  .post("/numbers", ({ body }) => ingestRecords(body.numbers.map((p) => ({ phone: p })), body.label?.trim() || "Pasted list"), {
    body: t.Object({ numbers: t.Array(t.String()), label: t.Optional(t.String()) }),
  })

  .post(
    "/numbers/upload",
    async ({ body, set }) => {
      try {
        const records = parseRecords(await body.file.arrayBuffer(), coerceHeaderMap(body.header_map));
        if (records.length === 0) {
          set.status = 422;
          return { error: "no phone column found / file empty" };
        }
        return { filename: body.file.name, ...ingestRecords(records, body.file.name || "Upload") };
      } catch (e) {
        set.status = 400;
        return { error: `could not parse file: ${String((e as Error).message)}` };
      }
    },
    { body: t.Object({ file: t.File({ maxSize: "20m" }), header_map: t.Optional(t.Any()) }) },
  )

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
  .post(
    "/uploads/:id/send",
    ({ params, body, set }) => {
      const upload = getUpload(Number(params.id));
      if (!upload) {
        set.status = 404;
        return { error: "not found" };
      }
      if (upload.label === STREAM_LABEL) {
        set.status = 422;
        return { error: "numbers from the CRM stream are sent to WinRiders as they arrive" };
      }
      const sent = sendUpload(upload.id, body?.force === true);
      if ("error" in sent) {
        set.status = sent.status;
        return { error: sent.error };
      }
      if ("conflict" in sent) {
        set.status = 409;
        return { error: "this upload was already sent to WinRiders; sending it again creates new calls", batch_ids: sent.conflict };
      }
      kickPushWorker();
      return { batch: getBatch(PUSH_MAX_ATTEMPTS, sent.batchId) };
    },
    {
      body: t.Optional(
        t.Object({
          force: t.Optional(t.Boolean()),
        }),
      ),
    },
  )
  .get(
    "/batches",
    ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
      const offset = Math.max(Number(query.offset ?? 0), 0);
      return { ...listBatches(PUSH_MAX_ATTEMPTS, limit, offset), limit, offset };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  )
  .get("/batches/:id", ({ params, set }) => {
    const batch = getBatch(PUSH_MAX_ATTEMPTS, Number(params.id));
    if (!batch) {
      set.status = 404;
      return { error: "not found" };
    }
    return { batch, errors: batchErrors(PUSH_MAX_ATTEMPTS, batch.id) };
  })
  .post("/batches/:id/retry", ({ params, set }) => {
    const batch = getBatch(PUSH_MAX_ATTEMPTS, Number(params.id));
    if (!batch) {
      set.status = 404;
      return { error: "not found" };
    }
    const requeued = retryAbandonedInBatch(PUSH_MAX_ATTEMPTS, batch.id);
    if (requeued > 0) kickPushWorker();
    return { requeued, batch: getBatch(PUSH_MAX_ATTEMPTS, batch.id) };
  })
  .delete("/uploads/:id", ({ params, set }) => {
    if (!deleteUpload(Number(params.id))) {
      set.status = 404;
      return { error: "not found" };
    }
    return { deleted: true };
  })

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
    defaults: DEFAULT_CRM_CONFIG,
    pushRatePerMin: getPushRate(),
    trunks: trunkKeys(),
    allowedSources: getManagedTelephony().allowedSources ?? [],
    keys: {
      ...encryptionKeysInfo(),
      decryptKey: keys.decryptKey(),
      decryptKeyPending: decryptKeyPending(),
      cabinetUser: keys.cabinetUser(),
      cabinetPassword: keys.cabinetPassword(),
    },
  }))

  .put(
    "/settings/encryption",
    async ({ body, set }) => {
      try {
        const info = changeEncryptionKeys(body.generate ? "generate" : { ff3Key: body.ff3Key ?? "", ff3Tweak: body.ff3Tweak ?? "", routeDigit: body.routeDigit ?? "" });
        if (getCoreState()?.status !== "active") return { keys: info };
        try {
          const registered = await registerWithCore();
          const message = (registered.body as { error?: { message?: string } }).error?.message;
          return { keys: info, reregistered: registered.status, ...(message ? { error: message } : {}) };
        } catch (e) {
          return { keys: info, reregistered: "failed", error: (e as Error).message };
        }
      } catch (e) {
        set.status = 422;
        return { error: (e as Error).message };
      }
    },
    {
      body: t.Object({
        generate: t.Optional(t.Boolean()),
        ff3Key: t.Optional(t.String({ maxLength: 64 })),
        ff3Tweak: t.Optional(t.String({ maxLength: 16 })),
        routeDigit: t.Optional(t.String({ maxLength: 1 })),
      }),
    },
  )

  .put(
    "/settings/login",
    ({ body, set }) => {
      try {
        changeLogin(body.user, body.password);
        set.headers["Set-Cookie"] = `cabinet_session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}`;
        return { user: keys.cabinetUser() };
      } catch (e) {
        set.status = 422;
        return { error: "the login may hold letters, digits and . _ @ -; the password needs at least 8 characters" };
      }
    },
    { body: t.Object({ user: t.String({ maxLength: 64 }), password: t.String({ maxLength: 256 }) }) },
  )

  .post(
    "/settings/decrypt-key",
    ({ body, set }) => {
      try {
        return { decryptKey: changeDecryptKey(body?.key?.trim() || undefined), decryptKeyPending: decryptKeyPending() };
      } catch (e) {
        set.status = 422;
        return { error: "the key needs at least 16 characters" };
      }
    },
    { body: t.Optional(t.Object({ key: t.Optional(t.String({ maxLength: 256 })) })) },
  )

  .get("/settings/keys.env", ({ set }) => {
    set.headers["content-type"] = "text/plain; charset=utf-8";
    set.headers["content-disposition"] = `attachment; filename="hidden-numbers-keys.env"`;
    return `${exportKeysEnv()}\n`;
  })

  .post(
    "/settings/trunks/:mode/key",
    async ({ params, body, set }) => {
      const mode = enabledMode(params.mode);
      if (!mode) {
        set.status = 404;
        return { error: `${params.mode} is not enabled` };
      }
      try {
        const result = await changeTrunkKeyAndSync(mode, body?.key?.trim() || undefined, body?.route?.trim() || DEFAULT_ROUTE);
        return { ...result, trunks: trunkKeys() };
      } catch (e) {
        set.status = 422;
        return { error: (e as Error).message };
      }
    },
    { body: t.Optional(t.Object({ key: t.Optional(t.String({ maxLength: 128 })), route: t.Optional(t.String({ maxLength: 32 })) })) },
  )

  .post(
    "/settings/trunks/:mode/routes",
    async ({ params, body, set }) => {
      const mode = enabledMode(params.mode);
      if (!mode) {
        set.status = 404;
        return { error: `${params.mode} is not enabled` };
      }
      const managed = refuseManaged(mode);
      if (managed) {
        set.status = 409;
        return { error: managed };
      }
      try {
        const result = await addRouteAndSync(mode, body.route, body.prefix ?? "");
        return { ...result, trunks: trunkKeys() };
      } catch (e) {
        set.status = 422;
        return { error: (e as Error).message };
      }
    },
    { body: t.Object({ route: t.String({ maxLength: 32 }), prefix: t.Optional(t.String({ maxLength: 16 })) }) },
  )

  .put(
    "/settings/trunks/:mode/routes/:route",
    ({ params, body, set }) => {
      const mode = enabledMode(params.mode);
      if (!mode) {
        set.status = 404;
        return { error: `${params.mode} is not enabled` };
      }
      const managed = refuseManaged(mode);
      if (managed) {
        set.status = 409;
        return { error: managed };
      }
      try {
        setRoutePrefix(mode, params.route, body.prefix);
        return { trunks: trunkKeys() };
      } catch (e) {
        set.status = 422;
        return { error: (e as Error).message };
      }
    },
    { body: t.Object({ prefix: t.String({ maxLength: 16 }) }) },
  )

  .delete("/settings/trunks/:mode/routes/:route", async ({ params, set }) => {
    const mode = enabledMode(params.mode);
    if (!mode) {
      set.status = 404;
      return { error: `${params.mode} is not enabled` };
    }
    const managed = refuseManaged(mode);
    if (managed) {
      set.status = 409;
      return { error: managed };
    }
    try {
      const result = await removeRouteAndSync(mode, params.route);
      return { ...result, trunks: trunkKeys() };
    } catch (e) {
      set.status = 422;
      return { error: (e as Error).message };
    }
  })

  .put(
    "/settings/push",
    ({ body, set }) => {
      try {
        return { pushRatePerMin: setPushRate(body.rate) };
      } catch (e) {
        set.status = 422;
        return { error: String((e as Error).message) };
      }
    },
    { body: t.Object({ rate: t.Number() }) },
  )

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
    async ({ params, set }) => {
      const value = crypto.randomUUID().replace(/-/g, "");
      if (params.which === "inbound") {
        setInboundKey(value);
        return { key: value };
      }
      if (params.which === "core") {
        setCoreKey(value);
        if (getCoreState()?.status !== "active") return { key: value };
        try {
          const registered = await registerWithCore();
          return { key: value, reregistered: registered.status };
        } catch (e) {
          return { key: value, reregistered: "failed", error: (e as Error).message };
        }
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

  .post("/numbers/:id/push", async ({ params, set }) => {
    const id = Number(params.id);
    if (!getNumber(id)) {
      set.status = 404;
      return { error: "not found" };
    }
    const pending = resetPushSchedule(id);
    if (pending.length === 0) {
      set.status = 409;
      return { error: "every request for this number already reached WinRiders" };
    }
    try {
      const results = await pushRequests(pending);
      const sent = results.filter((r) => r.ok).length;
      return { sent, failed: results.length - sent, error: results.find((r) => !r.ok)?.error };
    } catch (e) {
      set.status = 400;
      return { error: String((e as Error).message) };
    }
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

const BUILD_EXAMPLE = { version: "0.3.1", commit: "219813e", builtAt: "2026-09-17T09:00:00Z" };

const buildSchema = t.Object(
  {
    version: t.String(),
    commit: t.Nullable(t.String()),
    builtAt: t.Nullable(t.String()),
  },
  { examples: [BUILD_EXAMPLE] },
);

const QUEUE_EXAMPLE = {
  pending: 0,
  due: 0,
  abandoned: 0,
  oldest_pending_age_seconds: null,
  rate_per_min: 100,
  attempts_last_minute: 0,
  wr_configured: true,
  blocked: null,
  worker_running: false,
  worker_last_run_at: "2026-09-24T12:00:00.000Z",
  worker_last_error: null,
};

const queueSchema = t.Object(
  {
    pending: t.Number({ description: "Calls waiting to be sent to WinRiders, retries included." }),
    due: t.Number({ description: "Pending calls that may be sent right now." }),
    abandoned: t.Number({ description: "Calls that gave up after twelve attempts. Retry them from the batch." }),
    oldest_pending_age_seconds: t.Nullable(t.Number()),
    rate_per_min: t.Number(),
    attempts_last_minute: t.Number(),
    wr_configured: t.Boolean({ description: "False means nothing is sent until the WinRiders connection is set." }),
    blocked: t.Nullable(t.String({ description: "Why sending is paused right now, if it is." })),
    worker_running: t.Boolean(),
    worker_last_run_at: t.Nullable(t.String()),
    worker_last_error: t.Nullable(t.String()),
  },
  { examples: [QUEUE_EXAMPLE] },
);

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
          { name: "Service", description: "Monitoring. No authentication." },
        ],
        webhooks: {
          callResult: {
            post: {
              tags: ["Players"],
              summary: "Call result delivered to your CRM",
              description:
                "Sent by the cabinet to the `webhook_url` of the request once WinRiders reports the outcome of the call. `phone` is the real number, `call_id` is the one you received when you sent the player, `payload` is returned exactly as you sent it. Answer 2xx; anything else is retried with a growing delay, twelve attempts in total.",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["phone", "call_id", "result", "payload"],
                      properties: {
                        phone: { type: "string", description: "Real phone number in E.164.", example: "+31612345678" },
                        call_id: { type: "string", format: "uuid", example: "5d8982cd-8220-4f97-ac7d-452dbd01f630" },
                        result: {
                          type: "string",
                          enum: ["send_sms", "no_answer", "voicemail", "busy", "hang_up", "not_interested", "failed_call", "blacklist"],
                          example: "no_answer",
                        },
                        payload: { description: "Whatever you sent with the player, untouched.", example: { a: "b", user_id: "12345" } },
                      },
                      example: {
                        phone: "+31612345678",
                        call_id: "5d8982cd-8220-4f97-ac7d-452dbd01f630",
                        result: "no_answer",
                        payload: { a: "b", user_id: "12345" },
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "Accepted by your CRM. Any 2xx status counts." } },
            },
          },
        },
        components: {
          securitySchemes: {
            inboundKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Inbound key. `Authorization: Bearer <key>` is accepted too." },
            coreKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Core key. `Authorization: Bearer <key>` is accepted too." },
          },
        },
      },
    }),
  )
  .get("/health", () => ({ ok: true, count: countNumbers(), clientPrefix: keys.clientPrefix(), build: buildInfo, queue: pushQueueHealth() }), {
    response: {
      200: t.Object(
        {
          ok: t.Boolean(),
          count: t.Number({ description: "Numbers stored in the cabinet." }),
          clientPrefix: t.Nullable(t.String({ description: "Routing prefix this cabinet is configured with." })),
          build: buildSchema,
          queue: queueSchema,
        },
        { examples: [{ ok: true, count: 146, clientPrefix: "123000", build: BUILD_EXAMPLE, queue: QUEUE_EXAMPLE }] },
      ),
    },
    detail: {
      tags: ["Service"],
      summary: "Health",
      description: "Answers 200 while the cabinet can reach its database. Use it for uptime checks; the count tells you the base is the one you expect.",
    },
  })
  .get("/version", () => buildInfo, {
    response: { 200: buildSchema },
    detail: { tags: ["Service"], summary: "Version", description: "Which build is running. Compare with the archive name after an update." },
  })
  .use(hooks)
  .use(api)
  .use(staticPlugin({ assets: "dist", prefix: "/", indexHTML: true }))
  .listen(config.port);

startOutboxCron();
startPushWorkerCron();
startManagedConfigCron();
console.log(`[hidden-numbers] cabinet listening on :${config.port}`);
Bun.serve({ hostname: config.internal.host, port: config.internal.port, fetch: internalFetch });
console.log(`[hidden-numbers] internal listener on ${config.internal.host}:${config.internal.port}`);

export type App = typeof app;
