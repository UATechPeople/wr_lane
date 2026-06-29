FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates \
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

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]