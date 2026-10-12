# syntax=docker/dockerfile:1.7
#
# PostgreSQL image for the CloudNativePG cluster dam-pg18 (cluster side:
# matsubo/network-setting, k8s/dam.yaml). Built and pushed by
# .github/workflows/postgres-image.yml as
# ghcr.io/matsubo/dam-postgres:<PG>-ts<TimescaleDB>-tk<toolkit>-postgis<PostGIS>;
# the cluster pins it by digest.
#
# Base: CloudNativePG's minimal image (Debian trixie, PostgreSQL from PGDG,
# postgres = uid 26, no Barman: there is no object store). It already meets
# CNPG's requirements (initdb, postgres, pg_ctl, pg_controldata and
# pg_basebackup on PATH; C.UTF-8 is built into glibc). On top, the same
# extension versions the production catalog had on PostgreSQL 16 (the
# 2026-10 upgrade to 18 was a dump and restore, which needs them equal on
# both sides):
#   - TimescaleDB 2.26.4 from Timescale's packagecloud repository: the
#     Timescale License (TSL) edition, as in timescaledb-ha. The Apache-2
#     build lacks compression, which dam uses for chunks older than 30 days.
#     The loader must not be older than the extension, so it is pinned too.
#   - timescaledb_toolkit 1.22.0 (same repository)
#   - PostGIS 3.6.3 from PGDG
# pg_trgm and pgcrypto ship with PostgreSQL itself.
#
# Bump a version only together with `ALTER EXTENSION ... UPDATE` on the
# database (TimescaleDB: one psql -X session, see its update docs); a standby
# or a restored backup needs the .so of the version recorded in the catalog.
# PG_MAJOR must match the base image (the workflow's PG_VERSION too).
# The last PostgreSQL 16 build (rollback cluster dam-pg) stays in GHCR as
# 16.15-ts2.26.4-tk1.22.0-postgis3.6.3-81a79fe.
ARG BASE=ghcr.io/cloudnative-pg/postgresql:18.6-202610050823-minimal-trixie@sha256:37ade18dbdddba430858c72725aceeec66f33fa5333e82ea1df4942f6c1c83a3
FROM ${BASE}

ARG PG_MAJOR=18
ARG TIMESCALEDB_VERSION=2.26.4
ARG TIMESCALEDB_DEB=2.26.4~debian13-1803
ARG TOOLKIT_DEB=1:1.22.0~debian13
ARG POSTGIS_DEB=3.6.3+dfsg-1.pgdg13+1

USER root

# packagecloud's signing key (fingerprint 1005FB68604CE9B8F6879CF759F18EDF47F24417),
# pinned by checksum so a changed key fails the build instead of being trusted.
ADD --checksum=sha256:eb53bd3dc31e06fbf1ed769139f12b1fffaf1958a96c9b4f9727c19aada83321 \
    https://packagecloud.io/timescale/timescaledb/gpgkey /tmp/timescaledb.asc

RUN set -eux; \
    gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg /tmp/timescaledb.asc; \
    rm /tmp/timescaledb.asc; \
    echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ trixie main" \
      > /etc/apt/sources.list.d/timescaledb.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      "timescaledb-2-${TIMESCALEDB_VERSION}-postgresql-${PG_MAJOR}=${TIMESCALEDB_DEB}" \
      "timescaledb-2-loader-postgresql-${PG_MAJOR}=${TIMESCALEDB_DEB}" \
      "timescaledb-toolkit-postgresql-${PG_MAJOR}=${TOOLKIT_DEB}" \
      "postgresql-${PG_MAJOR}-postgis-3=${POSTGIS_DEB}" \
      "postgresql-${PG_MAJOR}-postgis-3-scripts=${POSTGIS_DEB}"; \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/* /var/cache/* /var/log/*

USER 26
