#!/usr/bin/env bash
# Typecheck without downloading the Alpine Prisma engine (blocked in some sandboxes).
# Temporarily narrows binaryTargets, runs the gate, and restores the schema line whatever happens.
set -u
cd "$(dirname "$0")/.."
SCHEMA=packages/database/prisma/schema.prisma
cp "$SCHEMA" /tmp/schema.prisma.bak
sed -i 's/binaryTargets = \["native", "linux-musl-openssl-3.0.x"\]/binaryTargets = ["native"]/' "$SCHEMA"
pnpm run "${1:-typecheck}"; status=$?
cp /tmp/schema.prisma.bak "$SCHEMA"
exit $status
