# PostgreSQL 16 + PostGIS con pgBackRest (docs/08-despliegue.md, sección Backups).
# La misma imagen sirve para el servidor (archive-push / archive-get de los WAL) y para el sidecar
# `pgbackrest` del compose, que hace los backups diarios y las restauraciones.
FROM postgis/postgis:16-3.4

# postgis/postgis:16-3.4 trae Debian 11 (bullseye), ya sin soporte: sus repositorios pasaron a los
# archivos (archive.debian.org y apt-archive.postgresql.org). Desde ahí se aplican los últimos parches
# publicados (Debian LTS y PostgreSQL 16.x / PostGIS 3.4.x, actualizaciones menores compatibles con los
# datos) y se instala pgBackRest, con versión fijada para que todos los entornos y el simulacro de CI
# usen el mismo. Pendiente: migrar a una base con Debian 12 (docs/08-despliegue.md, "Riesgos conocidos").
# Sin curl ni nada extra: el aviso a ntfy del sidecar usa /dev/tcp de bash.
ARG PGBACKREST_VERSION=2.59.1-1.pgdg11+1
USER root
RUN printf '%s\n' \
      'deb http://archive.debian.org/debian bullseye main' \
      'deb http://archive.debian.org/debian bullseye-updates main' \
      'deb http://archive.debian.org/debian-security bullseye-security main' > /etc/apt/sources.list \
 && echo "deb [ signed-by=/usr/local/share/keyrings/postgres.gpg.asc ] http://apt-archive.postgresql.org/pub/repos/apt bullseye-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 # Sin preguntas: en un build no hay terminal y dpkg/debconf se quedaría esperando respuesta.
 && DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef upgrade -y \
 # postgresql-16 trae dependencias nuevas y `upgrade` lo retiene: se instala explícito (16.x menor).
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-confold \
      postgresql-16 "pgbackrest=${PGBACKREST_VERSION}" \
 && rm -rf /var/lib/apt/lists/* \
 # gosu solo sirve para bajar de root a postgres en el entrypoint; esta imagen ya arranca como postgres.
 && rm -f /usr/local/bin/gosu \
 && install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY backup-loop.sh /usr/local/bin/moda-backup-loop
RUN chmod 0644 /etc/pgbackrest/pgbackrest.conf && chmod 0755 /usr/local/bin/moda-backup-loop

ENV TZ=America/Guayaquil

# Sin root: el entrypoint oficial admite arrancar como postgres (los volúmenes ya son suyos, uid 999).
USER postgres

# Archivado continuo de WAL (PITR con RPO de ~1 minuto: archive_timeout fuerza un segmento por minuto
# aunque haya poca actividad). archive_command corre en el contenedor de postgres y escribe en el
# repositorio compartido con el sidecar (volumen pgbackrest).
CMD ["postgres", \
     "-c", "wal_level=replica", \
     "-c", "archive_mode=on", \
     "-c", "archive_command=pgbackrest --stanza=moda archive-push %p", \
     "-c", "archive_timeout=60", \
     "-c", "max_wal_senders=3"]
