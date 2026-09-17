# Hidden Numbers — on-server cheat sheet

Full instructions live in the PDF WinRiders sent you (`INSTALL.pdf`). This file only
carries the commands you need on the server itself.

## First run

```bash
./up.sh          # creates .env from the template and stops
nano .env        # fill it in — the PDF explains every setting
./up.sh          # loads the bundled images and starts everything
```

Back up `keys.env` — it holds your encryption keys. Without it, tokens already issued
cannot be decrypted. WinRiders never sees this file.

## Everyday

```bash
docker compose ps                      # status
docker compose logs -f                 # logs
./up.sh                                # start / restart, keys are never regenerated
./down.sh                              # stop, data is kept
curl http://localhost:3500/version     # which version is running
./doctor.sh                            # what would stop the stack working
```

`doctor.sh` is the first thing to run when something is off: it reports missing keys, a
trunk branch without a gateway, a container that is down, an unreachable cabinet, and
results stuck in the delivery queue. It only reads, never changes anything.

## Ports the firewall must allow

| Port | Proto | What |
|------|-------|------|
| 5060 | UDP + TCP | SIP signalling |
| 30000-30500 | UDP | voice (RTP). Without these a call connects and both sides hear silence |
| 3500 | TCP | cabinet UI |

If this server reaches the internet through NAT (its public IP is not listed by
`ip -4 addr show`), set `RTPENGINE_INTERFACE=<private-ip>!<public-ip>` in `.env`,
otherwise the wrong address is advertised and audio goes nowhere.

The stack uses the Docker subnet `172.28.0.0/16`. If that range is already taken on
this host, `docker compose` refuses to create the network — free it or tell WinRiders.

Cabinet UI: `http://<your-server-ip>:3500` — login `admin`, password `CABINET_PASSWORD`
from `keys.env`. Everything about sending players and receiving results is behind the
**Docs** button inside the cabinet.

## Updating

```bash
cd ..                                  # the folder holding hidden-numbers-client
unzip -o hidden-numbers-<version>.zip
cd hidden-numbers-client && ./up.sh
curl http://localhost:3500/version     # confirm the new version is up
./doctor.sh                            # and that the stack is wired correctly
```

The archive ships `.env.example`, never a live `.env`, so your settings, keys and stored
numbers are untouched by an update.
