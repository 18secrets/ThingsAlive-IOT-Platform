#!/usr/bin/env bash
# QML1-SIZE: what torch costs the scheduler image. Produces every number in
# docs/ai/measurements/QML1-SIZE.md.
#
#   scripts/qml1-size/measure.sh [out-dir]
#
# Builds from `git archive HEAD`, never the working tree, so a run from a clean clone
# measures exactly what is committed. Builds for linux/amd64, because that is what
# Railway runs; on an arm64 host every timing is emulated and is labelled so.
#
# Needs: docker with buildx, git, curl, python3. Starts and removes its own Postgres
# and registry containers; touches no other container, image or volume except the
# qml1size/* images it builds.
#
# SKIP_BUILDS=1 keeps an earlier run's B outcome and build timings in out-dir and only
# rebuilds each image from cache before measuring sizes and start-up.
#
# RUNS (default 5) is the repeat count for every timed step. MEMORY (default 8g, capped
# at what the Docker VM has) is the container limit D35's 8-core/8 GB box is matched to.
set -euo pipefail

RUNS="${RUNS:-5}"
PLATFORM=linux/amd64
REPO="$(git rev-parse --show-toplevel)"
OUT="${1:-$(mktemp -d -t qml1-size)}"
mkdir -p "$OUT"
NET=qml1size-net
PG=qml1size-pg
REG=qml1size-registry
REG_PORT="${REG_PORT:-5055}"
APP_PORT="${APP_PORT:-18080}"

img() { printf 'qml1size/%s' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; }  # tags must be lowercase
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/measure.log" >&2; }

cleanup() {
  docker rm -f "$PG" "$REG" >/dev/null 2>&1 || true
  docker rm -f qml1size-app >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "${CTX:-}" ] && rm -rf "$CTX"
}
trap cleanup EXIT

# ---- environment --------------------------------------------------------------
VM_MEM_BYTES="$(docker info --format '{{.MemTotal}}')"
VM_MEM_GB=$(( VM_MEM_BYTES / 1024 / 1024 / 1024 ))
WANT_MEM="${MEMORY:-8g}"
if [ "${WANT_MEM%g}" -gt "$VM_MEM_GB" ] 2>/dev/null; then MEM="${VM_MEM_GB}g"; else MEM="$WANT_MEM"; fi
CPUS="$(docker info --format '{{.NCPU}}')"; [ "$CPUS" -gt 8 ] && CPUS=8
{
  echo "host_arch=$(uname -m)"
  echo "host_os=$(uname -s) $(uname -r)"
  echo "docker_client=$(docker version --format '{{.Client.Version}}')"
  echo "docker_server=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  echo "docker_vm=cpus $(docker info --format '{{.NCPU}}') mem ${VM_MEM_GB}g"
  echo "container_limits=--cpus=$CPUS --memory=$MEM (requested 8 / $WANT_MEM)"
  echo "platform=$PLATFORM"
  echo "emulated=$([ "$(uname -m)" = x86_64 ] && echo no || echo yes)"
  echo "base_sha=$(git -C "$REPO" rev-parse HEAD)"
  echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "runs=$RUNS"
} > "$OUT/environment.txt"
cat "$OUT/environment.txt" >&2

# ---- build context: the committed tree --------------------------------------------
CTX="$(mktemp -d -t qml1-ctx)"
git -C "$REPO" archive HEAD | tar -x -C "$CTX"

# variant name | dockerfile | target
VARIANTS="A|Dockerfile|runtime
C|scripts/qml1-size/Dockerfile.C|runtime
D|scripts/qml1-size/Dockerfile.D|scheduler
E|scripts/qml1-size/Dockerfile.D|api"

build() { # name file target extra-args...
  local name="$1" file="$2" target="$3"; shift 3
  docker buildx build --builder desktop-linux --load --platform "$PLATFORM" --progress=plain \
    -f "$CTX/$file" --target "$target" -t "$(img "$name")" "$@" "$CTX" < /dev/null
}

if [ "${SKIP_BUILDS:-0}" != 1 ]; then
# ---- B: does torch install on musl? One attempt, recorded, not worked around --------
log "B: attempting the torch install on node:22-alpine"
if build B scripts/qml1-size/Dockerfile.B runtime --no-cache > "$OUT/B.build.log" 2>&1; then
  echo "builds" > "$OUT/B.outcome"
else
  # The step that failed and its last error lines, quoted in the report as they are.
  { echo "fails"; grep -E '^#[0-9]+ \[runtime' "$OUT/B.build.log" | tail -1; grep -iE 'error' "$OUT/B.build.log" | tail -8; } > "$OUT/B.outcome"
fi
log "B: $(cat "$OUT/B.outcome")"

# ---- builds: cold (no cache) and warm (one-line src change) --------------------------
printf 'variant\tkind\trun\tseconds\ttorch_layer_rebuilt\n' > "$OUT/builds.tsv"
echo "$VARIANTS" | while IFS='|' read -r name file target; do
  for i in $(seq 1 "$RUNS"); do
    log "$name: cold build $i/$RUNS"
    t=$(now); build "$name" "$file" "$target" --no-cache > "$OUT/$name.cold.$i.log" 2>&1; e=$(now)
    printf '%s\tcold\t%s\t%.1f\t-\n' "$name" "$i" "$(python3 -c "print($e-$t)")" >> "$OUT/builds.tsv"
  done
  for i in $(seq 1 "$RUNS"); do
    # A one-line change under src/, unique to this run of the script too: a probe line
    # repeated from an earlier run is a cache hit, and a 0.7 s "rebuild" (seen once).
    printf '\n// QML1-SIZE warm-rebuild probe %s %s %s\n' "$name" "$i" "$(now)" >> "$CTX/src/main.ts"
    log "$name: warm rebuild $i/$RUNS"
    t=$(now); build "$name" "$file" "$target" > "$OUT/$name.warm.$i.log" 2>&1; e=$(now)
    # Was the pip install layer rebuilt by a src change? (A layer-order defect if so.)
    # BuildKit's plain progress prints a step, then "#N CACHED" on the next line when it
    # reused it. Only D has the step; elsewhere the answer is "-".
    rebuilt=-
    if grep -q 'RUN /opt/venv/bin/pip install' "$OUT/$name.warm.$i.log"; then
      if grep -A1 'RUN /opt/venv/bin/pip install' "$OUT/$name.warm.$i.log" | grep -q 'CACHED'; then
        rebuilt=no; else rebuilt=yes; fi
    fi
    printf '%s\twarm\t%s\t%.1f\t%s\n' "$name" "$i" "$(python3 -c "print($e-$t)")" "$rebuilt" >> "$OUT/builds.tsv"
  done
  git -C "$REPO" show HEAD:src/main.ts > "$CTX/src/main.ts"
done
fi

# The images measured below are the committed source, rebuilt from cache now: Docker
# Desktop can reclaim an image built an hour earlier (it did, once, mid-run).
echo "$VARIANTS" | while IFS='|' read -r name file target; do
  git -C "$REPO" show HEAD:src/main.ts > "$CTX/src/main.ts"
  log "$name: final image"
  build "$name" "$file" "$target" > "$OUT/$name.final.log" 2>&1
done

# ---- sizes: uncompressed, and compressed as a registry stores them -----------------
log "sizes"
docker network create "$NET" >/dev/null
docker run -d --name "$REG" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null
sleep 3
printf 'variant\tuncompressed_bytes\tcompressed_bytes\tlayers\n' > "$OUT/sizes.tsv"
for name in A C D E; do
  # --platform: on an arm64 host the image store resolves the host's platform otherwise.
  docker history --platform "$PLATFORM" --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' "$(img "$name")" > "$OUT/$name.history.tsv"
  unc="$(docker image inspect --platform "$PLATFORM" --format '{{.Size}}' "$(img "$name")")"
  docker tag "$(img "$name")" "localhost:$REG_PORT/$(img "$name"):measure"
  docker push -q "localhost:$REG_PORT/$(img "$name"):measure" > /dev/null
  python3 - "$REG_PORT" "$name" "$unc" >> "$OUT/sizes.tsv" <<'PY'
import json, sys, urllib.request
port, name, unc = sys.argv[1:]
ACCEPT = ', '.join([
    'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])
def get(ref):
    req = urllib.request.Request(f'http://localhost:{port}/v2/qml1size/{name.lower()}/manifests/{ref}', headers={'Accept': ACCEPT})
    return json.load(urllib.request.urlopen(req))
m = get('measure')
if 'manifests' in m:  # an index: take the linux/amd64 image, not attestations
    m = get(next(x['digest'] for x in m['manifests']
                 if x.get('platform', {}).get('architecture') == 'amd64' and x['platform'].get('os') == 'linux'))
layers = m['layers']
print(f"{name}\t{unc}\t{sum(l['size'] for l in layers)}\t{len(layers)}")
PY
done

# ---- cold start, node: container start until /api/v1/ready answers 200 -------------
log "node readiness"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=measure -e POSTGRES_DB=ta2 postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
DBENV=(-e DB_HOST="$PG" -e DB_USERNAME=postgres -e DB_PASSWORD=measure -e DB_DATABASE=ta2
       -e AUTH_JWT_SECRET=measure-only -e CORS_ORIGINS=http://localhost -e PORT=8080)
# Migrations once, with the baseline image: they create the ta_app role the app connects as.
docker run --rm --platform "$PLATFORM" --network "$NET" "${DBENV[@]}" "$(img A)" \
  node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js > "$OUT/migrations.log" 2>&1

printf 'variant\trun\tready_seconds\n' > "$OUT/ready.tsv"
for name in A C D E; do
  for i in $(seq 1 "$RUNS"); do
    docker rm -f qml1size-app >/dev/null 2>&1 || true
    t=$(now)
    docker run -d --name qml1size-app --platform "$PLATFORM" --network "$NET" --cpus="$CPUS" --memory="$MEM" \
      -p "127.0.0.1:$APP_PORT:8080" "${DBENV[@]}" "$(img "$name")" >/dev/null
    ok=no
    for _ in $(seq 1 1200); do
      if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/v1/ready" || true)" = 200 ]; then ok=yes; break; fi
      sleep 0.1
    done
    e=$(now)
    [ "$ok" = yes ] || { docker logs qml1size-app > "$OUT/$name.ready.$i.fail.log" 2>&1; log "$name: not ready in 120 s"; }
    printf '%s\t%s\t%s\n' "$name" "$i" "$([ "$ok" = yes ] && python3 -c "print(round($e-$t,2))" || echo timeout)" >> "$OUT/ready.tsv"
    docker rm -f qml1size-app >/dev/null
  done
done

# ---- cold start, python: import, model load, 1 and 1000 series, peak RSS (D only) ---
log "python timings in D"
: > "$OUT/python.jsonl"
for i in $(seq 1 "$RUNS"); do
  docker run --rm --platform "$PLATFORM" --cpus="$CPUS" --memory="$MEM" \
    -v "$REPO/scripts/qml1-size/bench.py:/opt/bench.py:ro" "$(img D)" /opt/venv/bin/python /opt/bench.py \
    >> "$OUT/python.jsonl" 2> "$OUT/python.$i.stderr"
done
docker run --rm --platform "$PLATFORM" "$(img D)" /opt/venv/bin/pip freeze > "$OUT/D.pip-freeze.txt"

# ---- summary --------------------------------------------------------------------
python3 "$REPO/scripts/qml1-size/summarise.py" "$OUT" | tee "$OUT/summary.md"
log "done: $OUT"
