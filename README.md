# WR Hidden Numbers — client cabinet

Client-deployed service for Platform issue #641. The client's real phone base **never leaves
this box**. Platform only ever sees **FF3-1 tokens**; the real number is recovered later, on the
egress SIP leg, just before the call hits the PSTN provider.

```
  Cabinet (this service)            Platform
  ───────────────────────          ──────────
  load real base  ──encrypt──▶  token in phone_e164 (tagged player_segment)
  SQLite (real, only here)          └─ segment → Voice AI call-only
        ▲                                   │ to_number = token
        │                                   ▼
        └─ token ──/api/decrypt──▶ real #   (egress consumer — see "Egress (TBD)")
```

## Components

| Part | What | Where |
| ---- | ---- | ----- |
| Cabinet API + UI | upload base, export tokens, decrypt endpoint; **React served inside Elysia** (Bun bundles `public/` via the HTML import — no Vite, single process) | `src/`, `public/` |
| SQLite | the real base (operator UI / audit only — decryption does NOT need it) | `cabinet.sqlite` |

> **Egress (TBD).** The SIP-side consumer that calls `/api/decrypt` to recover the real number on
> the way to the provider is **out of scope for now** (was kamailio; stripped). `/api/decrypt`
> stays as the stable contract for whatever does egress later.

## Auth

The cabinet has a **login page** backed by a session cookie (`CABINET_USER` / `CABINET_PASSWORD`):

- `POST /api/login` checks the creds and sets a signed, expiring **httpOnly** cookie (`cabinet_session`, 7d). No server-side session store — the cookie is HMAC-signed with `sessionSecret` (derived from your existing secrets, or set `SESSION_SECRET`). `POST /api/logout` clears it; `GET /api/me` reports the session.
- All `/api/*` require a valid session. Exempt: `/api/login`, `/health`, and `/api/decrypt` (machine-to-machine, guarded by `X-Decrypt-Key`).
- If `CABINET_USER`/`CABINET_PASSWORD` are unset, auth is disabled (dev) and a startup warning is logged. Set them in any real deployment, and put the service behind TLS.

## Token design (FF3-1, format-preserving)

A token is always **15 digits**, a valid E.164 string that passes Platform' `^\+[1-9]\d{1,14}$`:

```
+ <routeDigit:1=9> <FF3 ciphertext:14>        FF3 plaintext(14) = <lenCode:1><body:13>
```

- **Deterministic** (fixed key+tweak): same real number → same token → Platform dedup / DNC linkage still work.
- **No real digits leak**: FF3-1 is a keyed bijection; the key is client-only, so Platform can never reverse it.
- **Length hidden**: every token is exactly 15 digits regardless of the real number's length.
- **Supported real length: 8–13 significant digits** (covers all real-world E.164; longer is rejected).
- Linkability (telling that two leads are the same person) is *intentionally* preserved — required for dedup/DNC. It does **not** reveal the number.

## API

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/api/numbers/upload` | (UI) | **upload a CSV / XLSX file** (multipart field `file`) → encrypts + stores |
| POST | `/api/numbers` | (UI) | create from JSON `{ "numbers": ["+380...", ...] }` (paste box) |
| GET | `/api/numbers?limit=&offset=` | (UI) | paginated list (`limit` ≤ 500, default 50) |
| GET | `/api/numbers/:id` | (UI) | read one |
| PATCH | `/api/numbers/:id` | (UI) | replace the real number `{ "real": "+..." }` → re-tokenizes, resets push state |
| DELETE | `/api/numbers/:id` | (UI) | delete one |
| GET | `/api/export` | (UI) | tokens to ship to Platform (drop into `phone_e164`) |
| GET | `/api/decrypt?t=<token>` | `X-Decrypt-Key` | egress lookup → `{ "phone": "+..." }` (no caller yet — see Egress) |
| GET | `/health` | — | liveness + base count |

### Upload file format

CSV or XLSX (UTF-8, first worksheet). Columns follow the Platform client-integration
list format (guide §2A / §2):

| Column | Required | Notes |
| ------ | -------- | ----- |
| `phone_e164` | ✅ | E.164 (`+` and country code, digits only). Aliases: `phone`, `number`, `msisdn`. The **only** field that gets tokenized. |
| `external_id` | — | your id for the player; round-trips back on reads. Defaults to the token if absent. |
| `first_name`, `last_name` | — | personalization |
| `country` | — | ISO-3166-1 (e.g. `UA`) |
| `language` | — | ISO-639-1 (e.g. `ru`) |
| `segment` | — | becomes `player_segment` on the WR side (what turns the list into a segment) |
| `cohort` | — | targeting cohort |

- Auto-detection matches **only these canonical names**. For custom/localized headers,
  pass a **`header_map`** (your header → our field), exactly like the guide's header map.
- Headerless single-column files are treated as a plain phone list.
- Bad rows (wrong length, non-E.164) are reported per-row, not fatal. Supported phone length: 8–13 significant digits.

```csv
external_id,phone_e164,first_name,country,language,segment
P-1,+447700900456,Ivan,UA,ru,vip
```

```bash
# canonical headers — auto-detected
curl -F file=@base.csv  http://localhost:3500/api/numbers/upload
curl -F file=@base.xlsx http://localhost:3500/api/numbers/upload

# custom headers — supply a header map (field name -> our field)
curl -F file=@client.csv \
     -F 'header_map={"Номер телефона клиента":"phone","User ID":"external_id","Имя клиента":"first_name"}' \
     http://localhost:3500/api/numbers/upload
```

## Run

```bash
bun install
cp .env.example .env && bun run keygen   # paste FF3_KEY / FF3_TWEAK / DECRYPT_KEY into .env
bun run dev                              # API + UI on :3500 (UI at /, HMR on) — Bun bundles React, no build step
bun test                                 # FF3 round-trip / determinism / E.164 shape
docker compose up --build                # single container (Bun bundles the UI at runtime)
```

The React app (`public/index.html` → `index.tsx` → `App.tsx`) is imported into `src/index.ts`
(`import index from "../public/index.html"`); Bun bundles it and `Bun.serve` routes `/` to the
SPA, falling through to Elysia for the API. No Vite, no separate frontend package or build.

## Wiring into Platform

1. **Cabinet** → operator uploads the real base → `/api/export` yields tokens.
2. **Ship tokens to Platform** in `phone_e164`, **each tagged with a constant `player_segment`**
   (e.g. `hidden_base_2026_06`). That label is what turns the flat list into a **segment**
   (`deriveSegmentHierarchy` → `ensureSegmentHierarchy` builds Segment + membership + CampaignSegment).
   Without the label the rows enroll but no segment forms → the campaign has nothing to target.
3. **Campaign** → an **Voice AI `call-only`** campaign whose enrollment rule matches the base and
   whose SIP trunk terminates at the (future) egress proxy. Skip number-validation/`runcheck`;
   no SMS/WhatsApp (no decrypt hop there).
4. **Compliance** → `/api/decrypt` is the natural place for client-side DNC (only point that sees the
   real number): return an empty `phone` → egress declines the call.

## ⚠️ Skeleton caveats

- `/api/decrypt` auth is a shared header secret; add **mTLS** in production.
- FF3-1 key management (rotation, HSM) is out of scope here — losing the key orphans every token; rotating it re-tokenizes the whole base.
- Decryption is stateless (FF3), so the SQLite base is for the UI/audit only.
- The `player_segment` labelling + enrollment rule (Platform side) is **configuration**, not code here.
