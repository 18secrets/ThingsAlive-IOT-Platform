#!/usr/bin/env bash
# Brings up Postgres, the backend and the frontend console for local
# development, then prints where each one is reachable — including on the
# LAN, so the console can be opened from another device.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || echo /opt/homebrew/Cellar/postgresql@18/18.3/bin/initdb)")"
DATADIR="$ROOT/.devdata/pgdata"
PIDDIR="$ROOT/.devdata"
PGPORT=5433
BACKEND_PORT=8080
FRONTEND_PORT=3000
PIDFILE="$PIDDIR/dev.pids"

mkdir -p "$PIDDIR"

lan_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown"
}

stop_previous_run() {
  [ -f "$PIDFILE" ] || return 0
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done < "$PIDFILE"
  rm -f "$PIDFILE"
}

echo "==> Postgres (localhost:$PGPORT, db ta2)"
if "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" >/dev/null 2>&1; then
  echo "    already running"
else
  LC_ALL=C OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES \
    "$PG_BIN/pg_ctl" -D "$DATADIR" -o "-p $PGPORT" -l "$PIDDIR/pg.log" start
fi

stop_previous_run

echo "==> Backend (rebuilding)"
cd "$ROOT"
set -a; source .env; set +a
npm run build >> "$PIDDIR/backend.log" 2>&1
nohup node dist/main.js >> "$PIDDIR/backend.log" 2>&1 &
echo "$!" >> "$PIDFILE"
disown

echo "==> Frontend"
cd "$ROOT/frontend"
nohup npm run dev >> "$PIDDIR/frontend.log" 2>&1 &
echo "$!" >> "$PIDFILE"
disown
cd "$ROOT"

echo "==> Waiting for both to answer"
for i in $(seq 1 40); do
  curl -s "http://localhost:$BACKEND_PORT/api/v1/health" >/dev/null 2>&1 && backend_up=1 && break
  sleep 0.5
done
for i in $(seq 1 40); do
  curl -s "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1 && frontend_up=1 && break
  sleep 0.5
done

IP="$(lan_ip)"
echo
echo "================================================================"
echo " Postgres    postgresql://postgres@localhost:$PGPORT/ta2"
echo " Backend     ${backend_up:+UP  }${backend_up:-DOWN}"
echo "             http://localhost:$BACKEND_PORT/api/v1"
echo "             http://$IP:$BACKEND_PORT/api/v1"
echo " Frontend    ${frontend_up:+UP  }${frontend_up:-DOWN}"
echo "             http://localhost:$FRONTEND_PORT"
echo "             http://$IP:$FRONTEND_PORT"
echo "================================================================"
echo " Logs: $PIDDIR/{backend,frontend,pg}.log"
echo " Stop: scripts/dev-down.sh"
