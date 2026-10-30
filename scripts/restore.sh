#!/bin/sh
# Restores the game database from a backup. STOP THE APP SERVER FIRST.
#   sh scripts/restore.sh backups/marketverse-....dump
set -eu
cd "$(dirname "$0")/.."
FILE="${1:?usage: restore.sh <backup.dump>}"
[ -f "$FILE" ] || { echo "No such file: $FILE"; exit 1; }
printf "This REPLACES the live database with %s. Type RESTORE to continue: " "$FILE"
read ans
[ "$ans" = "RESTORE" ] || { echo "Aborted."; exit 1; }
DC="docker compose exec -T db"
$DC psql -U marketverse -d postgres -q -c "DROP DATABASE IF EXISTS marketverse WITH (FORCE)" -c "CREATE DATABASE marketverse"
$DC pg_restore -U marketverse -d marketverse --no-owner < "$FILE"
echo "Restored. Start the server, log in to the admin panel and run the integrity check (Audit & health tab)."
