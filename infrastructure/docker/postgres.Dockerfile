# PostgreSQL 16 on Alpine, plus pgvector.
#
# Why not the upstream `pgvector/pgvector:pg16` image: it is Debian-based, and this database was
# initialised on Alpine (musl). The two libcs collate `en_US.utf8` differently, and a data
# directory moved between them keeps its B-tree indexes on text columns in an order the new
# libc disagrees with - which is silent corruption until a lookup misses. Staying on the same base
# image and compiling the extension in is the boring, safe option.
#
# The official image carries its own pg_config and server headers under /usr/local, so the
# extension builds against those; Alpine's postgresql-dev package would install a second, different
# PostgreSQL and must not be added. Bitcode for JIT is skipped (with_llvm=no): the extension's
# hot loop is plain C either way, and it saves pulling in clang.
FROM postgres:16-alpine

ARG PGVECTOR_VERSION=v0.8.0

RUN set -eux; \
    apk add --no-cache --virtual .build-deps build-base git; \
    git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make with_llvm=no OPTFLAGS=""; \
    make with_llvm=no install; \
    rm -rf /tmp/pgvector; \
    apk del .build-deps
