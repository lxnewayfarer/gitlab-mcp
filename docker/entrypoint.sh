#!/bin/sh
set -e

# Apply database migrations before starting (idempotent).
echo "[entrypoint] running prisma migrate deploy..."
npx prisma migrate deploy

echo "[entrypoint] starting: $*"
exec "$@"
