# Deploy — Hidden Numbers

Everything ships as one archive. There is no registry access, no CI and no deploy tool:
images are built locally, saved into the bundle, and loaded on the target host.

## Building the bundle

```bash
cd sip_proxy && docker buildx build --platform linux/amd64 -f docker/Dockerfile -t ghcr.io/uatechpeople/wr_lane-kamailio:latest --load . && cd ..
docker buildx build --platform linux/amd64 --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) -t ghcr.io/uatechpeople/wr_lane-cabinet:latest --load .
docker pull --platform linux/amd64 drachtio/rtpengine:latest

docker save ghcr.io/uatechpeople/wr_lane-cabinet:latest \
            ghcr.io/uatechpeople/wr_lane-kamailio:latest \
            drachtio/rtpengine:latest | gzip -1 > images.tar.gz
```

Put `images.tar.gz` next to the files from `client-deploy/` and zip the folder as
`hidden-numbers-client/`, naming the archive after the cabinet version from `package.json`:
`hidden-numbers-<version>.zip`. The archive carries `.env.example`, never a live `.env`.

## Installing or updating a host

```bash
scp hidden-numbers-<version>.zip root@<host>:~/
ssh root@<host>
unzip -o hidden-numbers-<version>.zip && cd hidden-numbers-client
./up.sh                                   # first run creates .env from the template
curl http://localhost:3500/version        # confirm the build that is running
./doctor.sh                               # what is missing or broken, in one screen
```

`up.sh` generates the encryption keys once into `keys.env`, loads the bundled images and
starts cabinet + kamailio + rtpengine. Updates reuse the same command; the client's `.env`,
keys and stored numbers are untouched.

## Our test host

`157.245.75.233` runs the same bundle in `/root/hn/hidden-numbers-client`, installed the
same way. To push a rebuilt image without shipping a whole archive:

```bash
docker save ghcr.io/uatechpeople/wr_lane-cabinet:latest | gzip -1 | ssh root@157.245.75.233 'gunzip | docker load'
ssh root@157.245.75.233 'cd /root/hn/hidden-numbers-client && set -a && . ./.env && . ./keys.env && set +a && docker compose up -d --force-recreate cabinet'
```

Sourcing both env files is required — compose reads `FF3_KEY` and `DECRYPT_KEY` from the
shell, and the container crash-loops without them.
