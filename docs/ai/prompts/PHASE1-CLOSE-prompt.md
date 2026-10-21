# PHASE 1 CLOSE — stop expanding, ship it

QFIX-BASELINE is parked on its branch. Do not finish it. Do not apply the
fixture change, the reading floor, or the timing investigation.

1. Cut a small branch off main: fix/seed-calendar
   Take ONLY these two from fix/baseline-population:
     - the seeder deriving EX-03's breach and alert window from the shift
       calendar instead of the seed-run hour
     - npm run schema:inventory and docs/ai/schema-inventory.md
   Nothing else. No operatingIntervals, no coverage constant, no evaluator
   change, no fixture edits.

2. Verify: build, test:db before/after off origin/main naming the base SHA,
   lint, secrets scan. Chunk in the foreground.

3. Merge by hand to main, push once. Same procedure as the seven.

4. Confirm Railway builds. If the deployment is still WAITING, report what
   railway shows and stop — that one is Deepak's.

5. Once deployed: reset-if-present, then seed:demo against Development,
   SEED_DEMO_ENABLED=true inline only.

6. Report, and this is the phase 1 deliverable:
     - row counts per table
     - the six machines and exactly what a tester should see on each
     - every published class's content gaps (the library team's queue)
     - the measurement-role vs signal-key check

Then stop. No new tasks until manual testing has run.
