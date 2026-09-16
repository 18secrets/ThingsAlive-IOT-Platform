#!/usr/bin/env bash
# Stops the backend and frontend started by dev-up.sh. Postgres is left
# running, since it holds data and is cheap to leave up between sessions;
# pass --with-db to stop it too.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || echo /opt/homebrew/Cellar/postgresql@18/18.3/bin/initdb)")"
PIDFILE="$ROOT/.devdata/dev.pids"

if [ -f "$PIDFILE" ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  echo "Backend and frontend stopped."
else
  echo "No dev.pids file — nothing tracked to stop."
fi

if [ "${1:-}" = "--with-db" ]; then
  "$PG_BIN/pg_ctl" -D "$ROOT/.devdata/pgdata" stop
  echo "Postgres stopped."
fi
