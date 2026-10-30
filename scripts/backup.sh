#!/bin/sh
# Takes a compressed backup of the game database and proves it restores, by loading it into a
# scratch database and comparing row counts. Run before the event and between rounds.
#   sh scripts/backup.sh [label]
set -eu
cd "$(dirname "$0")/.."
LABEL="${1:-manual}"
TS=$(date +%Y%m%d-%H%M%S)
FILE="backups/marketverse-$TS-$LABEL.dump"
DC="docker compose exec -T db"

$DC pg_dump -U marketverse -Fc marketverse > "$FILE"
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Verify: restore into a throwaway database and compare key counts.
$DC psql -U marketverse -d postgres -q -c "DROP DATABASE IF EXISTS marketverse_verify" -c "CREATE DATABASE marketverse_verify" >/dev/null
$DC pg_restore -U marketverse -d marketverse_verify --no-owner < "$FILE"
Q="SELECT (SELECT COUNT(*) FROM trades)||'/'||(SELECT COUNT(*) FROM ledger_entries)||'/'||(SELECT COUNT(*) FROM stock_prices)||'/'||(SELECT COALESCE(SUM(cash),0) FROM teams)"
LIVE=$($DC psql -U marketverse -d marketverse -tAc "$Q")
COPY=$($DC psql -U marketverse -d marketverse_verify -tAc "$Q")
$DC psql -U marketverse -d postgres -q -c "DROP DATABASE marketverse_verify" >/dev/null
echo "trades/ledger/prices/total-cash  live: $LIVE  restored: $COPY"
if [ "$LIVE" = "$COPY" ]; then echo "VERIFIED: backup restores correctly."; else echo "WARNING: counts differ (trading may have continued during backup) — check manually."; fi
