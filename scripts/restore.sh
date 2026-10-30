#!/bin/sh
# Restores the game database from a backup. STOP THE APP SERVER FIRST.
#   sh scripts/restore.sh backups/marketverse-....dump
# Restores into the Supabase database (DATABASE_URL, from the environment or .env). It also loads
# dumps of the old self-hosted PostgreSQL: that is how a running game moves over.
set -eu
cd "$(dirname "$0")/.."
. scripts/lib/pg.sh
FILE="${1:?usage: restore.sh <backup.dump>}"
[ -f "$FILE" ] || { echo "No such file: $FILE"; exit 1; }
case "$(cd "$(dirname "$FILE")" && pwd)" in "$PWD/backups") ;; *) echo "Put the dump in backups/ first."; exit 1 ;; esac
TARGET=$(echo "$DATABASE_URL" | sed 's|//[^@]*@|//|')
printf "This REPLACES the live database (%s) with %s. Type RESTORE to continue: " "$TARGET" "$FILE"
read ans
[ "$ans" = "RESTORE" ] || { echo "Aborted."; exit 1; }

# Supabase databases can't be dropped and recreated, so the tables (created by the app at startup)
# are emptied and refilled in one transaction: on any error nothing changes.
# session_replication_role = replica skips foreign-key checks while tables load in dump order.
TABLES=$(pg pg_restore -l "/backups/$(basename "$FILE")" | awk '$4 == "TABLE" && $5 == "DATA" && $6 == "public" {printf "%spublic.%s", s, $7; s=", "}')
[ -n "$TABLES" ] || { echo "No game tables in $FILE"; exit 1; }
pg psql "$DATABASE_URL" -tAc "SELECT 1 FROM teams LIMIT 0" >/dev/null 2>&1 \
  || { echo "The game tables don't exist yet: start the app once against this database, then run this again."; exit 1; }
{ echo "SET session_replication_role = replica;"
  echo "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"
  # transaction_timeout is PostgreSQL 17+; older Supabase projects (15) reject it.
  pg pg_restore --data-only --no-owner --no-privileges -f - "/backups/$(basename "$FILE")" | sed '/^SET transaction_timeout/d'
} | pg psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null
echo "Restored. Start the server, log in to the admin panel and run the integrity check (Audit & health tab)."
