# motor_logger_http_server.py
#
# HTTP server that receives bulk sensor data POSTs from motor-logger devices
# (SIM800L GSM modems) and stores them in PostgreSQL.
#
# Endpoint: POST /api/sensor-data/bulk
# Success reply: {"status":"ok","ack_seq":<last_seq>}  (single line, < 90 bytes)
#
# Run:
#   python3 motor_logger_http_server.py
#   MOTOR_HTTP_PORT=8080 python3 motor_logger_http_server.py

import json
import os
import queue
import threading
import traceback
import atexit
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from flask import Flask, request, Response, stream_with_context

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ---------------------------
# Config from env
# ---------------------------
DEBUG_MOTOR = os.getenv("DEBUG_MOTOR", "1") == "1"

MOTOR_HTTP_HOST = os.getenv("MOTOR_HTTP_HOST", "0.0.0.0")
MOTOR_HTTP_PORT = int(os.getenv("MOTOR_HTTP_PORT", "8080"))

MAX_BODY_BYTES = int(os.getenv("MOTOR_MAX_BODY_BYTES", "8192"))   # firmware default ~6 000
MAX_RECORDS_PER_REQUEST = int(os.getenv("MOTOR_MAX_RECORDS", "50"))

MOTOR_RAW_JSON_PATH = Path(
    os.getenv("MOTOR_RAW_JSON_PATH") or PROJECT_ROOT / "data" / "motor_raw"
)
MOTOR_RAW_JSON_ASYNC = os.getenv("MOTOR_RAW_JSON_ASYNC", "1").strip().lower() in (
    "1", "true", "yes", "y", "on"
)
MOTOR_RAW_JSON_FSYNC = os.getenv("MOTOR_RAW_JSON_FSYNC", "1").strip().lower() in (
    "1", "true", "yes", "y", "on"
)
MOTOR_RAW_JSON_QUEUE_MAX = int(os.getenv("MOTOR_RAW_JSON_QUEUE_MAX", "10000"))
MOTOR_RAW_JSON_BATCH_SIZE = int(os.getenv("MOTOR_RAW_JSON_BATCH_SIZE", "100"))
MOTOR_RAW_JSON_FLUSH_INTERVAL_S = float(os.getenv("MOTOR_RAW_JSON_FLUSH_INTERVAL_S", "0.5"))

# Alert when lost_total or dropped_total exceed this across any single request
MOTOR_ALERT_LOST_THRESHOLD = int(os.getenv("MOTOR_ALERT_LOST_THRESHOLD", "0"))
MOTOR_ALERT_DROPPED_THRESHOLD = int(os.getenv("MOTOR_ALERT_DROPPED_THRESHOLD", "0"))

# ---------------------------
# Async raw-JSON writer
# ---------------------------
_raw_json_lock = threading.Lock()
_raw_json_queue = queue.Queue(maxsize=MOTOR_RAW_JSON_QUEUE_MAX)
_raw_json_stop = threading.Event()
_raw_json_writer_started = False


def _write_jsonl_sync(path: Path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    with _raw_json_lock:
        with path.open("a", encoding="utf-8") as f:
            f.writelines(lines)
            f.flush()
            if MOTOR_RAW_JSON_FSYNC:
                os.fsync(f.fileno())


def _raw_json_writer_loop():
    batch = []
    while not _raw_json_stop.is_set() or not _raw_json_queue.empty():
        try:
            item = _raw_json_queue.get(timeout=MOTOR_RAW_JSON_FLUSH_INTERVAL_S)
            batch.append(item)
        except queue.Empty:
            pass

        while len(batch) < MOTOR_RAW_JSON_BATCH_SIZE:
            try:
                item = _raw_json_queue.get_nowait()
                batch.append(item)
            except queue.Empty:
                break

        if batch:
            try:
                by_path = {}
                for p, line in batch:
                    by_path.setdefault(p, []).append(line)
                for p, lines in by_path.items():
                    _write_jsonl_sync(p, lines)
            except Exception as exc:
                print(f"[ERROR] motor raw JSON writer: {exc}")
            finally:
                for _ in batch:
                    _raw_json_queue.task_done()
                batch = []


def _start_raw_json_writer_once():
    global _raw_json_writer_started
    if not MOTOR_RAW_JSON_ASYNC or _raw_json_writer_started:
        return
    _raw_json_writer_started = True
    t = threading.Thread(target=_raw_json_writer_loop, name="motor-raw-json-writer", daemon=True)
    t.start()


def _stop_raw_json_writer():
    if not MOTOR_RAW_JSON_ASYNC or not _raw_json_writer_started:
        return
    _raw_json_stop.set()
    try:
        _raw_json_queue.join()
    except Exception:
        pass


atexit.register(_stop_raw_json_writer)


def _log_json_line(path: Path, obj: dict):
    line = json.dumps(obj, ensure_ascii=False, default=str) + "\n"
    if not MOTOR_RAW_JSON_ASYNC:
        _write_jsonl_sync(path, [line])
        return
    _start_raw_json_writer_once()
    try:
        _raw_json_queue.put_nowait((path, line))
    except queue.Full:
        print("[WARN] motor raw JSON queue full; writing synchronously")
        _write_jsonl_sync(path, [line])


def _safe_name(value) -> str:
    text = str(value or "").strip()
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in text) or "unknown"


def _raw_path_for_device(device_id) -> Path:
    return MOTOR_RAW_JSON_PATH / f"{_safe_name(device_id)}.jsonl"


# ---------------------------
# DB helpers (same pattern as itdc_data_receive.py)
# ---------------------------

def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in (
        "1", "true", "yes", "y", "on"
    )


def _get_db_config(prefix: str = "") -> dict:
    timeout = os.getenv(f"{prefix}DB_CONNECT_TIMEOUT", os.getenv("DB_CONNECT_TIMEOUT", "5"))
    return {
        "host": os.getenv(f"{prefix}DB_HOST"),
        "port": os.getenv(f"{prefix}DB_PORT", "5432"),
        "dbname": os.getenv(f"{prefix}DB_DATABASE"),
        "user": os.getenv(f"{prefix}DB_USERNAME"),
        "password": os.getenv(f"{prefix}DB_PASSWORD"),
        "connect_timeout": int(timeout),
    }


def _is_valid_db_config(cfg: dict) -> bool:
    return all(cfg.get(k) for k in ("host", "port", "dbname", "user", "password"))


def _get_target_db_configs() -> list:
    targets = []
    primary = _get_db_config("")
    if _is_valid_db_config(primary):
        targets.append(("PRIMARY", primary))
    else:
        print("[WARN] PRIMARY DB config incomplete; skipping PRIMARY write")

    if _env_bool("UPDATE_DEV_DB", False):
        dev = _get_db_config("DEV_")
        if _is_valid_db_config(dev):
            targets.append(("DEV", dev))
        else:
            print("[WARN] UPDATE_DEV_DB=true but DEV DB config is incomplete")

    if _env_bool("UPDATE_QA_DB", False):
        qa = _get_db_config("QA_")
        if _is_valid_db_config(qa):
            targets.append(("QA", qa))
        else:
            print("[WARN] UPDATE_QA_DB=true but QA DB config is incomplete")

    return targets


# ---------------------------
# Schema bootstrap
# ---------------------------

def _ensure_schema(cur):
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS motor_sensor_records (
            device_id       VARCHAR(64)     NOT NULL,
            seq             BIGINT          NOT NULL,
            device_ts       BIGINT          NOT NULL,
            voltage_v       NUMERIC(7,1)    NOT NULL,
            current_a       NUMERIC(7,2)    NOT NULL,
            power_factor    NUMERIC(4,2)    NOT NULL,
            temperature_c   NUMERIC(7,1)    NOT NULL,
            rpm             INTEGER         NOT NULL,
            batch_id        VARCHAR(128)    NOT NULL,
            received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            PRIMARY KEY (device_id, seq)
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS motor_upload_log (
            id              BIGSERIAL       PRIMARY KEY,
            device_id       VARCHAR(64)     NOT NULL,
            batch_id        VARCHAR(128)    NOT NULL,
            first_seq       BIGINT          NOT NULL,
            last_seq        BIGINT          NOT NULL,
            record_count    INTEGER         NOT NULL,
            stored_count    INTEGER         NOT NULL,
            boot            BIGINT,
            lost_total      BIGINT,
            dropped_total   BIGINT,
            received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_motor_records_device_received
            ON motor_sensor_records (device_id, received_at);
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_motor_upload_log_device
            ON motor_upload_log (device_id, received_at);
        """
    )


_schema_ensured = {}
_schema_lock = threading.Lock()


def _ensure_schema_once(cur, env_name: str):
    if _schema_ensured.get(env_name):
        return
    with _schema_lock:
        if not _schema_ensured.get(env_name):
            _ensure_schema(cur)
            _schema_ensured[env_name] = True


# ---------------------------
# Core insert logic
# ---------------------------

def _store_to_db(env_name: str, db_cfg: dict, body: dict, received_at: datetime) -> int:
    """
    Insert records into one DB target.
    Returns count of newly inserted rows (duplicates are silently ignored).
    Raises on any error — caller rolls back and re-raises as 500.
    """
    device_id = body["device_id"]
    batch_id = body["batch_id"]
    first_seq = body["first_seq"]
    last_seq = body["last_seq"]
    records = body.get("records") or []
    boot = body.get("boot")
    lost_total = body.get("lost_total")
    dropped_total = body.get("dropped_total")

    conn = psycopg2.connect(**db_cfg)
    conn.autocommit = False
    stored = 0

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            _ensure_schema_once(cur, env_name)

            for rec in records:
                cur.execute(
                    """
                    INSERT INTO motor_sensor_records
                        (device_id, seq, device_ts, voltage_v, current_a,
                         power_factor, temperature_c, rpm, batch_id, received_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (device_id, seq) DO NOTHING
                    """,
                    (
                        device_id,
                        rec["seq"],
                        rec["timestamp"],
                        rec["voltage"],
                        rec["current"],
                        rec["power_factor"],
                        rec["temperature"],
                        rec["rpm"],
                        batch_id,
                        received_at,
                    ),
                )
                stored += cur.rowcount

            cur.execute(
                """
                INSERT INTO motor_upload_log
                    (device_id, batch_id, first_seq, last_seq,
                     record_count, stored_count, boot, lost_total, dropped_total, received_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    device_id, batch_id, first_seq, last_seq,
                    len(records), stored, boot, lost_total, dropped_total, received_at,
                ),
            )

        conn.commit()
        print(
            f"[OK][{env_name}] motor device={device_id} batch={batch_id} "
            f"records={len(records)} stored={stored} "
            f"seq={first_seq}..{last_seq}"
        )
        return stored

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _store_bulk(body: dict, received_at: datetime):
    """Write to all configured DB targets. Raises RuntimeError on all-failed."""
    targets = _get_target_db_configs()
    if not targets:
        raise RuntimeError("No valid DB targets configured")

    last_exc = None
    for env_name, db_cfg in targets:
        try:
            _store_to_db(env_name, db_cfg, body, received_at)
        except Exception as exc:
            last_exc = exc
            print(
                f"[ERROR][{env_name}] motor DB write failed "
                f"device={body.get('device_id')} batch={body.get('batch_id')}: {exc}"
            )
            if DEBUG_MOTOR:
                traceback.print_exc()

    if last_exc and len(targets) == 1:
        raise last_exc


# ---------------------------
# Request validation
# ---------------------------

_REQUIRED_BATCH_FIELDS = ("device_id", "batch_id", "first_seq", "last_seq", "count")
_REQUIRED_RECORD_FIELDS = ("seq", "timestamp", "voltage", "current", "power_factor", "temperature", "rpm")


def _validate(body: dict) -> str | None:
    """Return an error message string on failure, or None on success."""
    for field in _REQUIRED_BATCH_FIELDS:
        if field not in body:
            return f"missing field: {field}"

    if not isinstance(body["device_id"], str) or not body["device_id"]:
        return "device_id must be a non-empty string"

    first_seq = body["first_seq"]
    last_seq = body["last_seq"]

    if not isinstance(first_seq, int) or not isinstance(last_seq, int):
        return "first_seq and last_seq must be integers"

    if first_seq > last_seq:
        return f"first_seq ({first_seq}) > last_seq ({last_seq})"

    records = body.get("records")
    if records is None:
        return "missing field: records"
    if not isinstance(records, list):
        return "records must be an array"

    for i, rec in enumerate(records):
        for field in _REQUIRED_RECORD_FIELDS:
            if field not in rec:
                return f"records[{i}] missing field: {field}"

        seq = rec["seq"]
        if not isinstance(seq, int):
            return f"records[{i}].seq must be an integer"
        if seq < first_seq or seq > last_seq:
            return (
                f"records[{i}].seq={seq} outside batch range "
                f"[{first_seq}..{last_seq}]"
            )

    return None


# ---------------------------
# Alert helpers
# ---------------------------

def _check_device_health(body: dict):
    device_id = body.get("device_id", "?")
    lost = body.get("lost_total", 0) or 0
    dropped = body.get("dropped_total", 0) or 0

    if lost > MOTOR_ALERT_LOST_THRESHOLD:
        print(
            f"[ALERT] motor device={device_id} "
            f"lost_total={lost} exceeds threshold={MOTOR_ALERT_LOST_THRESHOLD}. "
            f"Flash overflow — device is overwriting unsent records!"
        )

    if dropped > MOTOR_ALERT_DROPPED_THRESHOLD:
        print(
            f"[ALERT] motor device={device_id} "
            f"dropped_total={dropped} exceeds threshold={MOTOR_ALERT_DROPPED_THRESHOLD}. "
            f"Memory full — device is dropping readings!"
        )


# ---------------------------
# Flask app
# ---------------------------

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES + 512  # a little slack for Flask's own check


@app.route("/api/sensor-data/bulk", methods=["POST"])
def sensor_data_bulk():
    received_at = datetime.now(timezone.utc)

    # Size guard (returns 413 before body is parsed)
    content_length = request.content_length
    if content_length is not None and content_length > MAX_BODY_BYTES:
        if DEBUG_MOTOR:
            print(
                f"[413] motor Content-Length={content_length} > MAX_BODY_BYTES={MAX_BODY_BYTES} "
                f"from {request.remote_addr}"
            )
        return Response('{"error":"payload too large"}', status=413, mimetype="application/json")

    # Parse JSON
    raw_body = request.get_data()
    if len(raw_body) > MAX_BODY_BYTES:
        if DEBUG_MOTOR:
            print(f"[413] motor body len={len(raw_body)} > {MAX_BODY_BYTES} from {request.remote_addr}")
        return Response('{"error":"payload too large"}', status=413, mimetype="application/json")

    try:
        body = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"[400] motor JSON parse error from {request.remote_addr}: {exc}")
        return Response('{"error":"invalid JSON"}', status=400, mimetype="application/json")

    # Log raw request
    try:
        device_id = body.get("device_id") if isinstance(body, dict) else None
        _log_json_line(
            _raw_path_for_device(device_id),
            {
                "event": "bulk_request",
                "remote_addr": request.remote_addr,
                "received_at": received_at.isoformat(),
                "content_length": content_length,
                "body_len": len(raw_body),
                "batch_id": body.get("batch_id") if isinstance(body, dict) else None,
                "body": body,
            },
        )
    except Exception as log_exc:
        print(f"[WARN] motor raw JSON log failed: {log_exc}")

    # Validate
    err = _validate(body)
    if err:
        print(
            f"[400] motor validation failed from {request.remote_addr}: {err} "
            f"device={body.get('device_id')} batch={body.get('batch_id')}"
        )
        return Response(
            json.dumps({"error": err}),
            status=400,
            mimetype="application/json",
        )

    # Health alerts (non-blocking)
    try:
        _check_device_health(body)
    except Exception:
        pass

    last_seq = body["last_seq"]

    # Store
    try:
        _store_bulk(body, received_at)
    except Exception as exc:
        print(
            f"[500] motor DB error device={body.get('device_id')} "
            f"batch={body.get('batch_id')}: {exc}"
        )
        if DEBUG_MOTOR:
            traceback.print_exc()
        return Response(
            '{"error":"internal server error"}',
            status=500,
            mimetype="application/json",
        )

    # ACK — single line, under 90 bytes, "status":"ok" first
    ack = f'{{"status":"ok","ack_seq":{last_seq}}}'
    assert len(ack) < 90, f"ACK too long: {len(ack)} bytes"

    if DEBUG_MOTOR:
        print(
            f"[200] motor device={body['device_id']} batch={body['batch_id']} "
            f"ack_seq={last_seq} records={len(body.get('records') or [])}"
        )

    # Broadcast to any open dashboard SSE connections
    try:
        _sse_broadcast({
            "device_id": body["device_id"],
            "batch_id": body["batch_id"],
            "first_seq": body["first_seq"],
            "last_seq": body["last_seq"],
            "record_count": len(body.get("records") or []),
            "received_at": received_at.isoformat(),
            "lost_total": body.get("lost_total", 0),
            "dropped_total": body.get("dropped_total", 0),
        })
    except Exception:
        pass

    return Response(ack, status=200, mimetype="application/json")


# ---------------------------
# SSE broadcast
# ---------------------------

_sse_clients: list = []
_sse_lock = threading.Lock()


def _sse_broadcast(payload: dict):
    data = "data: " + json.dumps(payload, default=str) + "\n\n"
    with _sse_lock:
        dead = []
        for q in _sse_clients:
            try:
                q.put_nowait(data)
            except Exception:
                dead.append(q)
        for q in dead:
            _sse_clients.remove(q)


# ---------------------------
# Dashboard data API
# ---------------------------

def _query_db(sql_text: str, params=()):
    cfg = _get_db_config("")
    if not _is_valid_db_config(cfg):
        return []
    conn = psycopg2.connect(**cfg)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql_text, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@app.route("/api/motor/recent")
def motor_recent():
    device_id = request.args.get("device_id")
    page      = max(1, int(request.args.get("page", 1)))
    page_size = min(int(request.args.get("page_size", 10)), 200)
    offset    = (page - 1) * page_size
    chart_limit = 100  # fixed window for charts — always latest 100

    # Records page (for the table)
    if device_id:
        rows = _query_db(
            """
            SELECT device_id, seq, device_ts, voltage_v, current_a,
                   power_factor, temperature_c, rpm, batch_id,
                   received_at AT TIME ZONE 'UTC' AS received_at
            FROM motor_sensor_records
            WHERE device_id = %s
            ORDER BY seq DESC LIMIT %s OFFSET %s
            """,
            (device_id, page_size, offset),
        )
        total_rows = _query_db(
            "SELECT COUNT(*) AS n FROM motor_sensor_records WHERE device_id = %s",
            (device_id,),
        )
    else:
        rows = _query_db(
            """
            SELECT device_id, seq, device_ts, voltage_v, current_a,
                   power_factor, temperature_c, rpm, batch_id,
                   received_at AT TIME ZONE 'UTC' AS received_at
            FROM motor_sensor_records
            ORDER BY received_at DESC, seq DESC LIMIT %s OFFSET %s
            """,
            (page_size, offset),
        )
        total_rows = _query_db("SELECT COUNT(*) AS n FROM motor_sensor_records")

    total_count = int(total_rows[0]["n"]) if total_rows else 0
    total_pages = max(1, (total_count + page_size - 1) // page_size)

    # Chart data — latest 100 for selected device (ascending for time-series)
    if device_id:
        chart_rows = _query_db(
            """
            SELECT seq, voltage_v, current_a, power_factor, temperature_c, rpm,
                   received_at AT TIME ZONE 'UTC' AS received_at
            FROM motor_sensor_records
            WHERE device_id = %s
            ORDER BY seq DESC LIMIT %s
            """,
            (device_id, chart_limit),
        )
        chart_rows = list(reversed(chart_rows))
    else:
        chart_rows = []

    devices = _query_db(
        """
        SELECT device_id,
               COUNT(*)                             AS total_records,
               MAX(received_at) AT TIME ZONE 'UTC'  AS last_seen,
               MAX(seq)                             AS last_seq
        FROM motor_sensor_records
        GROUP BY device_id
        ORDER BY last_seen DESC
        """
    )

    uploads = _query_db(
        """
        SELECT device_id, batch_id, first_seq, last_seq,
               record_count, stored_count, lost_total, dropped_total,
               received_at AT TIME ZONE 'UTC' AS received_at
        FROM motor_upload_log
        ORDER BY received_at DESC LIMIT 20
        """
    )

    def fix_row(r):
        if hasattr(r.get("received_at"), "isoformat"):
            r["received_at"] = r["received_at"].isoformat() + "Z"
        for k in ("voltage_v", "current_a", "power_factor", "temperature_c"):
            if r.get(k) is not None:
                r[k] = float(r[k])
        return r

    rows       = [fix_row(r) for r in rows]
    chart_rows = [fix_row(r) for r in chart_rows]

    for d in devices:
        if hasattr(d.get("last_seen"), "isoformat"):
            d["last_seen"] = d["last_seen"].isoformat() + "Z"
        d["total_records"] = int(d["total_records"])
        d["last_seq"] = int(d["last_seq"])

    for u in uploads:
        if hasattr(u.get("received_at"), "isoformat"):
            u["received_at"] = u["received_at"].isoformat() + "Z"

    return Response(
        json.dumps({
            "records":     rows,
            "chart_rows":  chart_rows,
            "devices":     devices,
            "uploads":     uploads,
            "pagination":  {
                "page":        page,
                "page_size":   page_size,
                "total_count": total_count,
                "total_pages": total_pages,
            },
        }, default=str),
        mimetype="application/json",
    )


@app.route("/api/motor/stream")
def motor_stream():
    q = queue.Queue(maxsize=50)
    with _sse_lock:
        _sse_clients.append(q)

    def generate():
        yield "data: {\"type\":\"connected\"}\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield msg
                except queue.Empty:
                    yield ": ping\n\n"
        except GeneratorExit:
            pass
        finally:
            with _sse_lock:
                try:
                    _sse_clients.remove(q)
                except ValueError:
                    pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------
# Dashboard HTML
# ---------------------------

_DASHBOARD_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Motor Logger</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
/* ── header ── */
header{background:#fff;border-bottom:1px solid #e2e8f0;padding:0 24px;display:flex;align-items:center;gap:16px;height:54px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.logo{display:flex;align-items:center;gap:10px}
header h1{font-size:1rem;font-weight:600;color:#0f172a}
.nav{display:flex;gap:2px;margin-left:28px}
.nav-btn{padding:6px 16px;border-radius:6px;font-size:.82rem;font-weight:500;cursor:pointer;border:none;background:transparent;color:#64748b;transition:all .15s}
.nav-btn:hover{background:#f1f5f9;color:#1e293b}
.nav-btn.active{background:#ede9fe;color:#6366f1;font-weight:600}
.live-badge{display:flex;align-items:center;gap:6px;font-size:.75rem;font-weight:600;color:#059669;margin-left:auto}
.live-dot{width:8px;height:8px;border-radius:50%;background:#059669;animation:pulse 1.6s ease-in-out infinite}
.live-badge.off{color:#94a3b8}.live-badge.off .live-dot{background:#94a3b8;animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.last-upd{font-size:.72rem;color:#94a3b8;margin-left:6px}
/* ── layout ── */
.page{display:none}.page.active{display:block}
.container{padding:20px 24px;max-width:1400px;margin:0 auto}
/* ── stats cards ── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.card-label{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:6px}
.card-value{font-size:1.6rem;font-weight:700;color:#0f172a}
.card-sub{font-size:.72rem;color:#94a3b8;margin-top:2px}
.card.warn .card-value{color:#d97706}
/* ── section title ── */
.section-title{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:20px 0 10px}
/* ── device filter bar ── */
.filter-bar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.filter-bar label{font-size:.78rem;font-weight:600;color:#64748b}
.filter-bar select{padding:6px 12px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;color:#1e293b;font-size:.82rem;cursor:pointer;outline:none}
.filter-bar select:focus{border-color:#6366f1}
/* ── pagination ── */
.pagination{display:flex;align-items:center;gap:6px;margin-top:12px;flex-wrap:wrap}
.pg-btn{padding:5px 12px;border-radius:6px;font-size:.78rem;font-weight:500;cursor:pointer;border:1px solid #e2e8f0;background:#fff;color:#64748b;transition:all .15s}
.pg-btn:hover:not(:disabled){border-color:#6366f1;color:#6366f1}
.pg-btn:disabled{opacity:.4;cursor:not-allowed}
.pg-btn.active{background:#6366f1;color:#fff;border-color:#6366f1}
.pg-info{font-size:.78rem;color:#94a3b8;margin-left:4px}
/* ── charts ── */
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:20px}
.chart-box{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.chart-title{font-size:.78rem;font-weight:600;color:#475569;margin-bottom:4px;display:flex;justify-content:space-between;align-items:baseline}
.chart-cur{font-size:1.1rem;font-weight:700}
.chart-unit{font-size:.72rem;font-weight:400;margin-left:2px;color:#94a3b8}
canvas{width:100%!important;display:block;cursor:crosshair}
#chart-tooltip{position:fixed;background:#1e293b;color:#f8fafc;padding:8px 12px;border-radius:8px;font-size:.78rem;pointer-events:none;display:none;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.25);line-height:1.7;min-width:110px}
/* ── tables ── */
.table-wrap{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.upload-log{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-top:20px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
table{width:100%;border-collapse:collapse;font-size:.78rem}
thead tr{background:#f8fafc;border-bottom:1px solid #e2e8f0}
th{padding:9px 12px;text-align:left;font-weight:600;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#334155}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#f8fafc}
.badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:600}
.badge-ok{background:#d1fae5;color:#065f46}
.badge-warn{background:#fef3c7;color:#92400e}
.badge-get{background:#dbeafe;color:#1e40af}
.badge-post{background:#d1fae5;color:#065f46}
.badge-sse{background:#ede9fe;color:#5b21b6}
.empty{text-align:center;padding:40px;color:#94a3b8;font-size:.85rem}
/* ── docs page ── */
.doc-layout{display:grid;grid-template-columns:220px 1fr;gap:24px;align-items:start}
.doc-nav{position:sticky;top:20px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.doc-nav a{display:block;padding:7px 18px;font-size:.82rem;color:#64748b;text-decoration:none;border-left:3px solid transparent;transition:all .12s}
.doc-nav a:hover{color:#6366f1;background:#f8fafc}
.doc-nav a.active{color:#6366f1;border-left-color:#6366f1;background:#f5f3ff;font-weight:600}
.doc-nav .nav-group{padding:6px 18px 2px;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#cbd5e1;margin-top:6px}
.doc-body{min-width:0}
.doc-section{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:24px 28px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.doc-section h2{font-size:1.05rem;font-weight:700;color:#0f172a;margin-bottom:4px;display:flex;align-items:center;gap:10px}
.doc-section .subtitle{font-size:.82rem;color:#64748b;margin-bottom:18px}
.endpoint-bar{display:flex;align-items:center;gap:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 16px;margin:14px 0;font-family:monospace;font-size:.88rem}
.method{font-weight:700;font-size:.78rem;padding:3px 8px;border-radius:4px}
.url{color:#0f172a;font-weight:500;word-break:break-all}
.field-table{width:100%;border-collapse:collapse;font-size:.8rem;margin:10px 0}
.field-table th{padding:7px 10px;text-align:left;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;background:#f8fafc;border-bottom:1px solid #e2e8f0}
.field-table td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#334155}
.field-table tr:last-child td{border-bottom:none}
.field-table .fname{font-family:monospace;font-size:.82rem;color:#6366f1;font-weight:600}
.field-table .ftype{font-family:monospace;font-size:.75rem;color:#059669}
.field-table .freq{font-size:.7rem;font-weight:600;color:#dc2626}
code{font-family:monospace;font-size:.82rem;background:#f1f5f9;padding:1px 5px;border-radius:3px;color:#7c3aed}
pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:16px;font-size:.8rem;line-height:1.6;overflow-x:auto;margin:12px 0;font-family:'Cascadia Code','Fira Code',monospace}
pre .c{color:#64748b}
pre .k{color:#818cf8}
pre .s{color:#34d399}
pre .n{color:#f59e0b}
.note{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;font-size:.82rem;color:#1e40af;margin:12px 0;line-height:1.5}
.warn-note{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:.82rem;color:#92400e;margin:12px 0}
.status-table td:first-child{font-family:monospace;font-weight:700}
.copy-btn{float:right;font-size:.7rem;padding:3px 10px;border-radius:4px;border:1px solid #e2e8f0;background:#fff;color:#64748b;cursor:pointer;font-family:inherit}
.copy-btn:hover{background:#f1f5f9}
h3{font-size:.88rem;font-weight:700;color:#1e293b;margin:18px 0 8px}
@media(max-width:700px){.doc-layout{grid-template-columns:1fr}.doc-nav{position:static}}
</style>
</head>
<body>
<div id="chart-tooltip"></div>
<header>
  <div class="logo">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
    <h1>Motor Logger</h1>
  </div>
  <nav class="nav">
    <button class="nav-btn active" onclick="showPage('dashboard',this)">Dashboard</button>
    <button class="nav-btn" onclick="showPage('docs',this)">Documentation</button>
  </nav>
  <span id="live-badge" class="live-badge off"><span class="live-dot"></span>Connecting…</span>
  <span id="last-upd" class="last-upd"></span>
</header>

<!-- ════════════════════════════════ DASHBOARD PAGE ════════════════════════════════ -->
<div id="page-dashboard" class="page active">
<div class="container">
  <div id="stats" class="stats"></div>
  <div class="section-title">Sensor Records</div>
  <div class="filter-bar">
    <label>Device</label>
    <select id="device-select" onchange="onDeviceChange()">
      <option value="">All devices</option>
    </select>
    <label style="margin-left:8px">Rows</label>
    <select id="page-size-select" onchange="onPageSizeChange()">
      <option value="10" selected>10</option>
      <option value="25">25</option>
      <option value="50">50</option>
      <option value="100">100</option>
    </select>
  </div>
  <div id="charts" class="charts"></div>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Seq</th><th>Voltage (V)</th><th>Current (A)</th>
      <th>Power Factor</th><th>Temp (°C)</th><th>RPM</th><th>Received At</th>
    </tr></thead>
    <tbody id="rec-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
  </table></div>
  <div class="pagination" id="pagination"></div>
  <div class="section-title">Upload Log</div>
  <div class="upload-log"><table>
    <thead><tr>
      <th>Device</th><th>Batch ID</th><th>Seq Range</th>
      <th>Sent</th><th>Stored</th><th>Lost</th><th>Dropped</th><th>Received At</th>
    </tr></thead>
    <tbody id="log-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
  </table></div>
</div>
</div>

<!-- ════════════════════════════════ DOCS PAGE ════════════════════════════════ -->
<div id="page-docs" class="page">
<div class="container">
<div class="doc-layout">

<!-- sidebar -->
<aside class="doc-nav">
  <div class="nav-group">Overview</div>
  <a href="#overview" onclick="scrollTo('overview')">Introduction</a>
  <a href="#flow" onclick="scrollTo('flow')">How it works</a>
  <div class="nav-group">Device API</div>
  <a href="#bulk" onclick="scrollTo('bulk')">POST bulk upload</a>
  <a href="#request-body" onclick="scrollTo('request-body')">Request body</a>
  <a href="#record-fields" onclick="scrollTo('record-fields')">Record fields</a>
  <a href="#response" onclick="scrollTo('response')">ACK response</a>
  <a href="#errors" onclick="scrollTo('errors')">Error codes</a>
  <div class="nav-group">Backend API</div>
  <a href="#recent" onclick="scrollTo('recent')">GET recent data</a>
  <a href="#stream" onclick="scrollTo('stream')">GET live stream (SSE)</a>
  <div class="nav-group">Reference</div>
  <a href="#dedup" onclick="scrollTo('dedup')">Deduplication</a>
  <a href="#schema" onclick="scrollTo('schema')">Database schema</a>
  <a href="#examples" onclick="scrollTo('examples')">Code examples</a>
</aside>

<!-- body -->
<div class="doc-body">

<!-- OVERVIEW -->
<div class="doc-section" id="overview">
  <h2>Introduction</h2>
  <p class="subtitle">Motor Logger HTTP API — accepts bulk sensor data from SIM800L GSM motor loggers</p>
  <p style="font-size:.85rem;line-height:1.7;color:#475569">Each motor logger sends one HTTP POST of up to <strong>50 sensor records</strong> every 5 minutes. The server commits all records to PostgreSQL inside a single transaction, then replies with an ACK. The device deletes its local Flash copy only after receiving the ACK — any other response causes a retry with the same data.</p>
  <div class="note">&#9432; &nbsp;<strong>No HTTPS, no auth yet.</strong> The SIM800L TLS stack only supports old cipher suites. Accept plain HTTP on this endpoint, or put an nginx/HAProxy TLS gateway in front.</div>
</div>

<!-- HOW IT WORKS -->
<div class="doc-section" id="flow">
  <h2>How it works</h2>
  <ol style="font-size:.85rem;line-height:2;color:#475569;padding-left:20px">
    <li>Device collects one reading per second per motor (voltage, current, power factor, temperature, RPM).</li>
    <li>After 5 minutes it groups the ~300 readings into batches of ≤ 50 records and sends them one POST at a time, oldest first.</li>
    <li>The server inserts each record with <code>ON CONFLICT DO NOTHING</code> — retries of the same range are safe.</li>
    <li>After a successful DB commit the server replies <code>{"status":"ok","ack_seq":N}</code>. The device deletes its copy and sends the next batch.</li>
    <li>On any non-200 response or network timeout (120 s) the device keeps its data and retries with exponential back-off (10 s → 20 → 40 … max 5 min).</li>
  </ol>
</div>

<!-- BULK UPLOAD -->
<div class="doc-section" id="bulk">
  <h2><span class="badge badge-post">POST</span> Bulk upload</h2>
  <p class="subtitle">The only endpoint the device firmware calls</p>
  <div class="endpoint-bar">
    <span class="badge badge-post method">POST</span>
    <span class="url">/api/sensor-data/bulk</span>
  </div>
  <h3>Headers</h3>
  <table class="field-table">
    <thead><tr><th>Header</th><th>Required</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td class="fname">Content-Type</td><td class="freq">Yes</td><td>Must be <code>application/json</code></td></tr>
      <tr><td class="fname">Content-Length</td><td class="freq">Yes</td><td>Exact byte size. Body is never chunked.</td></tr>
      <tr><td class="fname">Idempotency-Key</td><td>Usually</td><td>Same value as <code>batch_id</code>. Some modem firmware versions omit it — always read <code>batch_id</code> from the body.</td></tr>
    </tbody>
  </table>
  <div class="note">&#9432; &nbsp;<strong>Body size limit: 8 192 bytes</strong> (configurable via <code>MOTOR_MAX_BODY_BYTES</code> env var). The device default is ~6 000 bytes (50 records × ~105 bytes each). Larger bodies receive <code>413</code>.</div>
</div>

<!-- REQUEST BODY -->
<div class="doc-section" id="request-body">
  <h2>Request body — batch fields</h2>
  <p class="subtitle">One JSON object per request, sent as a single line with no extra whitespace.</p>
  <table class="field-table">
    <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td class="fname">device_id</td><td class="ftype">string</td><td class="freq">Yes</td><td>Identifies the motor logger, e.g. <code>MOTOR_001</code></td></tr>
      <tr><td class="fname">batch_id</td><td class="ftype">string</td><td class="freq">Yes</td><td><code>&lt;device_id&gt;-&lt;first_seq&gt;-&lt;last_seq&gt;</code>. Identical on every retry of the same range.</td></tr>
      <tr><td class="fname">first_seq</td><td class="ftype">integer</td><td class="freq">Yes</td><td>First seq number in this request. Must be ≤ <code>last_seq</code>.</td></tr>
      <tr><td class="fname">last_seq</td><td class="ftype">integer</td><td class="freq">Yes</td><td>Last seq number in this request. The ACK refers to this value.</td></tr>
      <tr><td class="fname">count</td><td class="ftype">integer</td><td class="freq">Yes</td><td>Number of items in <code>records</code>. May be less than the range if readings were lost to a power cut.</td></tr>
      <tr><td class="fname">boot</td><td class="ftype">integer</td><td></td><td>Device restart counter. Diagnostics only.</td></tr>
      <tr><td class="fname">lost_total</td><td class="ftype">integer</td><td></td><td>Running total of records overwritten before upload (Flash full). Alert if it grows.</td></tr>
      <tr><td class="fname">dropped_total</td><td class="ftype">integer</td><td></td><td>Running total of readings the device could not store. Alert if it grows.</td></tr>
      <tr><td class="fname">records</td><td class="ftype">array</td><td class="freq">Yes</td><td>Sensor readings, ascending by <code>seq</code>. May be empty (<code>[]</code>).</td></tr>
    </tbody>
  </table>
  <button class="copy-btn" onclick="copy('ex-req')">Copy</button>
  <pre id="ex-req"><span class="c">// Example request body</span>
{
  <span class="k">"device_id"</span>:      <span class="s">"MOTOR_001"</span>,
  <span class="k">"batch_id"</span>:       <span class="s">"MOTOR_001-1001-1050"</span>,
  <span class="k">"first_seq"</span>:      <span class="n">1001</span>,
  <span class="k">"last_seq"</span>:       <span class="n">1050</span>,
  <span class="k">"count"</span>:         <span class="n">2</span>,
  <span class="k">"boot"</span>:          <span class="n">3</span>,
  <span class="k">"lost_total"</span>:    <span class="n">0</span>,
  <span class="k">"dropped_total"</span>: <span class="n">0</span>,
  <span class="k">"records"</span>: [
    {<span class="k">"seq"</span>:<span class="n">1001</span>,<span class="k">"timestamp"</span>:<span class="n">1000</span>,<span class="k">"voltage"</span>:<span class="n">230.5</span>,<span class="k">"current"</span>:<span class="n">0.85</span>,<span class="k">"power_factor"</span>:<span class="n">0.92</span>,<span class="k">"temperature"</span>:<span class="n">45.6</span>,<span class="k">"rpm"</span>:<span class="n">1450</span>},
    {<span class="k">"seq"</span>:<span class="n">1002</span>,<span class="k">"timestamp"</span>:<span class="n">1001</span>,<span class="k">"voltage"</span>:<span class="n">231.0</span>,<span class="k">"current"</span>:<span class="n">0.87</span>,<span class="k">"power_factor"</span>:<span class="n">0.91</span>,<span class="k">"temperature"</span>:<span class="n">45.8</span>,<span class="k">"rpm"</span>:<span class="n">1452</span>}
  ]
}</pre>
</div>

<!-- RECORD FIELDS -->
<div class="doc-section" id="record-fields">
  <h2>Record fields</h2>
  <table class="field-table">
    <thead><tr><th>Field</th><th>Type</th><th>Unit</th><th>Range</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td class="fname">seq</td><td class="ftype">integer</td><td>—</td><td>1 – 4 294 967 295</td><td>Unique per device, never reused. Gaps are allowed.</td></tr>
      <tr><td class="fname">timestamp</td><td class="ftype">integer</td><td>seconds</td><td>—</td><td>Device internal clock, <strong>not</strong> Unix time. Use <code>received_at</code> for wall-clock ordering.</td></tr>
      <tr><td class="fname">voltage</td><td class="ftype">number</td><td>V AC RMS</td><td>0.0 – 6553.5</td><td>1 decimal place</td></tr>
      <tr><td class="fname">current</td><td class="ftype">number</td><td>A AC RMS</td><td>0.00 – 655.35</td><td>2 decimal places</td></tr>
      <tr><td class="fname">power_factor</td><td class="ftype">number</td><td>—</td><td>0.00 – 1.00</td><td>2 decimal places</td></tr>
      <tr><td class="fname">temperature</td><td class="ftype">number</td><td>°C</td><td>−3276.8 – 3276.7</td><td>1 decimal place</td></tr>
      <tr><td class="fname">rpm</td><td class="ftype">integer</td><td>rev/min</td><td>0 – 65535</td><td></td></tr>
    </tbody>
  </table>
  <div class="warn-note">&#9888; &nbsp;Numbers are always plain decimal (e.g. <code>230.0</code>, <code>-5.2</code>). Never exponent notation. Stored as <code>NUMERIC</code> in PostgreSQL, not <code>FLOAT</code>, to avoid rounding errors.</div>
</div>

<!-- RESPONSE -->
<div class="doc-section" id="response">
  <h2>ACK response</h2>
  <p class="subtitle">Sent only after the database transaction commits successfully.</p>
  <pre><span class="c">HTTP/1.1 200 OK
Content-Type: application/json</span>

{<span class="k">"status"</span>:<span class="s">"ok"</span>,<span class="k">"ack_seq"</span>:<span class="n">1050</span>}</pre>
  <table class="field-table" style="margin-top:12px">
    <thead><tr><th>Rule</th><th>Detail</th></tr></thead>
    <tbody>
      <tr><td>Single line</td><td>Body starts with <code>{</code> and contains no newlines</td></tr>
      <tr><td>Under 90 bytes</td><td>Device parser has very little RAM</td></tr>
      <tr><td>Order matters</td><td><code>"status":"ok"</code> must come before <code>"ack_seq"</code></td></tr>
      <tr><td>Duplicates</td><td>Return the same 200 ACK — never <code>409</code></td></tr>
    </tbody>
  </table>
  <h3>How the device interprets <code>ack_seq</code></h3>
  <table class="field-table status-table">
    <thead><tr><th>ack_seq value</th><th>Device action</th></tr></thead>
    <tbody>
      <tr><td>= last_seq</td><td>Marks whole range stored. Sends next batch immediately.</td></tr>
      <tr><td>between first_seq and last_seq−1</td><td>Partial ACK. Marks up to ack_seq, resends from ack_seq+1.</td></tr>
      <tr><td>= first_seq−1</td><td>"Nothing stored." Keeps data, retries later.</td></tr>
      <tr><td>anything else</td><td>Invalid. Keeps data, retries later.</td></tr>
    </tbody>
  </table>
</div>

<!-- ERROR CODES -->
<div class="doc-section" id="errors">
  <h2>Error codes</h2>
  <table class="field-table status-table">
    <thead><tr><th>Code</th><th>When</th><th>Device behaviour</th></tr></thead>
    <tbody>
      <tr><td>200 / 201</td><td>Records committed (or already stored — duplicate)</td><td>Deletes up to ack_seq, sends next batch</td></tr>
      <tr><td>400 / 422</td><td>Malformed JSON or failed validation</td><td>Keeps data, retries with back-off. Same body every time — log and alert.</td></tr>
      <tr><td>413</td><td>Body exceeds size limit</td><td>Halves records per request (50→25→12…), retries in 2 s</td></tr>
      <tr><td>429</td><td>Rate limited</td><td>Keeps data, retries with back-off</td></tr>
      <tr><td>500 / 503</td><td>Database or server error</td><td>Keeps data, retries with back-off</td></tr>
      <tr><td>No reply within 120 s</td><td>Server hung</td><td>Treats as network failure, retries with back-off</td></tr>
    </tbody>
  </table>
  <div class="note">&#9432; &nbsp;Back-off sequence: 10 s → 20 → 40 → 80 … up to 5 minutes. Resets after next success.</div>
</div>

<!-- GET RECENT -->
<div class="doc-section" id="recent">
  <h2><span class="badge badge-get">GET</span> Recent data</h2>
  <p class="subtitle">Query stored sensor records, device stats, and the upload log.</p>
  <div class="endpoint-bar">
    <span class="badge badge-get method">GET</span>
    <span class="url">/api/motor/recent</span>
  </div>
  <h3>Query parameters</h3>
  <table class="field-table">
    <thead><tr><th>Param</th><th>Default</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td class="fname">device_id</td><td>all devices</td><td>Filter records to a single device</td></tr>
      <tr><td class="fname">limit</td><td>300</td><td>Max records to return (capped at 1 000)</td></tr>
    </tbody>
  </table>
  <h3>Response shape</h3>
  <pre>{
  <span class="k">"records"</span>: [          <span class="c">// sensor readings, newest first</span>
    {
      <span class="k">"device_id"</span>:    <span class="s">"MOTOR_001"</span>,
      <span class="k">"seq"</span>:          <span class="n">1001</span>,
      <span class="k">"device_ts"</span>:    <span class="n">1000</span>,
      <span class="k">"voltage_v"</span>:    <span class="n">230.5</span>,
      <span class="k">"current_a"</span>:    <span class="n">0.85</span>,
      <span class="k">"power_factor"</span>: <span class="n">0.92</span>,
      <span class="k">"temperature_c"</span>:<span class="n">45.6</span>,
      <span class="k">"rpm"</span>:          <span class="n">1450</span>,
      <span class="k">"batch_id"</span>:     <span class="s">"MOTOR_001-1001-1050"</span>,
      <span class="k">"received_at"</span>:  <span class="s">"2026-10-12T10:48:36.003Z"</span>
    }
  ],
  <span class="k">"devices"</span>: [           <span class="c">// one entry per unique device_id</span>
    {
      <span class="k">"device_id"</span>:     <span class="s">"MOTOR_001"</span>,
      <span class="k">"total_records"</span>: <span class="n">52</span>,
      <span class="k">"last_seen"</span>:     <span class="s">"2026-10-12T10:54:37.598Z"</span>,
      <span class="k">"last_seq"</span>:      <span class="n">4010</span>
    }
  ],
  <span class="k">"uploads"</span>: [           <span class="c">// last 20 upload attempts</span>
    {
      <span class="k">"device_id"</span>:     <span class="s">"MOTOR_001"</span>,
      <span class="k">"batch_id"</span>:      <span class="s">"MOTOR_001-1001-1050"</span>,
      <span class="k">"first_seq"</span>:     <span class="n">1001</span>,
      <span class="k">"last_seq"</span>:      <span class="n">1050</span>,
      <span class="k">"record_count"</span>:  <span class="n">2</span>,
      <span class="k">"stored_count"</span>:  <span class="n">2</span>,
      <span class="k">"lost_total"</span>:    <span class="n">0</span>,
      <span class="k">"dropped_total"</span>: <span class="n">0</span>,
      <span class="k">"received_at"</span>:   <span class="s">"2026-10-12T10:48:36.003Z"</span>
    }
  ]
}</pre>
</div>

<!-- SSE STREAM -->
<div class="doc-section" id="stream">
  <h2><span class="badge badge-sse">SSE</span> Live stream</h2>
  <p class="subtitle">Server-Sent Events — push notification each time a new batch is committed.</p>
  <div class="endpoint-bar">
    <span class="badge badge-sse method">GET</span>
    <span class="url">/api/motor/stream</span>
  </div>
  <p style="font-size:.84rem;color:#475569;margin:10px 0">The server holds the connection open and sends a message whenever a device POST commits successfully. The client should then call <code>/api/motor/recent</code> to refresh its data. A <code>: ping</code> keepalive is sent every 25 s to prevent proxy timeouts.</p>
  <h3>Event payload</h3>
  <pre><span class="c">// On connect</span>
data: {<span class="k">"type"</span>:<span class="s">"connected"</span>}

<span class="c">// On each new batch commit</span>
data: {
  <span class="k">"device_id"</span>:    <span class="s">"MOTOR_001"</span>,
  <span class="k">"batch_id"</span>:     <span class="s">"MOTOR_001-1001-1050"</span>,
  <span class="k">"first_seq"</span>:    <span class="n">1001</span>,
  <span class="k">"last_seq"</span>:     <span class="n">1050</span>,
  <span class="k">"record_count"</span>: <span class="n">50</span>,
  <span class="k">"received_at"</span>:  <span class="s">"2026-10-12T10:48:36.003Z"</span>,
  <span class="k">"lost_total"</span>:   <span class="n">0</span>,
  <span class="k">"dropped_total"</span>:<span class="n">0</span>
}</pre>
  <h3>JavaScript example</h3>
  <button class="copy-btn" onclick="copy('ex-sse')">Copy</button>
  <pre id="ex-sse"><span class="k">const</span> es = <span class="k">new</span> EventSource(<span class="s">'/api/motor/stream'</span>);

es.onmessage = e => {
  <span class="k">const</span> data = JSON.parse(e.data);
  <span class="k">if</span> (data.type === <span class="s">'connected'</span>) <span class="k">return</span>;
  <span class="c">// new batch arrived — refresh your UI</span>
  fetchLatestRecords();
};

es.onerror = () => {
  <span class="c">// browser auto-reconnects — just update your UI state</span>
  console.log(<span class="s">'SSE reconnecting…'</span>);
};</pre>
</div>

<!-- DEDUPLICATION -->
<div class="doc-section" id="dedup">
  <h2>Deduplication</h2>
  <p style="font-size:.84rem;line-height:1.7;color:#475569;margin-bottom:12px">The server will receive the same records more than once — if the ACK is lost on the way back (GSM drop, device reset, timeout) the device resends the identical range. The server handles this transparently:</p>
  <ul style="font-size:.84rem;line-height:2;color:#475569;padding-left:20px">
    <li>Primary key on <code>(device_id, seq)</code> — each sequence number stored exactly once per device.</li>
    <li>Inserts use <code>ON CONFLICT (device_id, seq) DO NOTHING</code> — the first stored copy wins.</li>
    <li>Duplicates still receive a normal <code>200 ACK</code> — never <code>409</code>.</li>
    <li>Retries may arrive in different batch sizes (after a 413 the device halves its chunk). Per-record dedup handles this; deduping on <code>batch_id</code> alone does not.</li>
  </ul>
  <div class="warn-note">&#9888; &nbsp;If <code>seq</code> for a device suddenly drops to a low number (Flash chip replaced/wiped), the server would silently ignore the new data. Alert on this and either clear the device's old keys or change its <code>device_id</code>.</div>
</div>

<!-- DATABASE SCHEMA -->
<div class="doc-section" id="schema">
  <h2>Database schema</h2>
  <p class="subtitle">Only these two tables are created. All existing IoT platform tables are untouched.</p>
  <pre><span class="c">-- One row per sensor reading. PK guarantees dedup.</span>
<span class="k">CREATE TABLE</span> motor_sensor_records (
  device_id      VARCHAR(64)   <span class="k">NOT NULL</span>,
  seq            BIGINT        <span class="k">NOT NULL</span>,   <span class="c">-- device seq (uint32)</span>
  device_ts      BIGINT        <span class="k">NOT NULL</span>,   <span class="c">-- device clock, seconds (not Unix time)</span>
  voltage_v      NUMERIC(7,1)  <span class="k">NOT NULL</span>,
  current_a      NUMERIC(7,2)  <span class="k">NOT NULL</span>,
  power_factor   NUMERIC(4,2)  <span class="k">NOT NULL</span>,
  temperature_c  NUMERIC(7,1)  <span class="k">NOT NULL</span>,
  rpm            INTEGER       <span class="k">NOT NULL</span>,
  batch_id       VARCHAR(128)  <span class="k">NOT NULL</span>,
  received_at    TIMESTAMPTZ   <span class="k">NOT NULL DEFAULT NOW</span>(),
  <span class="k">PRIMARY KEY</span> (device_id, seq)
);

<span class="c">-- One row per upload attempt (including retries and duplicates).</span>
<span class="k">CREATE TABLE</span> motor_upload_log (
  id             BIGSERIAL     <span class="k">PRIMARY KEY</span>,
  device_id      VARCHAR(64)   <span class="k">NOT NULL</span>,
  batch_id       VARCHAR(128)  <span class="k">NOT NULL</span>,
  first_seq      BIGINT        <span class="k">NOT NULL</span>,
  last_seq       BIGINT        <span class="k">NOT NULL</span>,
  record_count   INTEGER       <span class="k">NOT NULL</span>,   <span class="c">-- records the device sent</span>
  stored_count   INTEGER       <span class="k">NOT NULL</span>,   <span class="c">-- newly inserted (0 on duplicate)</span>
  boot           BIGINT,
  lost_total     BIGINT,
  dropped_total  BIGINT,
  received_at    TIMESTAMPTZ   <span class="k">NOT NULL DEFAULT NOW</span>()
);</pre>
</div>

<!-- CODE EXAMPLES -->
<div class="doc-section" id="examples">
  <h2>Code examples</h2>

  <h3>curl — send a batch</h3>
  <button class="copy-btn" onclick="copy('ex-curl')">Copy</button>
  <pre id="ex-curl">curl -X POST http://&lt;host&gt;:8080/api/sensor-data/bulk \
  -H <span class="s">"Content-Type: application/json"</span> \
  -d <span class="s">'{"device_id":"MOTOR_001","batch_id":"MOTOR_001-1001-1002",
      "first_seq":1001,"last_seq":1002,"count":2,"boot":1,
      "lost_total":0,"dropped_total":0,"records":[
        {"seq":1001,"timestamp":1000,"voltage":230.5,"current":0.85,
         "power_factor":0.92,"temperature":45.6,"rpm":1450},
        {"seq":1002,"timestamp":1001,"voltage":231.0,"current":0.87,
         "power_factor":0.91,"temperature":45.8,"rpm":1452}
      ]}'</span></pre>

  <h3>curl — fetch latest records</h3>
  <button class="copy-btn" onclick="copy('ex-curl2')">Copy</button>
  <pre id="ex-curl2">curl <span class="s">"http://&lt;host&gt;:8080/api/motor/recent?device_id=MOTOR_001&limit=50"</span></pre>

  <h3>Python — send a batch</h3>
  <button class="copy-btn" onclick="copy('ex-py')">Copy</button>
  <pre id="ex-py"><span class="k">import</span> requests, time

payload = {
    <span class="s">"device_id"</span>:      <span class="s">"MOTOR_001"</span>,
    <span class="s">"batch_id"</span>:       <span class="s">"MOTOR_001-1001-1002"</span>,
    <span class="s">"first_seq"</span>:      <span class="n">1001</span>,
    <span class="s">"last_seq"</span>:       <span class="n">1002</span>,
    <span class="s">"count"</span>:          <span class="n">2</span>,
    <span class="s">"boot"</span>:           <span class="n">1</span>,
    <span class="s">"lost_total"</span>:     <span class="n">0</span>,
    <span class="s">"dropped_total"</span>:  <span class="n">0</span>,
    <span class="s">"records"</span>: [
        {<span class="s">"seq"</span>:<span class="n">1001</span>,<span class="s">"timestamp"</span>:<span class="n">1000</span>,<span class="s">"voltage"</span>:<span class="n">230.5</span>,<span class="s">"current"</span>:<span class="n">0.85</span>,
         <span class="s">"power_factor"</span>:<span class="n">0.92</span>,<span class="s">"temperature"</span>:<span class="n">45.6</span>,<span class="s">"rpm"</span>:<span class="n">1450</span>},
        {<span class="s">"seq"</span>:<span class="n">1002</span>,<span class="s">"timestamp"</span>:<span class="n">1001</span>,<span class="s">"voltage"</span>:<span class="n">231.0</span>,<span class="s">"current"</span>:<span class="n">0.87</span>,
         <span class="s">"power_factor"</span>:<span class="n">0.91</span>,<span class="s">"temperature"</span>:<span class="n">45.8</span>,<span class="s">"rpm"</span>:<span class="n">1452</span>},
    ],
}

resp = requests.post(
    <span class="s">"http://&lt;host&gt;:8080/api/sensor-data/bulk"</span>,
    json=payload,
    timeout=<span class="n">120</span>,
)
print(resp.json())  <span class="c"># {"status": "ok", "ack_seq": 1002}</span></pre>

  <h3>Python — subscribe to SSE stream</h3>
  <button class="copy-btn" onclick="copy('ex-py2')">Copy</button>
  <pre id="ex-py2"><span class="c"># pip install sseclient-py requests</span>
<span class="k">import</span> sseclient, requests, json

resp = requests.get(
    <span class="s">"http://&lt;host&gt;:8080/api/motor/stream"</span>,
    stream=<span class="k">True</span>,
    timeout=<span class="n">None</span>,
)
<span class="k">for</span> event <span class="k">in</span> sseclient.SSEClient(resp):
    <span class="k">if not</span> event.data.strip():
        <span class="k">continue</span>
    data = json.loads(event.data)
    <span class="k">if</span> data.get(<span class="s">"type"</span>) == <span class="s">"connected"</span>:
        print(<span class="s">"Connected to live stream"</span>)
    <span class="k">else</span>:
        print(<span class="s">f"New batch from {data['device_id']}: seq {data['first_seq']}–{data['last_seq']}"</span>)</pre>
</div>

</div><!-- doc-body -->
</div><!-- doc-layout -->
</div><!-- container -->
</div><!-- page-docs -->

<script>
/* ── page switcher ── */
function showPage(name,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  btn.classList.add('active');
}
function scrollTo(id){
  const el=document.getElementById(id);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
  document.querySelectorAll('.doc-nav a').forEach(a=>a.classList.remove('active'));
  const link=document.querySelector(`.doc-nav a[href="#${id}"]`);
  if(link)link.classList.add('active');
}
function copy(id){
  const el=document.getElementById(id);if(!el)return;
  navigator.clipboard.writeText(el.innerText).then(()=>{
    const btn=el.previousElementSibling;
    if(btn){btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500);}
  });
}

/* ── dashboard ── */
const COLORS={voltage_v:'#818cf8',current_a:'#34d399',power_factor:'#f59e0b',temperature_c:'#f87171',rpm:'#38bdf8'};
let allDevices=[],allUploads=[];
let activeDevice='',currentPage=1,pageSize=10,totalPages=1,totalCount=0;
let chartRows=[];

function fmtTime(iso){if(!iso)return'—';const d=new Date(iso);return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function fmtDt(iso){if(!iso)return'—';const d=new Date(iso);return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function secAgo(iso){if(!iso)return'';const s=Math.round((Date.now()-new Date(iso).getTime())/1000);if(s<60)return s+'s ago';if(s<3600)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago';}

/* device dropdown */
function renderDeviceSelect(){
  const sel=document.getElementById('device-select');
  const prev=sel.value||activeDevice;
  sel.innerHTML='<option value="">All devices</option>'+
    allDevices.map(d=>`<option value="${d.device_id}">${d.device_id} (${d.total_records.toLocaleString()} rec)</option>`).join('');
  sel.value=prev;
}
function onDeviceChange(){
  activeDevice=document.getElementById('device-select').value;
  currentPage=1;fetchData();
}
function onPageSizeChange(){
  pageSize=parseInt(document.getElementById('page-size-select').value);
  currentPage=1;fetchData();
}

/* stats */
function renderStats(){
  const totalRec=allDevices.reduce((a,d)=>a+d.total_records,0);
  const lastSeen=allDevices.length?allDevices[0].last_seen:null;
  const lostSum=allUploads.reduce((a,u)=>a+(u.lost_total||0),0);
  const dropSum=allUploads.reduce((a,u)=>a+(u.dropped_total||0),0);
  document.getElementById('stats').innerHTML=`
    <div class="card"><div class="card-label">Active Devices</div><div class="card-value">${allDevices.length}</div></div>
    <div class="card"><div class="card-label">Total Records</div><div class="card-value">${totalRec.toLocaleString()}</div></div>
    <div class="card ${lostSum>0?'warn':''}"><div class="card-label">Lost Records</div>
      <div class="card-value">${lostSum}</div><div class="card-sub">flash overflow</div></div>
    <div class="card ${dropSum>0?'warn':''}"><div class="card-label">Dropped Records</div>
      <div class="card-value">${dropSum}</div><div class="card-sub">memory full</div></div>
    <div class="card"><div class="card-label">Last Batch</div>
      <div class="card-value" style="font-size:1rem;padding-top:4px">${lastSeen?fmtDt(lastSeen):'—'}</div></div>`;
}

/* ── interactive Plotly-style charts ── */
const _tip=document.getElementById('chart-tooltip');

function _buildPts(data,w,h,pad){
  if(!data.length)return[];
  const W=w-pad.l-pad.r,H=h-pad.t-pad.b;
  const ys=data.map(d=>d.y),minY=Math.min(...ys),maxY=Math.max(...ys),rangeY=maxY-minY||1;
  return data.map((d,i)=>({
    x:pad.l+W*(data.length<2?0.5:i/(data.length-1)),
    y:pad.t+H*(1-(d.y-minY)/rangeY),
    val:d.y,ts:d.ts,minY,maxY,rangeY
  }));
}

function _smoothPath(ctx,pts){
  if(!pts.length)return;
  ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=0;i<pts.length-1;i++){
    const mx=(pts[i].x+pts[i+1].x)/2;
    ctx.bezierCurveTo(mx,pts[i].y,mx,pts[i+1].y,pts[i+1].x,pts[i+1].y);
  }
}

function _tickFmt(v,unit){
  return v.toFixed(unit==='rpm'?0:(Math.abs(v)<10?2:1));
}

function createChart(canvas,data,color,label,unit){
  const dpr=window.devicePixelRatio||1;
  const pad={t:16,b:30,l:52,r:12};
  let hIdx=-1;

  function render(w,h){
    canvas.width=w*dpr;canvas.height=h*dpr;
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,w,h);
    const pts=_buildPts(data,w,h,pad);
    if(!pts.length)return;
    const {minY,maxY,rangeY}=pts[0];
    const TICKS=4;
    for(let i=0;i<=TICKS;i++){
      const y=pad.t+(h-pad.t-pad.b)*i/TICKS;
      const v=maxY-rangeY*i/TICKS;
      ctx.beginPath();ctx.strokeStyle=i===TICKS?'#cbd5e1':'#e2e8f0';
      ctx.lineWidth=i===TICKS?1.5:1;ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();
      ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='right';
      ctx.fillText(_tickFmt(v,unit),pad.l-6,y+3.5);
    }
    [[0,'left'],[Math.floor((pts.length-1)/2),'center'],[pts.length-1,'right']].forEach(([i,align])=>{
      if(i<0||i>=pts.length)return;
      ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign=align;
      const xOff=align==='left'?pad.l:align==='right'?w-pad.r:pts[i].x;
      ctx.fillText(fmtTime(data[i].ts),xOff,h-6);
    });
    const grad=ctx.createLinearGradient(0,pad.t,0,h-pad.b);
    grad.addColorStop(0,color+'28');grad.addColorStop(1,color+'00');
    ctx.beginPath();_smoothPath(ctx,pts);
    ctx.lineTo(pts[pts.length-1].x,h-pad.b);ctx.lineTo(pts[0].x,h-pad.b);ctx.closePath();
    ctx.fillStyle=grad;ctx.fill();
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';
    _smoothPath(ctx,pts);ctx.stroke();
    pts.forEach(p=>{
      ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);ctx.fillStyle=color+'60';ctx.fill();
    });
    if(hIdx>=0&&hIdx<pts.length){
      const p=pts[hIdx];
      ctx.beginPath();ctx.strokeStyle='#94a3b8';ctx.lineWidth=1;ctx.setLineDash([4,4]);
      ctx.moveTo(p.x,pad.t);ctx.lineTo(p.x,h-pad.b);ctx.stroke();
      ctx.moveTo(pad.l,p.y);ctx.lineTo(w-pad.r,p.y);ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();ctx.arc(p.x,p.y,6,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
      ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.stroke();
      ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    }
  }

  function go(){render(canvas.offsetWidth||300,canvas.offsetHeight||160);}
  go();

  canvas.addEventListener('mousemove',e=>{
    const rect=canvas.getBoundingClientRect();
    const mx=e.clientX-rect.left;
    const pts=_buildPts(data,canvas.offsetWidth,canvas.offsetHeight,pad);
    if(!pts.length)return;
    let best=0,bestD=Infinity;
    pts.forEach((p,i)=>{const d=Math.abs(p.x-mx);if(d<bestD){bestD=d;best=i;}});
    hIdx=best;go();
    const dec=unit==='rpm'?0:2;
    _tip.style.display='block';
    _tip.style.left=(e.clientX+14)+'px';
    _tip.style.top=(e.clientY-54)+'px';
    _tip.innerHTML=`<div style="color:#94a3b8;font-size:.7rem;margin-bottom:2px">${fmtDt(data[best].ts)}</div>`+
      `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle"></span>`+
      `<strong style="color:${color}">${parseFloat(data[best].y).toFixed(dec)}${unit?' '+unit:''}</strong>`;
  });
  canvas.addEventListener('mouseleave',()=>{hIdx=-1;go();_tip.style.display='none';});
}

function renderCharts(){
  const el=document.getElementById('charts');
  if(!activeDevice||!chartRows.length){
    el.innerHTML=activeDevice
      ?'<div style="grid-column:1/-1;padding:32px;text-align:center;color:#94a3b8;font-size:.85rem">No data yet for this device.</div>'
      :'';
    return;
  }
  const metrics=[
    {key:'voltage_v',    label:'Voltage',      unit:'V',   color:'#6366f1'},
    {key:'current_a',   label:'Current',       unit:'A',   color:'#059669'},
    {key:'power_factor',label:'Power Factor',  unit:'',    color:'#d97706'},
    {key:'temperature_c',label:'Temperature',  unit:'°C',  color:'#dc2626'},
    {key:'rpm',         label:'RPM',           unit:'rpm', color:'#0284c7'},
  ];
  el.innerHTML=`<div style="grid-column:1/-1;font-size:.72rem;color:#94a3b8">Latest ${chartRows.length} readings &nbsp;·&nbsp; <strong style="color:#475569">${activeDevice}</strong></div>`+
    metrics.map(m=>{
      const last=chartRows.filter(r=>r[m.key]!=null).pop();
      const cur=last?parseFloat(last[m.key]).toFixed(m.unit==='rpm'?0:2):'—';
      return `<div class="chart-box">
        <div class="chart-title"><span>${m.label}</span>
          <span class="chart-cur" style="color:${m.color}">${cur}<span class="chart-unit">${m.unit}</span></span></div>
        <canvas id="c-${m.key}" height="160" style="height:160px"></canvas></div>`;
    }).join('');
  requestAnimationFrame(()=>{
    metrics.forEach(m=>{
      const data=chartRows.filter(r=>r[m.key]!=null).map(r=>({y:parseFloat(r[m.key]),ts:r.received_at}));
      if(data.length)createChart(document.getElementById('c-'+m.key),data,m.color,m.label,m.unit);
    });
  });
}

/* table */
function renderTable(rows){
  const body=document.getElementById('rec-body');
  if(!rows.length){body.innerHTML='<tr><td colspan="7" class="empty">No records found</td></tr>';return;}
  body.innerHTML=rows.map(r=>`<tr>
    <td>${r.seq}</td><td>${parseFloat(r.voltage_v).toFixed(1)}</td>
    <td>${parseFloat(r.current_a).toFixed(2)}</td><td>${parseFloat(r.power_factor).toFixed(2)}</td>
    <td>${parseFloat(r.temperature_c).toFixed(1)}</td><td>${r.rpm}</td>
    <td>${fmtDt(r.received_at)}</td></tr>`).join('');
}

/* pagination */
function renderPagination(){
  const el=document.getElementById('pagination');
  if(totalPages<=1){el.innerHTML='';return;}
  const maxBtns=7,half=Math.floor(maxBtns/2);
  let start=Math.max(1,currentPage-half),end=Math.min(totalPages,start+maxBtns-1);
  if(end-start<maxBtns-1)start=Math.max(1,end-maxBtns+1);
  let html=`<button class="pg-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>‹ Prev</button>`;
  if(start>1)html+=`<button class="pg-btn" onclick="goPage(1)">1</button>${start>2?'<span class="pg-info">…</span>':''}`;
  for(let p=start;p<=end;p++)
    html+=`<button class="pg-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
  if(end<totalPages)html+=`${end<totalPages-1?'<span class="pg-info">…</span>':''}<button class="pg-btn" onclick="goPage(${totalPages})">${totalPages}</button>`;
  html+=`<button class="pg-btn" onclick="goPage(${currentPage+1})" ${currentPage===totalPages?'disabled':''}>Next ›</button>`;
  html+=`<span class="pg-info">${totalCount.toLocaleString()} total records</span>`;
  el.innerHTML=html;
}
function goPage(p){if(p<1||p>totalPages)return;currentPage=p;fetchData();}

/* upload log */
function renderUploadLog(){
  const body=document.getElementById('log-body');
  if(!allUploads.length){body.innerHTML='<tr><td colspan="8" class="empty">No uploads yet</td></tr>';return;}
  body.innerHTML=allUploads.map(u=>`<tr>
    <td>${u.device_id}</td><td style="font-size:.7rem;color:#94a3b8">${u.batch_id}</td>
    <td>${u.first_seq}–${u.last_seq}</td><td>${u.record_count}</td><td>${u.stored_count}</td>
    <td>${u.lost_total>0?`<span class="badge badge-warn">${u.lost_total}</span>`:'0'}</td>
    <td>${u.dropped_total>0?`<span class="badge badge-warn">${u.dropped_total}</span>`:'0'}</td>
    <td>${fmtDt(u.received_at)}</td></tr>`).join('');
}

let lastUpdate=null;
function setLastUpdate(){lastUpdate=new Date();}
setInterval(()=>{
  if(lastUpdate)document.getElementById('last-upd').textContent='Updated '+secAgo(lastUpdate.toISOString());
},10000);

async function fetchData(){
  const params=new URLSearchParams({page:currentPage,page_size:pageSize});
  if(activeDevice)params.set('device_id',activeDevice);
  const r=await fetch('/api/motor/recent?'+params);
  const d=await r.json();
  const pg=d.pagination||{};
  totalPages=pg.total_pages||1;totalCount=pg.total_count||0;
  currentPage=pg.page||currentPage;
  allDevices=d.devices||[];allUploads=d.uploads||[];chartRows=d.chart_rows||[];
  if(!activeDevice&&allDevices.length){
    activeDevice=allDevices[0].device_id;
    document.getElementById('device-select').value=activeDevice;
    return fetchData();
  }
  renderDeviceSelect();renderStats();renderCharts();
  renderTable(d.records||[]);renderPagination();renderUploadLog();
  setLastUpdate();
}

function connectSSE(){
  const badge=document.getElementById('live-badge');
  const es=new EventSource('/api/motor/stream');
  es.onopen=()=>{badge.className='live-badge';badge.innerHTML='<span class="live-dot"></span>Live';};
  es.onerror=()=>{badge.className='live-badge off';badge.innerHTML='<span class="live-dot"></span>Reconnecting…';};
  es.onmessage=e=>{
    try{
      const p=JSON.parse(e.data);if(p.type==='connected')return;
      // if viewing this device (or all), refresh current page
      if(!activeDevice||p.device_id===activeDevice)fetchData();
    }catch(err){}
  };
}

fetchData().then(connectSSE);
</script>
</body>
</html>"""


@app.route("/")
def dashboard():
    return Response(_DASHBOARD_HTML, mimetype="text/html")


# ---------------------------
# Entry point
# ---------------------------

def main():
    print(f"[INFO] motor logger HTTP server starting on {MOTOR_HTTP_HOST}:{MOTOR_HTTP_PORT}")
    print(f"[INFO] MAX_BODY_BYTES={MAX_BODY_BYTES} MAX_RECORDS={MAX_RECORDS_PER_REQUEST}")
    print(f"[INFO] DEBUG_MOTOR={'1' if DEBUG_MOTOR else '0'}")
    print(f"[INFO] raw_json_path={MOTOR_RAW_JSON_PATH.resolve()} async={MOTOR_RAW_JSON_ASYNC}")
    print(f"[INFO] cwd={os.getcwd()}")

    targets = _get_target_db_configs()
    for name, cfg in targets:
        print(f"[INFO] DB target {name}: host={cfg.get('host')} db={cfg.get('dbname')}")

    # Use Werkzeug's threaded server (fine for the ~6 req/device/5-min load)
    from werkzeug.serving import make_server
    srv = make_server(MOTOR_HTTP_HOST, MOTOR_HTTP_PORT, app, threaded=True)
    print(f"[OK] Listening on {MOTOR_HTTP_HOST}:{MOTOR_HTTP_PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[INFO] Shutting down motor logger HTTP server")


if __name__ == "__main__":
    main()
