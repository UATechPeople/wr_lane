import { createHash } from "crypto";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name} (run \`bun run keygen\`)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3500),

  // FF3-1 key (hex, 32/48/64 chars = 128/192/256-bit). SECRET. Lives ONLY on the
  // client side — Platform never has it, so Platform can never reverse a token.
  ff3Key: req("FF3_KEY"),

  // FF3-1 tweak (hex, 16 chars = 64-bit). Not secret. FIXED so encryption is fully
  // deterministic: same real number -> same token (needed for dedup / DNC linkage).
  ff3Tweak: process.env.FF3_TWEAK ?? "D8E7920AFA330A73",

  // First digit of every token. Must be 1-9 (E.164 requires a non-zero leading digit).
  // Constant -> token length is always 15 digits -> the real number's length never leaks.
  routeDigit: process.env.ROUTE_DIGIT ?? "9",

  // Shared secret kamailio -> /api/decrypt. Use mTLS in production on top of this.
  decryptKey: req("DECRYPT_KEY"),

  // Operator HTTP Basic Auth for the cabinet UI + data API. If either is unset, auth
  // is DISABLED (dev convenience) and a warning is logged. /api/decrypt and /health
  // are exempt (decrypt has its own key). Put behind TLS in production.
  auth: {
    user: process.env.CABINET_USER,
    pass: process.env.CABINET_PASSWORD,
  },

  // Secret for signing session cookies. Stable across restarts; derived from existing
  // secrets so no extra env is required (changing the password invalidates sessions).
  sessionSecret:
    process.env.SESSION_SECRET ||
    createHash("sha256")
      .update(`${process.env.CABINET_PASSWORD ?? ""}|${process.env.FF3_KEY ?? ""}|wr-hidden-numbers`)
      .digest("hex"),

  dbPath: process.env.DB_PATH ?? "cabinet.sqlite",

  // Platform client-integration target (push tokens as player events).
  platform: {
    baseUrl: process.env.WR_BASE_URL,
    slug: process.env.WR_SLUG,
    apiKey: process.env.WR_API_KEY,
    // Label that turns the flat token list into a segment on the WR side.
    playerSegment: process.env.WR_PLAYER_SEGMENT ?? "hidden_base",
    cohort: process.env.WR_COHORT,
    eventType: process.env.WR_EVENT_TYPE ?? "player.registered",
  },

  // Detokenize runs on a SEPARATE internal listener (token -> real number), reached only
  // by the SIP proxy over the internal network — never the public UI port. Bind to
  // 127.0.0.1 locally; in Docker set INTERNAL_HOST=0.0.0.0 but DON'T publish the port.
  internal: {
    host: process.env.INTERNAL_HOST ?? "127.0.0.1",
    port: Number(process.env.INTERNAL_PORT ?? 3501),
  },

  // This client's routing prefix (per Mark: one prefix per client, set in env — e.g.
  // 123000). Each client runs their own cabinet, so this env is that client's source of
  // truth. Kamailio routes on it; /detokenize strips it before decrypting. The TOKEN
  // itself stays prefix-less — the prefix is applied at dial via Platform techPrefix.
  clientPrefix: process.env.CLIENT_PREFIX,

  // Feature flag for the "Push to Platform" button + /push endpoint. HIDDEN by
  // default so the change is opt-in and nobody has to touch envs to keep the old
  // (no-push) behaviour. Set WR_PUSH_ENABLED=true (or 1) to enable.
  pushEnabled: process.env.WR_PUSH_ENABLED === "true" || process.env.WR_PUSH_ENABLED === "1",
};
