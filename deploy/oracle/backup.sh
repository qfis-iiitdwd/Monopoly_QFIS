#!/bin/bash
# Backs up the game database on the Oracle server (verified by a test restore there), then copies
# the dump to ./backups/ on this laptop, so a copy survives even if the server is lost.
#
#   deploy/oracle/backup.sh ubuntu@<ip> [label] [--port <n>] [--key <file>]     e.g. label pre-event, after-r3
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${1:?usage: deploy/oracle/backup.sh ubuntu@<ip> [label]}"; shift
LABEL=manual; SSH_OPTS=(-o ConnectTimeout=15)
while [ $# -gt 0 ]; do
  case "$1" in
    --key) SSH_OPTS+=(-i "$2"); shift 2 ;;
    --port) SSH_OPTS+=(-o "Port=$2"); shift 2 ;;
    *) LABEL="$1"; shift ;;
  esac
done
OUT=$(ssh "${SSH_OPTS[@]}" "$HOST" "cd /opt/marketverse && sh scripts/backup.sh $LABEL")
echo "$OUT"
FILE=$(echo "$OUT" | sed -n 's/^Backup written: \([^ ]*\).*/\1/p')
mkdir -p backups
scp -q "${SSH_OPTS[@]}" "$HOST:/opt/marketverse/$FILE" backups/
echo "Copied to $(pwd)/$FILE"
