#!/bin/sh
set -eu

echo "Starting Gmatez API (NODE_ENV=${NODE_ENV:-unset})"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Link the Render Postgres database and redeploy."
  exit 1
fi

# External Render Postgres requires SSL. The private hostname does not.
case "$DATABASE_URL" in
  *".render.com"*)
    case "$DATABASE_URL" in
      *sslmode=*) ;;
      *\?*) DATABASE_URL="${DATABASE_URL}&sslmode=require" ;;
      *) DATABASE_URL="${DATABASE_URL}?sslmode=require" ;;
    esac
    export DATABASE_URL
    echo "Using external Postgres with sslmode=require"
    ;;
  *)
    echo "Using private database host"
    ;;
esac

attempt=1
until npx prisma migrate deploy; do
  if [ "$attempt" -ge 8 ]; then
    echo "prisma migrate deploy failed after ${attempt} attempts"
    exit 1
  fi
  echo "Database not ready (attempt ${attempt}/8). Retrying in 5s..."
  attempt=$((attempt + 1))
  sleep 5
done

if [ "${SEED_DEMO:-}" = "true" ]; then
  echo "Seeding demo accounts"
  node dist/seed/seed.js
fi

echo "Starting server"
exec node dist/main.js
