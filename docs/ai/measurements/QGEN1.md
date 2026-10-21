# QGEN1 — what one historical replay costs

Measured 20 October 2026, for QGEN1 question 9 (the machine cap per proposal). Local
Postgres on an Apple M2 laptop, not Railway; the shape of the cost carries over, the
absolute numbers do not.

## Setup

- 25 machines (`REPLAY_MACHINE_CAP`, provisional), each with one bound signal and a daily
  eight-hour shift.
- One reading a minute through every shift for 90 days: 43,200 readings per machine,
  1,080,000 in all, across four monthly partitions.
- One threshold rule (6 of the last 10 readings above a bound), replayed through
  `ReplayService.replay` — the same read, windowing and `evaluateRule` the gate uses.
- Five runs per row; median and max.

## Results

| Replay | Median | Max | Telemetry rows read | Shift windows evaluated |
|---|---|---|---|---|
| 1 machine, 90 days | 180 ms | 252 ms | 43,200 | 90 |
| 25 machines, 90 days | 4.37 s | 8.02 s | 1,080,000 | 2,250 |

Cost is linear in rows read: about 4 µs per reading, almost all of it reading and
grouping, not evaluating. One read per machine for the whole 90 days, bound on both ends,
touches only the partitions inside the window (`artifact-proposal.spec.ts` test 14 checks
the plan rather than assuming it).

## What this means for the cap

The replay runs inside the request that proposes, so the cap is a latency decision as
much as a cost one. At one reading a minute, 25 machines is a several-second propose;
a machine reporting every ten seconds is six times the rows. Nothing is decided here —
`REPLAY_MACHINE_CAP` stays a provisional constant until Deepak names it.
