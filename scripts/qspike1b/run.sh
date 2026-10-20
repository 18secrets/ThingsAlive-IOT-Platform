#!/bin/sh
# QSPIKE1b's one attempt. Every line worth keeping starts with "QSPIKE1b", so the report is
# built from `railway logs | grep QSPIKE1b` and nothing is hand-copied.
# Order: the run most likely to complete first, the suspected stall last, so a day that ends
# early still has an answer.
set -u
say() { echo "QSPIKE1b $*"; }
TIMEOUT_S=${QSPIKE1B_TIMEOUT_S:-1800}   # per inference (prompt question 3)
N_GEN=128

say start $(date -u +%FT%TZ)
say cpu "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')"
say nproc $(nproc)
say cpu.max "$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"
say memory.max "$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
F=$(grep -m1 ^flags /proc/cpuinfo)
for x in avx avx2 fma f16c avx512f avx512_vnni avx_vnni; do
  case " $F " in *" $x "*) say flag $x yes;; *) say flag $x NO;; esac
done
say model_sha256 $(sha256sum /opt/model.gguf | cut -d' ' -f1)

# the quota, not nproc: nproc reports the host's cores, the cgroup is what may run
Q=$(awk '{ if ($1 == "max") print 0; else printf "%d", $1 / $2 }' /sys/fs/cgroup/cpu.max 2>/dev/null)
[ -z "$Q" ] || [ "$Q" -lt 1 ] && Q=$(nproc)
OVER=$((Q * 3))   # QSPIKE1's suspected ratio: 24 default threads on an 8-CPU quota
say quota_cpus $Q oversubscribed_threads $OVER

run() { # build threads label
  B=$1; T=$2; L=$3; OUT=/tmp/$L.out; ERR=/tmp/$L.err
  say run_begin $L build=$B threads=$T $(date -u +%T)
  ( while sleep 60; do say progress $L output_bytes=$(wc -c < $OUT 2>/dev/null || echo 0); done ) &
  P=$!
  S=$(date +%s)
  /usr/bin/time -v timeout $TIMEOUT_S /opt/$B/llama-cli -m /opt/model.gguf -f /opt/prompt.txt \
    -n $N_GEN -t $T -c 2048 --temp 0 --seed 1 -no-cnv --no-display-prompt --ignore-eos > $OUT 2> $ERR
  RC=$?
  kill $P 2>/dev/null
  say run_end $L rc=$RC wall_s=$(( $(date +%s) - S )) output_bytes=$(wc -c < $OUT)
  [ $RC -eq 124 ] && say timeout $L after ${TIMEOUT_S}s
  grep -E 'load time|prompt eval time|eval time|total time' $ERR | sed "s/^/QSPIKE1b timing $L /"
  grep -E 'Maximum resident set size' $ERR | sed "s/^\s*/QSPIKE1b rss $L /"
  grep -m1 -E 'system_info' $ERR | sed "s/^/QSPIKE1b $L /"
}

for i in 1 2 3; do run isa $Q isa_t${Q}_r$i; done
say sample_output "$(head -c 600 /tmp/isa_t${Q}_r1.out | tr '\n' ' ')"
for i in 1 2 3; do run generic $Q generic_t${Q}_r$i; done
run isa $OVER isa_t${OVER}_r1
run generic $OVER generic_t${OVER}_r1
say done $(date -u +%FT%TZ)
# exits on purpose; restartPolicyType NEVER keeps it from running again
