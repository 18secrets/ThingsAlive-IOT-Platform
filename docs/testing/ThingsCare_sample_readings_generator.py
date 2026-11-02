# Dummy history for one demo excavator: DAYS days (default 30), every 10 minutes, ending at the last
# 10-minute tick before now. Shifts weekdays 08:00-18:00 IST with a Wednesday 13-15 stop,
# as the demo's own model. Coolant drifts +12 degC over the last 36 hours while running.
import csv, math, random, sys
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
STEP = timedelta(minutes=10)
now = datetime.now(timezone.utc)
end = now - timedelta(minutes=now.minute % 10, seconds=now.second, microseconds=now.microsecond)
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
start = end - timedelta(days=DAYS)
rnd = random.Random(42)

def running(t):
    l = t.astimezone(IST); h = l.hour + l.minute / 60; dow = l.isoweekday()  # Mon=1
    if dow > 5 or h < 8 or h >= 18: return False
    return not (dow == 3 and 13 <= h < 15)

def n(scale): return (rnd.random() - 0.5) * 2 * scale

rows = []
t = start
while t <= end:
    on = running(t)
    l = t.astimezone(IST); hour = l.hour + l.minute / 60
    cycle = math.sin(2 * math.pi * (hour - 8) / 10)
    drift = 12 * min(1, max(0, (t - (end - timedelta(hours=36))) / timedelta(hours=36)))
    vals = {
        'engine_running_status': (1 if on else 0, 'state'),
        'engine_load': (min(100, max(5, 58 + 12 * cycle + n(4))) if on else 0, '%'),
        'engine_oil_pressure': (390 + 15 * cycle + n(6) if on else abs(n(2)), 'kPa'),
        'hydraulic_oil_temperature': (62 + 5 * cycle + n(1.5) if on else 33 + 2 * math.sin(2 * math.pi * hour / 24) + n(0.6), 'degC'),
        'fuel_level': (min(98, max(5, 55 + 30 * math.sin(2 * math.pi * t.timestamp() / (3.2 * 86400)) + n(0.8))), '%'),
        'engine_coolant_temperature': ((84 + 3 * cycle + n(1.2) + drift) if on else 34 + 3 * math.sin(2 * math.pi * hour / 24) + n(0.8), 'degC'),
    }
    stamp = t.astimezone(IST).isoformat(timespec='seconds')
    for sensor, (v, unit) in vals.items():
        rows.append([stamp, sensor, f'{v:.2f}' if sensor != 'engine_running_status' else str(v), unit])
    t += STEP

with open(sys.argv[1], 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['timestamp', 'sensor', 'value', 'unit']); w.writerows(rows)
print(f'{len(rows)} rows, {start.isoformat()} .. {end.isoformat()}')
