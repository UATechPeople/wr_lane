FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates netbase sqlite3 \
    && curl -fsSL https://deb.kamailio.org/kamailiodebkey.gpg \
       | gpg --dearmor -o /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] \
       http://deb.kamailio.org/kamailio58 bullseye main" \
       > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    kamailio \
    kamailio-extra-modules \
    kamailio-utils-modules \
    kamailio-json-modules \
    kamailio-sqlite-modules \
    && rm -rf /var/lib/apt/lists/*

# Bake the config into the image so it works without a compose volume mount (e.g. Railway).
# Under docker-compose the read-only volume mount overrides this, so it stays harmless there.
COPY kamailio/kamailio.cfg /etc/kamailio/kamailio.cfg

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]