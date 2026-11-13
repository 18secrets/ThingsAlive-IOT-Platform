#!/usr/bin/env node
/**
 * Fails when a list shown as a table has no list / card switch.
 *
 * Every list in the console offers both views (ViewModeToggle, and RecordCards or its own
 * cards for the second), so a phone can read it as cards and a desk as a table. Models
 * arrived in Administration with a table only (found 13 Nov 2026), beside tabs that all
 * had the switch; nothing compared it with them. This does: a component that draws a table
 * (ListTable, an rsuite Table or a plain <table>) uses ViewModeToggle, or is listed below
 * with the reason it is not a list.
 *
 * Read as text, not compiled, like check-encoding.js and check-page-grants.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'frontend', 'src');

/** Tables that are not a list page's list, and why. Paths from frontend/src. */
const NOT_A_LIST = {
  'components/equipment/LivePanel.tsx': 'one machine\'s live readings inside its page, not a list of records',
  'components/production/FleetFuelPanel.tsx': 'a shift-by-shift summary panel, not a list of records',
  'pages/FuelForecastAccuracyPage.tsx': 'a report table; the owner decided it needs no card view (13 Nov 2026)',
  'components/admin/SensorDetailModal.tsx': 'a table inside one sensor\'s detail modal',
  'pages/ThingsCareDetailPage.tsx': 'one machine\'s baselines, inside its detail page',
  'pages/ProductionMonitoringDetailPage.tsx': 'one machine\'s shifts, inside its detail page',
  // Rendered nowhere (no import). Listed so they do not hide a real one; delete them and
  // their lines go too.
  'components/users/UserManagement.tsx': 'not rendered anywhere',
  'components/onboarding/OnboardingList.tsx': 'not rendered anywhere',
  'components/devices/DeviceManagement.tsx': 'not rendered anywhere',
  // A real list without the switch: the alert agent's workflows, a plain <table>. Known
  // and not yet converted (13 Nov 2026); remove this line when it is.
  'components/views/AlertAgentView.tsx': 'KNOWN GAP: workflow list still a plain table',
};

const TABLE = /<ListTable\b|<Table[\s>]|<table[\s>]/;

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.tsx')) files.push(full);
  }
})(ROOT);

const problems = [];
const seen = new Set();
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  // ListTable's own file defines the table; it is not a list.
  if (rel === 'components/common/ListTable.tsx' || !TABLE.test(source)) continue;
  if (NOT_A_LIST[rel]) { seen.add(rel); continue; }
  if (!source.includes('ViewModeToggle')) {
    problems.push(`${rel} shows a table with no list / card switch. Add ViewModeToggle (useViewMode) and a card view `
      + '(RecordCards takes the same columns and cells), or list it in scripts/check-list-views.js with the reason it is not a list.');
  }
}
for (const rel of Object.keys(NOT_A_LIST)) {
  if (!seen.has(rel)) problems.push(`${rel} is listed in scripts/check-list-views.js but no longer draws a table (or is gone): remove its line.`);
}

if (problems.length) {
  console.error('List views: every list shown as a table also offers cards.\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const gaps = Object.entries(NOT_A_LIST).filter(([, why]) => why.startsWith('KNOWN GAP')).length;
console.log(`List views: every table list has the list / card switch${gaps ? ` (${gaps} known gap listed)` : ''}.`);
