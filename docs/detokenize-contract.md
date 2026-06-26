# Detokenize contract (for the SIP / Kamailio developer)

The cabinet exposes a **separate internal listener** that maps a token back to the real
phone number. It is the only place a real number surfaces. This is the seam between the
cabinet (token store) and the SIP proxy (call egress). The SIP proxy is **not** built by
the cabinet team — this document is the integration contract.

## Endpoint

```
GET http://<cabinet-internal-host>:<INTERNAL_PORT>/detokenize?t=<token>
Header: X-Decrypt-Key: <DECRYPT_KEY>
```

- Default `INTERNAL_PORT` = **3501**. Default bind host = `127.0.0.1`; in Docker run with
  `INTERNAL_HOST=0.0.0.0` and keep the port **on the internal network only — never published**.
- This listener is **separate from the management UI/API** (port 3500). It has its own auth
  (`X-Decrypt-Key`) and shares nothing with the operator login session. Add **mTLS** + an IP
  allowlist in production.

## Request

| Param | Where | Value |
| --- | --- | --- |
| `t` | query | the **token** (the dialed user-part with the client prefix already stripped — see below) |
| `X-Decrypt-Key` | header | shared secret (env `DECRYPT_KEY`) |

The token is tolerant of formatting: non-digits are stripped, so `+9XXXXXXXXXXXXXX`,
`9XXXXXXXXXXXXXX` are both accepted. A valid token is **15 digits** (a leading routing
digit + 14 ciphertext digits).

## Responses

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{"phone":"+380501112233"}` | real E.164 number to dial |
| `401` | `{"error":"unauthorized"}` | missing/wrong `X-Decrypt-Key` |
| `400` | `{"error":"missing t"}` | no token supplied |
| `422` | `{"error":"bad token"}` | token doesn't decode (wrong length / not ours) |
| `404` | `not found` | wrong path (only `/detokenize` exists) |

## What the dialed number looks like at the proxy

wr-core stores the **prefix-less** token as the lead's number and, at dial time, prepends a
**per-client routing prefix** via the ElevenLabs trunk (`VoiceService.connection.techPrefix`).
So the user-part that arrives at Kamailio is:

```
<clientPrefix><token>          e.g.  123000 9XXXXXXXXXXXXXX
└── route on this ──┘ └── 15-digit token ──┘
```

The proxy must:
1. **Match & strip the client prefix** (configured per client, e.g. `123000`, `223000`) — this
   is also how you know which client/trunk the call belongs to.
2. Take the remaining **15 digits** as the token.
3. `GET /detokenize?t=<token>` with the key.
4. On `200`, rewrite the R-URI to the returned `phone` and relay to that client's trunk.
5. On empty/`422`/non-200 → reject the call (e.g. SIP `603`). The detokenize endpoint is also
   the natural place to enforce client-side DNC: return a decline and the proxy drops the call.

## KEMI sketch (Lua, illustrative)

```lua
-- INVITE: r-uri user = clientPrefix .. token
local ruser = KSR.kx.get_ruser()
local prefix = "123000"                       -- per client (from your routing table)
if ruser:sub(1, #prefix) == prefix then
  local token = ruser:sub(#prefix + 1)        -- 15-digit token
  local body  = KSR.http_async_client and nil -- use http_async_client in production
  -- GET http://cabinet:3501/detokenize?t=<token>  with header X-Decrypt-Key
  -- parse {"phone": "..."}; if empty -> KSR.sl.send_reply(603, "Declined")
  KSR.pv.sets("$ru", "sip:" .. real_number .. "@gw.client-trunk")
  KSR.tm.t_relay()
end
```

Use **`http_async_client`** (non-blocking) and send `100 Trying` before the lookup, or
ElevenLabs will retransmit the INVITE.

## Env (cabinet side)

```
DECRYPT_KEY=<shared secret with the proxy>
INTERNAL_HOST=0.0.0.0     # in Docker; 127.0.0.1 for local
INTERNAL_PORT=3501
```
