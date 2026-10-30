#!/bin/bash
# Seeds (resets) the game database on the Oracle server, from this laptop. DESTROYS the current game.
#
#   deploy/oracle/seed.sh ubuntu@<ip> --practice [--short-rounds]
#       Fixed test passwords (team01 / pw-team01 …) for testers. --short-rounds makes every round
#       20 s with the Margin Bank on, which the stress suite needs.
#   deploy/oracle/seed.sh ubuntu@<ip> --real
#       Real random passwords for the event. Asks you to type RESET first. The team logins are
#       written to ./credentials.csv on this laptop only (git-ignored); print them and keep the file safe.
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${1:-}"; shift || true
MODE=""; SHORT=0; SSH_OPTS=(-o ConnectTimeout=15)
while [ $# -gt 0 ]; do
  case "$1" in
    --practice) MODE=practice; shift ;;
    --real) MODE=real; shift ;;
    --short-rounds) SHORT=1; shift ;;
    --key) SSH_OPTS+=(-i "$2"); shift 2 ;;
    --port) SSH_OPTS+=(-o "Port=$2"); shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[ -n "$HOST" ] && [ -n "$MODE" ] || { sed -n 2,10p "$0"; exit 1; }
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
DC="cd /opt/marketverse && docker compose"

CFG=/app/config/game.json
if [ "$SHORT" = 1 ]; then
  remote "$DC exec -T app node -e 'const c=require(\"/app/config/game.json\");c.rounds.forEach(r=>r.duration_seconds=20);c.settings.loans.enabled=true;require(\"fs\").writeFileSync(\"/tmp/short.json\",JSON.stringify(c))'"
  CFG=/tmp/short.json
fi

if [ "$MODE" = practice ]; then
  remote "$DC exec -T app node scripts/seed.js --reset --force --test-passwords --config $CFG --out -" > /dev/null
  echo "Seeded for practice. Team logins: team01 / pw-team01 … team50 / pw-team50. Admin: admin / (ADMIN_PASSWORD in the server's .env)"
else
  printf "This WIPES the game on %s and creates real passwords. Type RESET to continue: " "$HOST"
  read -r ans; [ "$ans" = RESET ] || { echo "Aborted."; exit 1; }
  [ ! -f credentials.csv ] || mv credentials.csv "credentials-$(date +%Y%m%d-%H%M%S).old.csv"
  remote "$DC exec -T app node scripts/seed.js --reset --force --config $CFG --out -" > credentials.csv
  chmod 600 credentials.csv
  echo "Seeded for the event. Team logins: $(pwd)/credentials.csv ($(($(wc -l < credentials.csv) - 1)) teams). Not stored on the server."
fi
# Restart so in-memory caches (sessions, remembered logins) start clean with the new passwords.
remote "$DC restart app >/dev/null && sleep 3 && $DC exec -T app node scripts/preflight.js" || true
