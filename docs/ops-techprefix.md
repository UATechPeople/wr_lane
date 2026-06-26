# Ops memo — per-client routing (VoiceService.techPrefix)

How a client is wired end-to-end. Three components, three owners:

| Component | Owner |
| --- | --- |
| Cabinet (token store, detokenize, UI) | this repo |
| wr-core campaign + ElevenLabs dispatch | wr-core / ops config |
| **Kamailio SIP proxy** (routing + detokenize call + trunk) | **SIP developer** (separate) |

Kamailio is a **required link in the call chain** — it is just owned by the SIP dev, not built here.

## The chain

```
Cabinet ──tokens (CSV / push)──▶ wr-core campaign
                                      │ dial: to_number = techPrefix + token
                                      ▼
                                 ElevenLabs (SIP trunk)
                                      │  INVITE: 123000<token>
                                      ▼
                                 Kamailio (SIP dev)
                                   ├─ match+strip client prefix 123000
                                   ├─ GET cabinet:3501/detokenize?t=<token>  → real number
                                   └─ rewrite R-URI → client trunk → provider
```

The real number surfaces only on the Kamailio↔detokenize hop, on the internal network.

## Per-client setup in wr-core

For **each client**, create one **VoiceService** (provider ElevenLabs) whose `connection`
JSON carries that client's routing prefix:

```jsonc
// VoiceService.connection
{
  "agentId": "<elevenlabs agent id>",
  "agentPhoneNumberId": "<elevenlabs sip-trunk phone id, terminating at Kamailio>",
  "techPrefix": "123000",          // <-- the client's prefix; prepended to every dialed token
  "baseUrl": "https://api.elevenlabs.io"
}
```

- `techPrefix` is prepended at dial time (`elevenlabs-call-provider.ts:35`: `to_number = techPrefix + phoneNumber`).
- Assign that VoiceService to the client's campaign(s). The campaign dials the cabinet tokens; the prefix is added automatically.
- Keep the **prefix table in sync with Kamailio** (the SIP dev routes on the same prefixes):

  | Client | Prefix | Cabinet `CLIENT_PREFIX` | wr-core VoiceService | Kamailio route |
  | --- | --- | --- | --- | --- |
  | client1 | `123000` | `CLIENT_PREFIX=123000` | VS-client1 `.techPrefix=123000` | → client1 trunk |
  | client2 | `223000` | `CLIENT_PREFIX=223000` | VS-client2 `.techPrefix=223000` | → client2 trunk |

  One prefix per client, declared in **three places that must match**: the client's cabinet
  `CLIENT_PREFIX` env (its source of truth, visible at `GET /health`), the client's
  `VoiceService.techPrefix` in wr-core (prepended at dial), and the Kamailio routing table.

## Campaign settings for a hidden-numbers client

- Provider **ElevenLabs** (VAPI can't insert the Kamailio hop).
- **call-only**; **runcheck / number-validation OFF** (tokens aren't real numbers to validate).
- **No SMS / WhatsApp** (no detokenize hop there).
- Leads come from the cabinet: tokens in `phone_e164`, `player_segment` set → forms the segment.
- `external_id` (user ID) is carried from the cabinet through to wr-core for **earnings tracking**.

## Secrets

- `DECRYPT_KEY` — shared cabinet ↔ Kamailio (detokenize auth). Same value both sides.
- ElevenLabs creds live in the VoiceService `connection` (wr-core), not in the cabinet.
- The FF3 key lives only in the cabinet; wr-core never has it and can't reverse a token.
