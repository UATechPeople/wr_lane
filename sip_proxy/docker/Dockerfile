FROM kamailio/kamailio:5.8-bullseye

RUN apt-get update && apt-get install -y --no-install-recommends \
    kamailio-extra-modules \
    kamailio-utils-modules \
    kamailio-postgres-modules \
    kamailio-json-modules \
    kamailio-sqlite-modules \
    && rm -rf /var/lib/apt/lists/*


COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]