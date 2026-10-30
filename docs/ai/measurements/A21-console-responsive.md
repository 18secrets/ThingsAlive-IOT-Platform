# A21 — console and responsive pass (test report, 29 Oct 2026)

Run 30 Oct 2026 on branch `fix/test-report-29oct`, against a local API on a fresh
`seed:demo` database (tenant `demo-construction`, EX-01..EX-06, sites PUNE-01/02).
The tester could not open devtools; this is the pass they logged as A21.

**Method.** Headless Chrome driven over the DevTools protocol: every client route
(28, including a machine's Care, Shield, Production, live and Machine pages and a Site
page) at 1440×900 and at 390×844 (mobile). For each, four seconds after navigation:
console `error` calls, uncaught exceptions, responses ≥ 400, failed requests, and
`document.documentElement.scrollWidth − innerWidth` (horizontal overflow).

**Result.** 56 page loads. No console errors, no uncaught exceptions, no horizontal
overflow at either width. One 4xx, by contract: ThingsCare detail asks
`GET …/rec-evidence`, which is 404 for a machine never evaluated (`api.ts`
`apiGetLatestRecEvidence`); the panel renders that as "not evaluated yet".

**Not covered.** Real devices and browser zoom levels; staff (master-admin) screens;
data shapes only Development has (83 machines, legacy-synced fleet).
