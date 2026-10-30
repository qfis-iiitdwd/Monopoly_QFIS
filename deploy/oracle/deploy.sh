#!/bin/bash
# Deploys (or updates) MarketVerse on an Oracle Cloud server, from this laptop.
#
#   deploy/oracle/deploy.sh ubuntu@<public-ip> [--database-url <url>] [--domain <name>] [--key ~/.ssh/id_ed25519]
#
# First run: sets the server up (Docker, firewall), copies the code and config/game.json, creates
# the server's .env with the database URL and a random admin password, and starts the app + Caddy (HTTPS).
# Later runs: copy the new code and rebuild. The .env and certificates are kept.
#
# The database is Supabase (docs/SUPABASE.md). --database-url is its session pooler URL; it defaults
# to DATABASE_URL from the environment or this laptop's .env, and is needed only on the first run
# (or to change it).
#
# --domain defaults to <ip-with-dashes>.sslip.io, a free name that points at the IP, so HTTPS works
# without buying a domain. The database is never exposed: only ports 80/443 (Caddy) are public.
# --port <n> if SSH runs on a non-standard port. CURL_INSECURE=1 accepts a self-signed certificate
# (only for testing with --domain localhost).
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${1:-}"; shift || true
DB_URL="${DATABASE_URL:-$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//")}"
DOMAIN=""; SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=20)
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --database-url) DB_URL="$2"; shift 2 ;;
    --key) SSH_OPTS+=(-i "$2"); shift 2 ;;
    --port) SSH_OPTS+=(-o "Port=$2"); shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[ -n "$HOST" ] || { sed -n 2,15p "$0"; exit 1; }
[ -f config/game.json ] || { echo "config/game.json is missing. It is the event config; the server needs it to seed."; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync("config/game.json","utf8"))' || { echo "config/game.json is not valid JSON"; exit 1; }

DIR=/opt/marketverse
IP="${HOST#*@}"
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr . -).sslip.io"
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
export RSYNC_RSH="ssh ${SSH_OPTS[*]}"

echo "== 1/5 connecting to $HOST"
remote true

if ! remote 'command -v docker >/dev/null && docker info >/dev/null 2>&1 && [ -d /opt/marketverse ]'; then
  echo "== first run: setting the server up (takes 2-4 minutes)"
  scp "${SSH_OPTS[@]}" deploy/oracle/server-setup.sh "$HOST:/tmp/server-setup.sh"
  remote 'sudo bash /tmp/server-setup.sh'
fi

echo "== 2/5 copying the code"
# Excluded paths are also protected from --delete, so the server's .env, config, backups and
# credentials survive updates.
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude 'frontend/node_modules' --exclude 'public/app' \
  --exclude '*.tsbuildinfo' --exclude .env --exclude 'config/' --exclude 'papers/' --exclude 'media/' \
  --exclude 'backups/' --exclude 'credentials*.csv' --exclude '*.xlsx' --exclude '*.csv' --exclude .DS_Store \
  ./ "$HOST:$DIR/"

echo "== 3/5 copying config/game.json (secret) and event material"
remote "mkdir -p $DIR/config $DIR/papers $DIR/media $DIR/backups"
rsync -az config/game.json "$HOST:$DIR/config/game.json"
[ -d papers ] && rsync -az --exclude .gitkeep papers/ "$HOST:$DIR/papers/"
[ -d media ] && rsync -az --exclude .gitkeep media/ "$HOST:$DIR/media/"
# Readable by the container's user; the server has no other users.
remote "chmod 755 $DIR/config && chmod 644 $DIR/config/game.json"

echo "== 4/5 server settings (.env)"
# The URL travels base64-encoded so no character in the password needs quoting.
remote "DIR=$DIR DOMAIN=$DOMAIN DB_URL_B64=$(printf %s "$DB_URL" | base64 | tr -d '\n') bash -s" <<'EOF'
set -euo pipefail
cd "$DIR"
DB_URL=$(echo "$DB_URL_B64" | base64 -d)
if [ ! -f .env ]; then
  [ -n "$DB_URL" ] || { echo "First deploy: pass --database-url '<Supabase session pooler URL>' (docs/SUPABASE.md)."; exit 1; }
  ADMIN=$(openssl rand -base64 18 | tr -d '/+=')
  cat > .env <<ENV
COMPOSE_FILE=docker-compose.prod.yml
DOMAIN=$DOMAIN
ADMIN_PASSWORD=$ADMIN
DB_POOL_SIZE=20
ENV
  chmod 600 .env
  echo "Created .env. ADMIN PASSWORD (save it now; it's also in $DIR/.env on the server): $ADMIN"
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
  echo "Kept the existing .env (domain: $DOMAIN)."
fi
if [ -n "$DB_URL" ]; then
  # Single quotes: Docker Compose would otherwise expand any $ in the password.
  grep -v '^DATABASE_URL=' .env > .env.tmp || true
  printf "DATABASE_URL='%s'\n" "$DB_URL" >> .env.tmp
  mv .env.tmp .env && chmod 600 .env
  echo "Database: $(echo "$DB_URL" | sed 's|//[^@]*@|//|')"
elif ! grep -q '^DATABASE_URL=' .env; then
  echo "This server's .env has no DATABASE_URL (it used the old built-in PostgreSQL)."
  echo "Pass --database-url '<Supabase session pooler URL>'. To keep the current game, see 'Moving an existing game' in docs/SUPABASE.md."
  exit 1
fi
EOF

echo "== 5/5 building and starting (first build takes 2-4 minutes)"
if ! remote "cd $DIR && docker compose up -d --build --quiet-pull --remove-orphans > /tmp/mv-build.log 2>&1"; then
  echo "BUILD/START FAILED. Last lines of the log:"; remote "tail -30 /tmp/mv-build.log"; exit 1
fi
remote "cd $DIR && docker compose ps --format '{{.Service}}: {{.Status}}'"

echo "== waiting for https://$DOMAIN/api/health"
for i in $(seq 1 60); do
  if curl -fsS ${CURL_INSECURE:+-k} --max-time 5 "${HEALTH_URL:-https://$DOMAIN/api/health}" >/dev/null 2>&1; then
    echo; echo "LIVE:  https://$DOMAIN/        (players)"
    echo "       https://$DOMAIN/admin/  (organisers, user: admin)"
    if ! remote "cd $DIR && docker compose exec -T app node -e \"require('./src/db').query('SELECT 1 FROM teams LIMIT 1').then((r) => { console.log(r.rowCount); process.exit(0); }, () => process.exit(1))\"" 2>/dev/null | grep -q 1; then
      echo; echo "The database is empty. Seed it next:"
      echo "  deploy/oracle/seed.sh $HOST --practice     # fixed test passwords, for testers"
      echo "  deploy/oracle/seed.sh $HOST --real         # real random passwords, for the event"
    fi
    exit 0
  fi
  sleep 5; printf .
done
echo
echo "The app did not answer over HTTPS within 5 minutes. Check:"
echo "  1. Oracle console: the subnet's security list allows TCP 80 and 443 from 0.0.0.0/0"
echo "  2. ssh $HOST 'cd $DIR && docker compose ps && docker compose logs --tail 50 caddy app'"
echo "  3. database errors in the app log: check DATABASE_URL in $DIR/.env against docs/SUPABASE.md"
exit 1
