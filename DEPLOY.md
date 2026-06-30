# Deploy — Hidden Numbers bundle

Full bundle (cabinet UI + detokenize sidecar + kamailio SIP proxy) on a single
DigitalOcean droplet, deployed with **Kamal 2**. Images build locally and push to
GitHub Container Registry (ghcr); the droplet only pulls. There is **no CI** — the
org's GitHub Actions billing is disabled, so every deploy is run from a laptop.

## What runs where

| Container | Kind | Port | Role |
| --- | --- | --- | --- |
| `kamal-proxy` | Kamal proxy | 80 / 443 | routes to cabinet, future TLS |
| `wr_lane-web-<sha>` | Kamal **app** | 3500 (via proxy) | cabinet UI (`/`), healthcheck `/health` |
| `wr_lane-detoken` | Kamal **accessory** | 3501 (internal) | detokenize sidecar — same cabinet image, pure FF3, no DB; stable name kamailio calls |
| `wr_lane-kamailio` | Kamal **accessory** | 5060/udp | SIP proxy; resolves real number via `http://wr_lane-detoken:3501/detokenize` at call time |

- Droplet: **157.245.75.233**, ssh `root@` (ed25519 key).
- Images: `ghcr.io/risklight/wr_lane-{cabinet,kamailio}` (personal namespace — see
  [Moving to the org registry](#moving-to-the-org-registry)).
- Cabinet: **http://157.245.75.233**, login `admin` / `CABINET_PASSWORD`. Plain HTTP
  (no domain yet) — set `proxy.ssl: true` + `host:` in `config/deploy.yml` once a
  domain exists.

## One-time setup (per deployer machine)

1. **Docker** (host can be OrbStack or Docker Desktop) + the buildx builder:
   ```bash
   docker buildx create --name wrbuild --use      # one-time; amd64 via emulation
   ```
2. **ssh key** on the droplet: your public key in `root@157.245.75.233:~/.ssh/authorized_keys`,
   and loaded in your agent (`ssh-add`). The dockerised Kamal runner mounts `~/.ssh`.
3. **ghcr PAT** — a **classic** token with `write:packages` (fine-grained PATs fail on
   ghcr org packages). Export it before any deploy:
   ```bash
   export KAMAL_REGISTRY_PASSWORD=<ghcr PAT>
   ```
4. **`.env.droplet`** at the repo root — all real secrets (FF3 keys, cabinet password,
   trunk creds). It is **gitignored**; never commit it. Get it from `passdb` / shared
   vault. `.kamal/secrets` reads values out of it; the registry PAT comes from the env.

> Kamal runs **dockerised** (`bin/kamal`) because system ruby is too old. The wrapper
> mounts the docker socket, `~/.ssh`, and a sanitised docker config (host
> `credsStore=osxkeychain` / `currentContext=orbstack` are stripped — they don't exist
> inside the linux container).

## Deploy

```bash
export KAMAL_REGISTRY_PASSWORD=<ghcr PAT>

bin/deploy                  # FULL bundle: build+push kamailio, kamal deploy cabinet, reboot accessories
```

Narrower flows when you know what changed:

```bash
# cabinet code only (src/, public/) — kamal builds + pushes + redeploys the web app
bin/kamal deploy
bin/kamal accessory reboot detoken     # detoken shares the cabinet image; refresh it too if needed

# kamailio only (kamailio.cfg / sip_proxy Dockerfile) — kamal does NOT build accessories
docker buildx build --platform linux/amd64 --builder wrbuild \
  -t ghcr.io/risklight/wr_lane-kamailio:latest \
  -f ./sip_proxy/docker/Dockerfile --push ./sip_proxy
bin/kamal accessory reboot kamailio

# creds only (.env.droplet) — no rebuild
bin/kamal env push                     # cabinet web env
bin/kamal app boot                     # restart web with new env
bin/kamal accessory reboot kamailio    # and/or detoken
```

> `git push` and deploy are **independent**. Kamal builds from your local working
> files, not from GitHub. Push to git only to share source / history.

## Editing creds without a laptop

The env already lives on the droplet (Kamal uploaded it). With ssh alone you can edit
and apply — no repo, no registry:

```bash
ssh root@157.245.75.233
nano ~/.kamal/apps/wr_lane/env/accessories/kamailio.env   # or roles/web.env, accessories/detoken.env
docker restart wr_lane-kamailio
```

Caveat: a later `kamal deploy` / `kamal env push` from a laptop **overwrites** these
files from that laptop's `.env.droplet`. Pick one source of truth — keep `.env.droplet`
updated too, or agree that nobody runs `env push` blindly.

## Verifying

```bash
curl http://157.245.75.233/health                         # {"ok":true,...}
ssh root@157.245.75.233 'docker ps --format "{{.Names}}\t{{.Status}}"'
ssh root@157.245.75.233 'docker logs wr_lane-kamailio 2>&1 | tail'
```
Detokenize round-trip (proves FF3 + the kamailio→detoken path):
```bash
ssh root@157.245.75.233 'docker exec wr_lane-detoken bun -e "
const r=await fetch(\"http://localhost:3501/detokenize?t=<token-digits>\",{headers:{\"x-decrypt-key\":process.env.DECRYPT_KEY}});
console.log(r.status, JSON.stringify(await r.json()))"'
```

---

## Moving to the org registry

Today images live under the **personal** namespace `ghcr.io/risklight/*`, so only
RiskLight's account can push. To let any org member build & push, move them to
`ghcr.io/uatechpeople/*`. The blocker is that the org currently **denies package
creation** (`docker push` → `denied: permission_denied: create_package`).

**TODO — steps to migrate (an org owner is required for step 1):**

1. **Enable package creation in the org.** GitHub → `UATechPeople` → Settings →
   Member privileges / Packages → allow members to create (publish) packages. (Owner
   only — that's why this is blocked today.)
2. **Repoint the image namespace** — `config/deploy.yml`, three places:
   - `image: uatechpeople/wr_lane-cabinet`
   - `accessories.detoken.image: ghcr.io/uatechpeople/wr_lane-cabinet:latest`
   - `accessories.kamailio.image: ghcr.io/uatechpeople/wr_lane-kamailio:latest`

   And `bin/deploy`: run with `WR_GHCR_NS=uatechpeople bin/deploy` (or change the
   `NS` default in the script).
3. **First push creates the packages** under the org (needs a classic PAT with
   `write:packages`). `WR_GHCR_NS=uatechpeople bin/deploy`.
4. **Grant access via the repo.** In each package's settings → "Inherit access from
   repository" and connect it to `wr_lane`. Then repo collaborators (you + Danil) get
   push/pull automatically. (Or add members/teams with `write` manually.)
5. **Droplet pull.** It logs into ghcr with the deploy PAT — make sure that PAT's owner
   has `read` on the org packages (org member, or set the packages to Internal/Public).
6. Redeploy: `WR_GHCR_NS=uatechpeople bin/deploy`, then drop the old `risklight/*`
   packages.

> Alternative if the org can't enable package creation: keep `risklight/*`, make the
> packages **public** so the droplet pulls without auth, and accept that only RiskLight
> can build/push (others can still edit creds + reboot via ssh).
