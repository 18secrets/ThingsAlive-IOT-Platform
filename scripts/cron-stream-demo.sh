#!/usr/bin/env bash
set -euo pipefail

# Export environment paths so cron has access to node and npm
export PATH="/Users/tapasmohanty/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL must be exported in environment before running cron" >&2
  exit 1
fi
export SEED_DEMO_ENABLED="true"
export DEMO_FORCE_RUNNING="true"

PROJECT_DIR="/Users/tapasmohanty/Downloads/things-alive-iot-platform-2.0"
cd "$PROJECT_DIR"

echo "=== [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting Demo Telemetry & Forecast Pass ==="
npm run demo:stream:once
echo "=== [$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Finished Pass successfully ==="
