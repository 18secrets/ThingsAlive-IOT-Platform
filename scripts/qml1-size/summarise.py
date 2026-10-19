"""Turns measure.sh's raw files into the tables in docs/ai/measurements/QML1-SIZE.md.

Medians and maxima, never a mean alone. Every number traces to a file in the out dir.
"""
import csv
import json
import statistics
import sys
from pathlib import Path

out = Path(sys.argv[1])
env = dict(line.split('=', 1) for line in (out / 'environment.txt').read_text().splitlines() if '=' in line)
emulated = env.get('emulated') == 'yes'
TAG = ' (emulated, not representative)' if emulated else ''


def rows(name):
    with open(out / name) as f:
        return list(csv.DictReader(f, delimiter='\t'))


def mb(b):
    return f'{int(b) / 1e6:,.0f} MB'


def med_max(values, unit='s', nd=1):
    if not values:
        return 'n/a'
    return f'{statistics.median(values):.{nd}f} / {max(values):.{nd}f} {unit}'


builds = rows('builds.tsv')
sizes = {r['variant']: r for r in rows('sizes.tsv')}
ready = rows('ready.tsv')
py = [json.loads(line) for line in (out / 'python.jsonl').read_text().splitlines() if line.strip()]


def b(variant, kind):
    return [float(r['seconds']) for r in builds if r['variant'] == variant and r['kind'] == kind]


def rd(variant):
    return [float(r['ready_seconds']) for r in ready if r['variant'] == variant and r['ready_seconds'] != 'timeout']


def timeouts(variant):
    return sum(1 for r in ready if r['variant'] == variant and r['ready_seconds'] == 'timeout')


print('## Environment\n')
for k, v in env.items():
    print(f'- {k}: {v}')
print()
print('## Results\n')
print(f'Timings are median / max of {env.get("runs")} runs{TAG}. Sizes do not depend on the host.\n')
print('| variant | builds? | uncompressed | compressed | cold build | warm rebuild | torch layer rebuilt on src change |')
print('|---|---|---|---|---|---|---|')
print(f'| B (alpine + torch) | {(out / "B.outcome").read_text().strip()} | – | – | – | – | – |')
for v in 'ACDE':
    s = sizes[v]
    rebuilt = sorted({r['torch_layer_rebuilt'] for r in builds if r['variant'] == v and r['kind'] == 'warm'})
    print(f'| {v} | yes | {mb(s["uncompressed_bytes"])} | {mb(s["compressed_bytes"])} | '
          f'{med_max(b(v, "cold"))} | {med_max(b(v, "warm"))} | {", ".join(rebuilt)} |')
print()
print('| variant | node ready | py import | model load | 1-series | 1000-series | peak RSS |')
print('|---|---|---|---|---|---|---|')
for v in 'ACDE':
    t = timeouts(v)
    node = med_max(rd(v), nd=2) + (f' ({t} timed out)' if t else '')
    if v == 'D' and py:
        col = lambda k, nd=3: med_max([p[k] for p in py], nd=nd)  # noqa: E731
        print(f'| {v} | {node} | {col("py_import_s")} | {col("model_load_s")} | {col("one_series_s")} | '
              f'{col("thousand_series_s")} | {med_max([p["peak_rss_mb"] for p in py], "MB", 0)} |')
    else:
        print(f'| {v} | {node} | – | – | – | – | – |')
if py:
    p0 = py[0]
    print(f'\nPython process start-up before the first import: {med_max([p["startup_s"] for p in py], nd=3)}. '
          f'TTM context length {p0["context_length"]}, torch {p0["torch"]}, {p0["threads"]} threads.')
print()
print('## Delta\n')
print('| delta | uncompressed | compressed | cold build (median) | warm rebuild (median) | node ready (median) |')
print('|---|---|---|---|---|---|')
for a, z in (('D', 'A'), ('C', 'A'), ('E', 'A')):
    du = int(sizes[a]['uncompressed_bytes']) - int(sizes[z]['uncompressed_bytes'])
    dc = int(sizes[a]['compressed_bytes']) - int(sizes[z]['compressed_bytes'])
    med = lambda xs: statistics.median(xs) if xs else float('nan')  # noqa: E731
    print(f'| {a} − {z} | {du / 1e6:+,.0f} MB | {dc / 1e6:+,.0f} MB | '
          f'{med(b(a, "cold")) - med(b(z, "cold")):+.1f} s | {med(b(a, "warm")) - med(b(z, "warm")):+.1f} s | '
          f'{med(rd(a)) - med(rd(z)):+.2f} s |')
print()
print('## Largest layers of D\n')
print('| size | step |')
print('|---|---|')
hist = [line.split('\t', 1) for line in (out / 'D.history.tsv').read_text().splitlines() if '\t' in line]


def to_bytes(s):
    s = s.strip()
    for unit, mult in (('GB', 1e9), ('MB', 1e6), ('kB', 1e3), ('B', 1)):
        if s.endswith(unit):
            return float(s[:-len(unit)]) * mult
    return 0.0


for size, step in sorted(hist, key=lambda x: -to_bytes(x[0]))[:8]:
    print(f'| {size} | `{" ".join(step.split())[:110]}` |')
