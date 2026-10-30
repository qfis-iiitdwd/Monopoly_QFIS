#!/bin/sh
# Takes a compressed backup of the game database and proves it restores, by loading it into a
# scratch database and comparing row counts. Run before the event and between rounds.
#   sh scripts/backup.sh [label]
# Backs up the Supabase database (DATABASE_URL, from the environment or .env).
set -eu
cd "$(dirname "$0")/.."
. scripts/lib/pg.sh
LABEL="${1:-manual}"
TS=$(date +%Y%m%d-%H%M%S)
FILE="backups/marketverse-$TS-$LABEL.dump"
Q="SELECT (SELECT COUNT(*) FROM trades)||'/'||(SELECT COUNT(*) FROM ledger_entries)||'/'||(SELECT COUNT(*) FROM stock_prices)||'/'||(SELECT COALESCE(SUM(cash),0) FROM teams)"

# Only the game's schema: Supabase's own schemas (auth, storage, ...) are not ours to dump.
pg pg_dump -Fc -n public --no-owner --no-privileges "$DATABASE_URL" > "$FILE"
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
# Verify in a scratch PostgreSQL container, removed afterwards.
C=$(docker run -d --rm -e POSTGRES_PASSWORD=verify -v "$PWD/backups:/backups" "$PG_IMAGE")
trap 'docker rm -f "$C" >/dev/null 2>&1' EXIT
until docker exec "$C" pg_isready -U postgres -q 2>/dev/null; do sleep 1; done; sleep 1
# "schema public already exists" and the like are expected; the counts below are the check.
docker exec "$C" pg_restore -U postgres -d postgres --no-owner --no-privileges "/$FILE" 2>/dev/null || true
LIVE=$(pg psql "$DATABASE_URL" -tAc "$Q")
COPY=$(docker exec "$C" psql -U postgres -d postgres -tAc "$Q")
echo "trades/ledger/prices/total-cash  live: $LIVE  restored: $COPY"
if [ "$LIVE" = "$COPY" ]; then echo "VERIFIED: backup restores correctly."; else echo "WARNING: counts differ (trading may have continued during backup) — check manually."; fi
