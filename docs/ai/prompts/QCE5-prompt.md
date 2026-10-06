# QCE5 — comparison operators and `count_exceeding`

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/calc-engine-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/comparison-operators`

**Stream B.** Touches `src/catalog/formula/` and the evaluator's plan walk. `operator-registry.ts`
is a shared file — **append entries, never reorder**. Do not touch `template-schema.ts`,
`CLASS_CONTENT_INVENTORY` or `src/catalog-import/`.

Drafted from the register entry and QCE4's own finding, at the user's instruction, because no
prompt had been written. The register said "after the library is loaded"; the user chose not to
wait.

---

## 0. Why

QCE4 reported that the ITDC cross-sensor risk score does not compose. Summing z-scores works;
**"count how many exceed 2" does not** — the grammar has no comparison operator and no
boolean-to-number cast. `test/baseline-operators.spec.ts` test 8 records the gap.

## 1. Comparisons yield a dimensionless 0 or 1

```
comparison := expression [ ('>' | '>=' | '<' | '<=') expression ]
```

- Lowest precedence, below `+`/`-`. **Non-associative**: `a < b < c` is refused — it reads as a
  range and means something else.
- Allowed wherever an expression is: a function argument, inside parentheses, at the root.
- **A new plan node, `compare`**, not new `binary` ops. An evaluator older than this task must
  throw on a stored plan it does not understand, never fall through to division.
- **Units:** both sides carry the same unit, with the literal polymorphism `+`/`-` already have
  (`coolant_temp_c > 105` is fine; `coolant_temp_c > oil_pressure_kpa` is refused). The result is
  `dimensionless`. Kind is `series` if either side is.
- **No `==` or `!=`.** Equality between continuous measurements is a coincidence, and state
  codes are categorical signals — QCAT1's.
- Bump `COMPILER_VERSION`: the plan shape changes.

## 2. `count_exceeding(series, threshold)`

Readings in the window **strictly above** the threshold — the same `>` as §1. Dimensionless.
The threshold carries the series' unit or is a literal, as `fraction_within`'s bounds do.

**No readings is `no_readings`, not 0.** Zero exceedances of nothing is not evidence of anything.

## 3. What stays refused

`count(x > 2)` — `count` counts readings, so it would count every point, above 2 or not. A
comparison is refused as a reducer's series argument, naming `count_exceeding`. QCE4's test 8
keeps passing, now for a stated reason.

## 4. Runtime

- Scalar evaluation: compare the two sides' values, 1 or 0.
- Series evaluation: per bucket, `null` if either side is.
- **The risk score**: a plan whose every series input sits under a baseline operator is
  evaluated once, at the window's end, and returned as a one-point array — QCE2.1 §4's
  exception for a baseline root, extended to arithmetic and comparisons over baseline roots.
  Anything else outside the bucketable shapes still throws, naming the formula.

## 5. Tests

- `(zscore(a, 90d) > 2) + (zscore(b, 90d) > 2) + (zscore(c, 90d) > 2)` compiles, dimensionless.
- Mismatched units refused; `a < b < c` refused; `==` refused.
- `count_exceeding` executor: strictly above; empty window → `no_readings`.
- End to end: the risk score evaluates to a count; a series comparison buckets to 0/1/null.
- The executor/operator registries still match exactly.

## 6. Done when

`npm run build`, `npm test` and `npm run test:db` green, counts before and after on a worktree
off `origin/main`, naming the base SHA. No migration.
