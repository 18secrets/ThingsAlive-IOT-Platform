import { retiredSignalProblems } from '../../device-catalog/services/sensor-retirement';
import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { compileClassFormulas, DeclaredSignal } from '../../catalog/formula/formula-compiler';
import { BindingError, checkRolesBound, formulaMode, FormulaMode, parseBindings } from '../../catalog/formula/named-formula-binding';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../../catalog/entities/named-formula.entity';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import { CRITICALITY_VALUES, ENABLES_VALUES, FORMULA_KIND_VALUES } from '../template-schema';
import { analyzeSensorCapability } from './sensor-review';

/**
 * Which column on a sheet carries its unit, wherever the sheet has one at all. Not
 * `requiredCell` in template-schema.ts — a blank unit is a legal shape (QIMP1), but a
 * unit-bearing value with no unit is a value nobody downstream can trust, which is a
 * semantic question for this slice, not a shape one.
 */
const UNIT_COLUMN_BY_SHEET: Record<string, string> = {
  signal: 'unit',
  sensor_capability: 'canonical_unit',
  formula: 'output_unit',
};

/** unit, required, description, min, max, severity — must agree across every row
 * sharing (class_slug, signal); component_scope, criticality, min_count, enables and
 * notes are legitimately different per component and are not checked here. */
const SIGNAL_AGREEMENT_FIELDS = ['unit', 'required', 'description', 'min', 'max', 'severity'] as const;

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const classSlugOf = (row: CatalogImportRow): string | undefined => {
  const v = row.sheet === 'equipment_class' ? row.payload.slug : row.payload.class_slug;
  return typeof v === 'string' && v ? v : undefined;
};

/** The natural key duplicate rows within one batch collide on, per sheet. */
function duplicateKey(row: CatalogImportRow): string | null {
  const p = row.payload;
  switch (row.sheet) {
    case 'equipment_class': return `${p.slug}`;
    case 'signal': return `${p.class_slug}::${p.signal}::${p.component_scope}`;
    case 'failure_mode': return `${p.class_slug}::${p.code}`;
    // Not sensor_capability (task QIMP5): a global sheet's own repeats are
    // identical-vs-conflicting, handled by analyzeSensorCapability, not this
    // generic "any repeat is a rejection" check.
    case 'formula': return `${p.class_slug}::${p.formula_key}`;
    default: return null;
  }
}

/**
 * Semantic validation, per row, on top of QIMP1's shape check (task QIMP2).
 *
 * As of template v3, the trigger `1757970000000-LibraryStructure.ts` runs at apply
 * time — a sensor_requirement role not declared in expected_signals — cannot be
 * reached from this path at all: `signal` is the one column that writes both, so
 * there is no row shape left that could disagree with itself. Every rule still here
 * is one the database would otherwise enforce anyway, caught earlier so the person
 * gets a row number and a sentence instead of a constraint name after the fact.
 *
 * A row already marked invalid by the parser keeps that message rather than
 * gaining a second, possibly contradictory one; later rules here only ever look at
 * rows still in shape-valid ('parsed') standing when they run.
 */
@Injectable()
export class CatalogImportValidatorService {
  constructor(private readonly ds: DataSource) {}

  async validate(batchId: string): Promise<void> {
    await this.ds.transaction(async (m) => {
      const rowRepo = m.getRepository(CatalogImportRow);
      // Re-runnable (task QIMP5): approving a proposed sensor re-validates the same
      // batch rather than asking for a re-upload, and a second call has to see every
      // row fresh, not just the ones still 'parsed' from the first call. A shape
      // rejection from the parser (QIMP1) is not reset — that row was never a
      // candidate for this pass either time.
      await rowRepo.update({ batchId, status: In(['valid', 'invalid']) }, { status: 'parsed', message: null });
      const rows = await rowRepo.find({ where: { batchId } });
      const candidates = rows.filter((r) => r.status === 'parsed');
      const live = (r: CatalogImportRow) => r.status === 'parsed';

      const invalidate = (row: CatalogImportRow, message: string): void => {
        row.status = 'invalid';
        row.message = message;
      };

      // ------------------------------------------------- duplicates within the batch
      const groups = new Map<string, CatalogImportRow[]>();
      for (const r of candidates) {
        const key = duplicateKey(r);
        if (!key) continue;
        const groupKey = `${r.sheet}::${key}`;
        const list = groups.get(groupKey) ?? [];
        list.push(r);
        groups.set(groupKey, list);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const rowNumbers = group.map((r) => r.rowNumber).sort((a, b) => a - b);
        for (const r of group) {
          invalidate(r, `${r.sheet}: duplicate within this batch (rows ${rowNumbers.join(', ')}).`);
        }
      }

      // ------------------------------------------------------------- class resolves
      const classSlugsInBatch = new Set(
        candidates.filter((r) => r.sheet === 'equipment_class' && live(r)).map((r) => String(r.payload.slug)),
      );
      const referencedSlugs = new Set<string>();
      for (const r of candidates) {
        const slug = classSlugOf(r);
        if (slug) referencedSlugs.add(slug);
      }
      const existingClasses = referencedSlugs.size
        ? await m.getRepository(EquipmentClassProfile).find({ where: { slug: In([...referencedSlugs]) } })
        : [];
      const existingBySlug = new Map<string, EquipmentClassProfile[]>();
      for (const c of existingClasses) {
        const list = existingBySlug.get(c.slug) ?? [];
        list.push(c);
        existingBySlug.set(c.slug, list);
      }
      const latestExisting = (slug: string) => {
        const versions = existingBySlug.get(slug);
        return versions?.length ? versions.reduce((a, b) => (b.version > a.version ? b : a)) : undefined;
      };

      for (const r of candidates) {
        if (!live(r) || r.sheet === 'equipment_class') continue;
        const slug = classSlugOf(r);
        if (!slug) continue;
        if (classSlugsInBatch.has(slug) || existingBySlug.has(slug)) continue;
        invalidate(
          r,
          `${r.sheet} row ${r.rowNumber}: class "${slug}" is not defined in this batch and does not exist in the catalog.`,
        );
      }

      // signal is the one column that both is the measurement role and names
      // expected_signals — a sensor_requirement row referencing a role never declared
      // as an expected_signal cannot arise from an import; that trigger now only ever
      // fires for `manual` catalog authoring, not this path.
      const expectedSignalsInBatch = new Map<string, Set<string>>();
      // Unit alongside the name — the compiler needs both to resolve a signal
      // reference at all (unresolved-unit and undeclared-signal are different
      // refusals; see formula-compiler.ts).
      const signalUnitsInBatch = new Map<string, Map<string, string | null>>();
      for (const r of candidates) {
        if (r.sheet !== 'signal' || !live(r)) continue;
        const slug = String(r.payload.class_slug);
        const signal = String(r.payload.signal);
        const set = expectedSignalsInBatch.get(slug) ?? new Set<string>();
        set.add(signal);
        expectedSignalsInBatch.set(slug, set);
        const units = signalUnitsInBatch.get(slug) ?? new Map<string, string | null>();
        units.set(signal, (r.payload.unit as string | undefined) || null);
        signalUnitsInBatch.set(slug, units);
      }
      const expectedSignalsFor = (slug: string): Set<string> => {
        const fromBatch = expectedSignalsInBatch.get(slug) ?? new Set<string>();
        const fromCatalog = latestExisting(slug)?.expectedSignals?.map((s) => s.signal) ?? [];
        return new Set([...fromBatch, ...fromCatalog]);
      };
      /** Batch declarations win over the catalog's existing ones for the same
       * name — they are the incoming truth for this upload. */
      const declaredSignalsFor = (slug: string): DeclaredSignal[] => {
        const merged = new Map<string, string | null>();
        for (const s of latestExisting(slug)?.expectedSignals ?? []) merged.set(s.signal, s.unit);
        for (const [signal, unit] of signalUnitsInBatch.get(slug) ?? []) merged.set(signal, unit);
        return [...merged.entries()].map(([signal, unit]) => ({ signal, unit }));
      };

      // ------------------------------------------------ signal-level agreement
      // unit, required, description, min, max and severity are declared once per
      // (class_slug, signal) even though a composite machine can stage several rows
      // for that signal (one per component_scope). Disagreement between those rows
      // names every row in the group — taking the first silently would make the
      // class's declared unit depend on row order.
      const signalGroups = new Map<string, CatalogImportRow[]>();
      for (const r of candidates) {
        if (r.sheet !== 'signal' || !live(r)) continue;
        const key = `${r.payload.class_slug}::${r.payload.signal}`;
        const list = signalGroups.get(key) ?? [];
        list.push(r);
        signalGroups.set(key, list);
      }
      const signature = (r: CatalogImportRow) =>
        SIGNAL_AGREEMENT_FIELDS.map((f) => JSON.stringify(r.payload[f] ?? null)).join('|');
      for (const group of signalGroups.values()) {
        if (group.length < 2) continue;
        if (new Set(group.map(signature)).size < 2) continue;
        const rowNumbers = group.map((r) => r.rowNumber).sort((a, b) => a - b);
        for (const r of group) {
          invalidate(
            r,
            `signal row ${r.rowNumber}: unit, required, description, min, max and severity must agree `
              + `across every row for class "${r.payload.class_slug}" signal "${r.payload.signal}" `
              + `(rows ${rowNumbers.join(', ')}).`,
          );
        }
      }

      // ------------------------------------------------------------------- enums
      for (const r of candidates) {
        if (!live(r)) continue;
        if (r.sheet === 'signal') {
          const criticality = r.payload.criticality;
          if (criticality && !CRITICALITY_VALUES.includes(criticality as string)) {
            invalidate(r, `signal row ${r.rowNumber}: "${criticality}" is not a valid criticality.`);
            continue;
          }
          const enables = (r.payload.enables as string[] | undefined) ?? [];
          const badEnables = enables.filter((e) => !ENABLES_VALUES.includes(e));
          if (badEnables.length) {
            invalidate(
              r,
              `signal row ${r.rowNumber}: "${badEnables.join('", "')}" `
                + `${badEnables.length > 1 ? 'are' : 'is'} not a recognised enables value.`,
            );
          }
        } else if (r.sheet === 'formula') {
          const kind = r.payload.kind;
          if (!FORMULA_KIND_VALUES.includes(kind as string)) {
            invalidate(r, `formula row ${r.rowNumber}: "${kind}" is not a valid kind.`);
          }
        }
      }

      // ------------------------------------------------- formula: bind mode (QCE3)
      // Three of the five structural codes §3 names — mode conflict/missing, and
      // naming a named formula that is not published or does not exist. The other
      // two (unknown_role, unbound_role) need the named formula resolved first, so
      // they are checked in the same pass once it has been. Dimension compatibility
      // and suspicious_binding are not here — both need the class's own resolved
      // signal units, known fully only at publish (CatalogAuthoringService.publishClass).
      // Runs before the units check below: mode has to be decided before "is
      // output_unit required" can be answered, and a mode failure must be this
      // row's own message, not overwritten by a later, less specific one.
      for (const r of candidates) {
        if (r.sheet !== 'formula' || !live(r)) continue;
        let mode: FormulaMode;
        try {
          mode = formulaMode({
            expression: String(r.payload.expression ?? ''),
            namedFormula: String(r.payload.named_formula ?? ''),
          });
        } catch (err) {
          const e = err as BindingError;
          invalidate(r, `formula row ${r.rowNumber}: ${e.message} (${e.code}).`);
          continue;
        }
        if (mode !== 'bind') continue;

        const slug = String(r.payload.named_formula);
        const versionRaw = r.payload.named_formula_version;
        const version = typeof versionRaw === 'string' && versionRaw.trim() ? Number(versionRaw) : undefined;
        const named = version !== undefined
          ? await m.getRepository(NamedFormula).findOne({ where: { slug, version, status: 'published' } })
          : await m.getRepository(NamedFormula).findOne({
            where: { slug, status: 'published' }, order: { version: 'DESC' },
          });
        if (!named) {
          invalidate(
            r,
            `formula row ${r.rowNumber}: named formula "${slug}"`
              + `${version !== undefined ? ` v${version}` : ''} is not published, or does not exist `
              + '(named_formula_not_found).',
          );
          continue;
        }

        const bindings = parseBindings(String(r.payload.bindings ?? ''));
        try {
          checkRolesBound(named.inputs, bindings);
        } catch (err) {
          const e = err as BindingError;
          invalidate(r, `formula row ${r.rowNumber}: ${e.message} (${e.code}).`);
        }
      }

      // ------------------------------------------------------------------- units
      for (const r of candidates) {
        if (!live(r)) continue;
        // A bind-mode formula row's unit comes from the named formula it binds,
        // resolved at class-publish time (task QCE3) — output_unit has nothing to
        // say here and is not required the way an expression-mode row's is.
        if (r.sheet === 'formula' && typeof r.payload.named_formula === 'string' && r.payload.named_formula.trim()) {
          continue;
        }
        const column = UNIT_COLUMN_BY_SHEET[r.sheet];
        if (!column) continue;
        const value = r.payload[column];
        if (typeof value === 'string' && value.trim() !== '') continue;
        invalidate(r, `${r.sheet} row ${r.rowNumber}: "${column}" is required.`);
      }

      // ------------------------------------------------------------ formula inputs
      // The real compiler (task QCE1), not a lighter check against the `inputs`
      // column: it parses `expression` itself and refuses anything it cannot prove
      // safe — an undeclared signal is one of many things it now catches, alongside
      // an unknown function, a unit mismatch, or a malformed expression. Dry run
      // only: nothing is written, and no declared result_kind/display_unit exists on
      // a workbook row to check against, so those two checks apply at publish only
      // (see CatalogAuthoringService.publishClass), not here.
      //
      // Compiled one class at a time, not row by row (task QCE1.1), so
      // `#other_formula_key` resolves against the other formula rows in this same
      // batch. Its siblings are the batch's own rows for that class, never the
      // catalog's existing formulas: a batch that supplies any formula rows for a
      // class replaces that class's formulas wholesale at apply time (see
      // catalog-import-apply.service.ts), so an existing-catalog formula would not
      // actually be present in the version this batch proposes.
      // Bind-mode rows (task QCE3) are excluded here — their real expression is
      // not known until a signal stands in for each role, which the next block
      // resolves. Compiling a blank `expression` here would refuse every bind-mode
      // row as "the expression is empty", which is not what is wrong with it.
      const formulaRowsByClass = new Map<string, CatalogImportRow[]>();
      for (const r of candidates) {
        if (r.sheet !== 'formula' || !live(r)) continue;
        if (typeof r.payload.named_formula === 'string' && r.payload.named_formula.trim()) continue;
        const slug = String(r.payload.class_slug);
        const list = formulaRowsByClass.get(slug) ?? [];
        list.push(r);
        formulaRowsByClass.set(slug, list);
      }
      for (const [slug, formulaRows] of formulaRowsByClass) {
        const results = compileClassFormulas({
          classSlug: slug,
          expectedSignals: declaredSignalsFor(slug),
          formulas: formulaRows.map((r) => ({
            formulaKey: String(r.payload.formula_key ?? ''),
            expression: String(r.payload.expression ?? ''),
          })),
        });
        for (const r of formulaRows) {
          const key = String(r.payload.formula_key ?? '');
          const result = results.get(key);
          if (result?.status === 'error') {
            invalidate(r, `formula row ${r.rowNumber}: ${result.error.message}`);
          }
        }
      }

      // -------------------------------------------------------- sensor_capability
      // Task QIMP5: identical-vs-conflicting and not-found-vs-ambiguous, resolved by
      // slug then name, in one shared pass — see sensor-review.ts for why the old
      // single check (name-only, one message for two different failures) is gone.
      const capabilityRows = candidates.filter((r) => r.sheet === 'sensor_capability' && live(r));
      const signalRowsForUsage = rows.filter((r) => r.sheet === 'signal');
      if (capabilityRows.length) {
        const analysis = await analyzeSensorCapability(m, capabilityRows, signalRowsForUsage);
        for (const res of analysis.resolutions) {
          if (res.status !== 'ok') {
            invalidate(res.row, res.message!);
            if (res.status === 'retired') {
              for (const signalRow of signalRowsForUsage) {
                if (signalRow.payload.signal === res.row.payload.signal) invalidate(signalRow, res.message!);
              }
            }
          }
          // 'ok' rows — including every row in an identical-duplicate group — are
          // left 'parsed' and fall through to 'valid' below, same as any other row.
        }
      }

      for (const r of candidates.filter((r) => r.sheet === 'signal' && live(r))) {
        const problems = await retiredSignalProblems(m, [{
          signal: String(r.payload.signal ?? ''), unit: String(r.payload.unit ?? ''),
        }]);
        if (problems.length) invalidate(r, problems.join(' '));
      }

      // ---------------------------------------------------------- threshold bounds
      // Both min and max blank means this signal has no threshold — not a rejection;
      // only a row that supplies one gets its bounds checked. Severity describes a
      // threshold, though, not a signal on its own: a severity with neither bound is
      // a half-filled row that would silently produce no threshold at all.
      for (const r of candidates) {
        if (r.sheet !== 'signal' || !live(r)) continue;
        const min = parseNumber(r.payload.min);
        const max = parseNumber(r.payload.max);
        if (min === undefined && max === undefined) {
          const severity = r.payload.severity;
          if (typeof severity === 'string' && severity.trim() !== '') {
            invalidate(r, `signal row ${r.rowNumber}: "severity" is set but neither "min" nor "max" is.`);
          }
          continue;
        }
        if (min !== undefined && max !== undefined && min >= max) {
          invalidate(r, `signal row ${r.rowNumber}: min (${min}) must be below max (${max}).`);
        }
      }

      // Anything still 'parsed' survived every rule above — shape-checked at parse
      // time (QIMP1) and now semantically checked too, which 'valid' is for.
      for (const r of candidates) {
        if (r.status === 'parsed') r.status = 'valid';
      }

      await rowRepo.save(rows);
      await m.getRepository(CatalogImportBatch).update(batchId, { status: 'validated' });
    });
  }
}
