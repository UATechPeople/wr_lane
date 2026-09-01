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
```

Cabinet UI: `http://<your-server-ip>:3500` — login `admin`, password `CABINET_PASSWORD`
from `keys.env`. Everything about sending players and receiving results is behind the
**Docs** button inside the cabinet.

## Updating

```bash
cd ..                                  # the folder holding hidden-numbers-client
unzip -o hidden-numbers.zip
cd hidden-numbers-client && ./up.sh
curl http://localhost:3500/version     # confirm the new version is up
```

The archive ships `.env.example`, never a live `.env`, so your settings, keys and stored
numbers are untouched by an update.
