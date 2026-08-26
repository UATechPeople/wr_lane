# Hidden Numbers — quick start

Deploy the number-anonymization service on your own server. Real phone numbers and the
encryption keys stay entirely on this server; WinRiders only ever receives tokens.

## What you need

- One Linux server with **Docker** (including `docker compose`).
- A **public IP** on that server, with **UDP and TCP port 5060 open** (SIP).
- The bundle archive WinRiders sent you (`hidden-numbers.zip`). There is **no source code**
  and **no registry/token** — the ready-made images are **bundled inside the archive** and
  loaded locally.

## Deploy (one command)

```bash
unzip hidden-numbers.zip -d hidden-numbers && cd hidden-numbers
./up.sh
```

`up.sh` loads the bundled images and starts everything. `.env` is pre-filled; your server's
public IP is auto-detected.

- **Cabinet UI:** `http://<your-server-ip>:3500` (login: `admin` / `CABINET_PASSWORD` in `.env`)
- **SIP proxy:** UDP/TCP 5060

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

Send us your server's **public IP** — everything else (calling, carrier routing, the AI
agent) is configured on our side.

## Operations

```bash
docker compose ps        # status
docker compose logs -f   # logs
./up.sh                  # restart (reloads the bundled images)
docker compose down      # stop
```

## Notes

- Keep `.env` private — it holds your encryption keys.
- To enable outbound calling, fill your SIP-trunk creds in `.env`
  (`MMD_GW_IP` / `MMD_GW_PORT` / `MMD_AUTH_USER` / `MMD_AUTH_PASS`) and re-run `./up.sh`.
