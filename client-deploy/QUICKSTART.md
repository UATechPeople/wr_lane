# Hidden Numbers — quick start

Deploy the number-anonymization service on your own server. Real phone numbers and the
encryption keys stay entirely on this server; WinRiders only ever receives tokens.

## What you need

- One Linux server with **Docker** (including `docker compose`).
- A **public IP** on that server, with **UDP and TCP port 5060 open** (SIP).
- The bundle archive WinRiders sent you (`hidden-numbers.zip`). There is **no source code**
  and **no registry/token** — the ready-made images are **bundled inside the archive** and
  loaded locally.

## Deploy

```bash
unzip hidden-numbers.zip -d hidden-numbers && cd hidden-numbers/hidden-numbers-client
./up.sh          # creates .env from the template and stops
nano .env        # fill in CLIENT_PREFIX and your SIP-trunk details
./up.sh          # second run loads the images and starts everything
```

Your server's public IP is auto-detected. The encryption keys are generated once into
`keys.env` — back that file up, without it existing tokens cannot be decrypted.

- **Cabinet UI:** `http://<your-server-ip>:3500` (login `admin`, password `CABINET_PASSWORD` in `keys.env`)
- **SIP proxy:** UDP/TCP 5060
- **Version check:** `curl http://<your-server-ip>:3500/version`

## Send us players from your CRM

```bash
curl -X POST http://<your-server-ip>:3500/hook/players \
  -H "Authorization: Bearer <key from Settings → For your CRM → cabinet>" \
  -H "Content-Type: application/json" \
  -d '{ "phone": "+380958145553", "user_id": "12345" }'
```

Only `phone` is required; an array works too. If results must return to different
campaigns of your CRM, add that campaign's webhook id to the address —
`/hook/players/<webhook id>` — and set the address template once in
Settings → Your CRM endpoint. The full reference lives behind the **Docs** button in the
cabinet.

## Load your numbers

1. Open the cabinet UI and sign in.
2. Upload your number base (CSV or Excel) — each real number becomes a token.
3. Real numbers never leave this server; only tokens are shared with WinRiders.

## HTTPS for the cabinet UI (optional)

The service runs on plain HTTP port **3500** and does **not** touch ports 80/443, so it
won't interfere with anything else on the server. To serve the UI over HTTPS via Caddy,
run the helper — it adds one site to your Caddy config **without disturbing your other
sites** (it backs up and validates first):

```bash
sudo ./setup-caddy.sh cabinet.your-domain.com
```

(Point a DNS record at this server first. If you use a different reverse proxy, just
forward your domain to `http://127.0.0.1:3500`.)

## Hand back to WinRiders

Send us:

- your server's **public IP**;
- the **"For WinRiders → cabinet" key** — Settings → Inbound keys → Generate. We use it to
  post call results back to you.

Everything else (calling, carrier routing, the AI agent) is configured on our side.

## Operations

```bash
docker compose ps        # status
docker compose logs -f   # logs
./up.sh                  # start / restart (encryption keys are never regenerated)
./down.sh                # stop (data is kept)
```

## Updating

```bash
cd ..                    # the folder holding hidden-numbers-client
unzip -o hidden-numbers.zip
cd hidden-numbers-client && ./up.sh
curl http://localhost:3500/version
```

The archive carries `.env.example`, never a live `.env`, so your settings, keys and stored
numbers survive an update untouched.

## Notes

- Keep `keys.env` private and backed up — it holds your encryption keys.
- To enable outbound calling, fill **one** trunk block in `.env` and re-run `./up.sh`:
  `TRUNK_DIGEST_*` if your carrier authenticates by login and password,
  `TRUNK_IPAUTH_*` if it authorises your server's IP instead.
