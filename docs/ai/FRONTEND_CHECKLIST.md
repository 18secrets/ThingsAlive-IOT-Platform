# Frontend change checklist

Every change under `frontend/` is done only when it passes all of this, whoever makes it.
A screen that works in English, light mode, on a laptop is a third of the job: the
console is used in five languages, on phones and in dark mode, at four text sizes.

Each rule below exists because something reached `main` without it (dates are when it
was found). Check the item; do not argue it away.

## 1. Language: all five, every time

Languages: `en`, `hi`, `ta`, `te`, `or`. Files: `frontend/public/locales/<lang>/<namespace>.json`.

- [ ] Every new text is a key in the namespace's file, **in all five languages**, in the
      same change. A `t('key', { defaultValue: 'English' })` with no file entry shows
      English to every Hindi, Tamil, Telugu and Odia reader. (Site twin: 51 labels, 3 Nov.
      Fuel accuracy page: 47, 3 Nov. Geofence map: 77, since 29 Oct.)
- [ ] English in the file is the same words as the `defaultValue` in the code. Change one,
      change the other.
- [ ] No English typed straight into JSX, a `title=`, an `aria-label`, a `placeholder`, a
      chart label, a toast, or a 3-D/canvas label. All go through `t()`.
- [ ] One key, one meaning. Never reuse a key for a different text: with a file entry,
      both places show the same words. (`siteTwin.place` was a picker label and a button, 3 Nov.)
- [ ] Counts use plural keys: `name_one` and `name_other` in every language, called with
      `{ count }`.
- [ ] Every translation keeps the English `{{placeholders}}`, exactly. A dropped
      `{{count}}` drops the number from the sentence.
- [ ] A text that names another part of the screen ("under Shift schedule") quotes that
      part's own translated label in each language, not a fresh translation of it.
- [ ] Data is not translated: machine, site, zone and class names stay as entered.
- [ ] Check: no key is missing in any language (script in "How to check" below).

## 2. Screen sizes

Check at **390 px** (phone), **768 px** (tablet) and **1440 px** (desktop).

- [ ] No sideways scroll on the page at any width. A wide table scrolls inside its own box.
- [ ] Button rows and toolbars wrap (`flex-wrap`) instead of pushing buttons off screen.
- [ ] Grids drop columns as the screen narrows (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`).
- [ ] Fixed widths only from `sm:` up (`w-full sm:w-64`); on a phone a picker is full width.
- [ ] Long text truncates or wraps on purpose (`truncate`, `min-w-0`, `break-words`), never
      overlapping its neighbour.
- [ ] The header keeps the page title readable on a phone; extra controls hide below `sm`
      (`hidden sm:block`) and live somewhere else too (e.g. Settings).
- [ ] Popups (Modal) fit a phone: content scrolls inside, buttons stay reachable.

## 3. Light and dark theme

- [ ] Every colour has its dark pair: `bg-white dark:bg-slate-900`,
      `border-slate-200 dark:border-slate-800`, `text-slate-800 dark:text-slate-100`, and so on.
- [ ] Muted text is `text-slate-500` (or the darkened `slate-400` in light mode), never
      lighter. Light grey was unreadable (team feedback, 3 Nov).
- [ ] No hard-coded hex for text or backgrounds outside a chart or 3-D scene; chips use
      `Chip` tones and status colours come from `statusTone` / `severityTone`.
- [ ] Check every changed screen once in dark mode.

## 4. Text size (Small / Default / Large / X-Large)

The reader picks a text size; it is the root font size, so everything in `rem` follows.

- [ ] Sizes in `rem` or Tailwind's scale only: `text-xs`, `text-[0.6875rem]`. **No
      `text-[11px]`**, no `fontSize: 11` in inline styles, chart options or 3-D labels.
- [ ] Check the screen at X-Large (125 %) on a phone: nothing overflows or overlaps.

## 5. Alignment and layout: compare with the pages beside it

Before building, open the nearest existing page of the same kind and match it.

- [ ] **Lists** use the shared pieces, as every list page does: `LIST_PANEL` box,
      `ViewModeToggle` (list view by default, not remembered), `SortSelect`,
      `ListTable` / `RecordCards`, `TablePagination` with `usePagination(items)`
      (10 per page; 10 / 20 / 50 / 100), `pinToBottom`. The switch and sort sit before the
      page's buttons.
- [ ] **Every list shown as a table also has the card view**, including a new
      Administration tab beside ones that have it: Models arrived with a table only
      (13 Nov 2026). `RecordCards` takes the same `columns` and `cells` as `ListTable`, so
      the card view is a few lines. `npm run lint` (`scripts/check-list-views.js`) fails
      on a table without `ViewModeToggle`, unless that script lists it with the reason it
      is not a list (a panel inside a machine's page, a modal, a report table).
- [ ] **Page top**: a heading-only banner, then one card holding the main data and links
      (Machine summary, Production detail, ThingsCare follow this).
- [ ] **Panels with lists** use `PanelRow` / `PanelRows`: title on one line, detail on the
      second, chip or time on the right.
- [ ] **Cards**: `bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800
      rounded-xl p-4 shadow-xs`. Section labels: `text-xs font-semibold uppercase
      tracking-wide text-slate-500`.
- [ ] **Tables (`ListTable`) are sized to their content**, never equal columns by default
      (Scenarios, Live Predictions, Alerts, AI Onboarding all had it, 12 Nov):
      - a toggle, a count, a chip, a time or a set of buttons gets a fixed `width`;
      - the text columns share the rest with `grow` (more for the longest: details,
        summary, needs) and a `minWidth`;
      - Actions is the last column, narrow and `align: 'right'`; its buttons sit right
        (`justify-end`) and wrap whole (`whitespace-nowrap` on each), never mid-word;
      - Edit in a table is the pencil (`Edit2`, the Models button style) with the word as
        its `title` and `aria-label`, not the word "Edit";
      - chips in a narrow column wrap their text instead of being cut off; a cell never
        sets its own `min-w-[…]` wider than its column.
- [ ] **Controls on one row are one height** (`h-8` beside rsuite `size="sm"`), and a
      picker keeps one width whatever is selected: give it `FILTER_PICKER`
      (`lib/filterPicker.ts`) with its width, so a long choice ends in "…" instead of running
      over the next control and a short one leaves no gap (TC_187, 12 Nov). Filters line up
      from the left.
- [ ] Gaps stay constant whatever the content; nothing shifts when a value or label changes.
- [ ] Cards in a row keep their own height; do not stretch them to match (team decision).
- [ ] Each value appears once on a screen; no duplicated figures or headings.
- [ ] Filters: `EquipmentFilters` with its popup; one search, not two.

## 6. States, access and data

- [ ] Loading, empty, error and "not available for your role" each have their own words;
      none shows a raw code, `undefined`, or a wrong zero while data loads.
- [ ] A button the user cannot use is hidden (or disabled with the reason), not shown to
      fail. Pages a role cannot open are not in its sidebar (`pageAccess`).
- [ ] **A new page, or a new Administration tab, is on the Roles page** so the account's
      owner decides who sees it. Never let it ride on another page's grant: the geofence
      map rode on Dashboard, and Models, Service roster and Fuel forecast on
      Administration, so nobody could give one without the other (13 Nov 2026). Add it to
      `CLIENT_ASSIGNABLE_TABS` (or `CLIENT_ADMIN_SUBTABS`) in `frontend/src/types.ts`, to
      `TENANT_ASSIGNABLE_PAGES` in `src/identity/pages.ts`, a `case` in `pageAccess.ts`,
      its label in `RoleManagement.tsx`, and a migration that grants it to the roles that
      can open it today (`1765100000000-SeparateRolePages` is the pattern). `npm run lint`
      (`scripts/check-page-grants.js`) fails until it is on both sides, or listed there
      with the reason it is not a granted page.
- [ ] Destructive actions confirm; actions that need a reason refuse an empty one.
- [ ] A figure says its source and unit when it could be read two ways.

## How to check

Run all of these before saying the change is done:

1. `cd frontend && npm run build` and `npm run lint` at the root (type check + encoding).
2. Missing keys, from `frontend/`:

   ```
   node -e 'const fs=require("fs");const f=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v,p+k+"."):[p+k]);const b=k=>k.replace(/_(one|other)$/,"");for(const n of fs.readdirSync("public/locales/en")){const en=new Set(f(require("./public/locales/en/"+n)).map(b));for(const l of ["hi","ta","te","or"]){const o=new Set(f(require(`./public/locales/${l}/`+n)).map(b));const m=[...en].filter(k=>!o.has(k));if(m.length)console.log(l,n,m.length,m.slice(0,10).join(", "))}}'
   ```

   Nothing printed = nothing missing.
3. Open every changed screen in a browser (Playwright, or by hand) with a throwaway user,
   deleted afterwards:
   - 1440 px and 390 px, light and dark;
   - Hindi (`localStorage.i18nextLng = 'hi'`): no English left except data;
   - X-Large text size;
   - no page errors in the console, no sideways scroll (`main.scrollWidth <= main.clientWidth`).
4. Put the old and new screen side by side with its neighbour page and look at the
   alignment, not only at whether it works.
5. Every table on a changed screen, at 1440 px and 768 px, in English and Tamil (the
   longest labels), run in the page:

   ```
   [...document.querySelectorAll('.rs-table')].map(t=>({row:t.querySelector('.rs-table-body-row-wrapper .rs-table-row')?.scrollWidth,box:t.clientWidth,cut:[...t.querySelectorAll('.rs-table-cell-content')].filter(c=>c.scrollWidth>c.clientWidth+1).length}))
   ```

   `row` equal to `box` and `cut: 0`: it fits and nothing is cut off. A table of seven or
   more columns may scroll inside its box at 768 px; nothing in it may be cut off.
