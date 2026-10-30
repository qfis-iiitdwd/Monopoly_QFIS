# Sourced by backup.sh and restore.sh (from the repo root).
# DATABASE_URL comes from the environment or .env (the Supabase connection string).
# pg <tool> <args...> runs a PostgreSQL client tool (pg_dump, pg_restore, psql) in a throwaway
# container, so nothing needs installing. Its major version must be ≥ the server's (Supabase: 15 or 17).
[ -n "${DATABASE_URL:-}" ] || DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//")
[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL is not set: put the Supabase session pooler URI in .env (docs/SUPABASE.md)."; exit 1; }
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
pg() { docker run --rm -i -v "$PWD/backups:/backups" "$PG_IMAGE" "$@"; }
