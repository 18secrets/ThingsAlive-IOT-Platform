import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentClassFormula } from '../../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { SensorRoleCapability } from '../../device-catalog/entities/sensor-role-capability.entity';
import {
  danglingRecommendations, insertClassContent, toFailureModeJsonb,
} from '../../catalog/services/class-failure-modes';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import {
  ClassDiffWarning, buildProposedClass, classesIdentical, computeClassDiffEntry, loadCurrentClass, str, strOrNull,
} from './class-content';
import { EMPTY_SENSOR_CAPABILITY_ANALYSIS, analyzeSensorCapability } from './sensor-review';

const SOURCE = 'excel-import' as const;

export interface ClassApplyResult {
  action: 'create' | 'new_version' | 'unchanged';
  version: number;
  created: Record<string, number>;
}

export interface ApplySummary {
  classes: Record<string, ClassApplyResult>;
  sensorCapabilities: { created: number; skipped: number };
}

const classSlugOf = (row: CatalogImportRow): string | undefined => {
  const v = row.sheet === 'equipment_class' ? row.payload.slug : row.payload.class_slug;
  return typeof v === 'string' && v ? v : undefined;
};

/**
 * Apply, versioned and provenanced (task QIMP3).
 *
 * One transaction for the whole batch — everything below runs inside
 * `this.ds.transaction`, so a failure anywhere (a real constraint the database
 * refuses, not just a caught exception) leaves every table exactly as it was.
 */
@Injectable()
export class CatalogImportApplyService {
  constructor(private readonly ds: DataSource) {}

  async apply(batchId: string, appliedBy: string, acknowledgeWarnings = false): Promise<ApplySummary> {
    return this.ds.transaction(async (m) => {
      // Locked for the rest of this transaction, not just read: two overlapping
      // applies against the same batch would otherwise both pass the status check
      // below before either commits — under READ COMMITTED, a statement inside an
      // already-open transaction still sees whatever the *other* transaction has
      // committed by the time that statement runs, not a snapshot frozen at BEGIN.
      // A batch applied a moment apart rather than at the same instant is exactly
      // how `ex-1200v` got a v1 and a v2 from one batch: the second call's own
      // "is this validated" check passed against the pre-commit state, and by the
      // time it read the class's current version, the first call had already
      // written v1 and committed. The lock forces the second caller to wait for the
      // first to finish and then read its result, not race it.
      const batch = await m.getRepository(CatalogImportBatch)
        .createQueryBuilder('batch')
        .setLock('pessimistic_write')
        .where('batch.id = :batchId', { batchId })
        .getOne();
      if (!batch) throw new NotFoundException(`No import batch "${batchId}".`);
      if (batch.status !== 'validated') {
        throw new BadRequestException(`Batch is "${batch.status}"; only a validated batch can be applied.`);
      }

      const batchRepo = m.getRepository(CatalogImportBatch);
      const rowRepo = m.getRepository(CatalogImportRow);
      const rows = await rowRepo.find({ where: { batchId } });
      const validRows = rows.filter((r) => r.status === 'valid');
      const invalidRows = rows.filter((r) => r.status === 'invalid');

      const bySlug = new Map<string, CatalogImportRow[]>();
      for (const r of validRows) {
        if (r.sheet === 'sensor_capability') continue;
        const slug = classSlugOf(r);
        if (!slug) continue;
        const list = bySlug.get(slug) ?? [];
        list.push(r);
        bySlug.set(slug, list);
      }

      // The same computation the dry-run diff shows, so apply cannot refuse on a
      // warning the diff never mentioned or write past one it did (task QIMP4).
      // Checked before anything is written — a refusal that happened after half the
      // batch was already applied would be the partial-write problem this whole
      // service exists to avoid.
      if (!acknowledgeWarnings) {
        const problems: string[] = [];
        for (const [slug, slugRows] of bySlug) {
          const allForClass = rows.filter((r) => classSlugOf(r) === slug);
          const { current, content: currentContent } = await loadCurrentClass(m, slug);
          const entry = await computeClassDiffEntry(
            m, slug, allForClass, slugRows, current, currentContent, 'create',
          );
          if (entry.warnings.length) {
            problems.push(this.describeWarnings(slug, entry.warnings, entry));
          }
        }
        if (problems.length) {
          throw new BadRequestException(
            `Refused: ${problems.join(' ')} Pass acknowledgeWarnings: true to apply anyway.`,
          );
        }
      }

      // A proposed sensor or category neither approved nor dismissed blocks apply
      // outright, acknowledgeWarnings or not (task QIMP5) — that flag is for content
      // this batch would write; an outstanding proposal is content it cannot write
      // yet, because the reference row it depends on does not exist.
      const capabilityRowsAll = rows.filter((r) => r.sheet === 'sensor_capability');
      const signalRowsAll = rows.filter((r) => r.sheet === 'signal');
      const sensorAnalysis = capabilityRowsAll.length
        ? await analyzeSensorCapability(m, capabilityRowsAll, signalRowsAll)
        : EMPTY_SENSOR_CAPABILITY_ANALYSIS;
      const decided = new Set(batch.sensorDecisions.map((d) => `${d.kind}::${d.slug}`));
      const outstandingSensors = sensorAnalysis.proposedSensors.filter((p) => !decided.has(`sensor::${p.slug}`));
      if (outstandingSensors.length) {
        const classes = [...new Set(outstandingSensors.flatMap((p) => p.usedByClasses))].sort();
        throw new BadRequestException(
          `Refused: ${outstandingSensors.length} proposed sensor(s) are neither approved nor dismissed `
            + `(affects: ${classes.join(', ') || 'no class yet'}). `
            + 'Approve or dismiss them via POST .../sensors first.',
        );
      }

      const classSummaries: Record<string, ClassApplyResult> = {};
      for (const [slug, slugRows] of bySlug) {
        classSummaries[slug] = await this.applyClass(m, batch, slug, slugRows);
      }

      // sensor_capability: class-agnostic, resolved by slug then name (task QIMP5).
      // Not versioned like a class, so re-applying an unchanged row has to be
      // idempotent by lookup rather than by never reaching this code —
      // `uq_sensor_role_capability` is a real unique index and a second insert
      // would violate it outright. Every row here already resolved 'ok' at the last
      // validate() — a row that did not would still be 'invalid', not 'valid'.
      const resolvedSensorByRowId = new Map(
        sensorAnalysis.resolutions.filter((res) => res.status === 'ok').map((res) => [res.row.id, res.candidateSensor!]),
      );
      const capRepo = m.getRepository(SensorRoleCapability);
      let capabilitiesCreated = 0;
      for (const r of validRows.filter((r) => r.sheet === 'sensor_capability')) {
        const sensor = resolvedSensorByRowId.get(r.id);
        if (!sensor) throw new Error(`sensor_capability row ${r.rowNumber} was valid but did not resolve a sensor.`);
        const measurementRole = str(r.payload.signal);
        const parameterKey = strOrNull(r.payload.parameter_key);
        const existingCap = await capRepo.findOne({ where: { sensorId: sensor.id, measurementRole, parameterKey } });
        if (existingCap) {
          r.status = 'applied';
          r.targetRef = existingCap.id;
          continue;
        }
        const saved = await capRepo.save(capRepo.create({
          sensorId: sensor.id, measurementRole, parameterKey,
          canonicalUnit: strOrNull(r.payload.canonical_unit),
          source: SOURCE, importBatchId: batch.id,
        }));
        r.status = 'applied';
        r.targetRef = saved.id;
        capabilitiesCreated += 1;
      }

      // Rows marked invalid are skipped and recorded as skipped, not silently dropped.
      for (const r of invalidRows) r.status = 'skipped';
      await rowRepo.save(rows);

      const summary: ApplySummary = {
        classes: classSummaries,
        sensorCapabilities: {
          created: capabilitiesCreated,
          skipped: invalidRows.filter((r) => r.sheet === 'sensor_capability').length,
        },
      };

      batch.status = 'applied';
      batch.appliedAt = new Date();
      batch.appliedBy = appliedBy;
      batch.summary = summary as unknown as Record<string, unknown>;
      await batchRepo.save(batch);

      return summary;
    });
  }

  /** One sentence per warning, naming the class and the counts — not a generic
   * "some content will be lost", which reads identically for every batch this
   * ever fires on. */
  private describeWarnings(
    slug: string, warnings: ClassDiffWarning[],
    entry: { signalsInWorkbook: number; signalsToApply: number; previousPublishedVersion: { version: number; signalCount: number; failureModeCount: number } | null },
  ): string {
    const parts: string[] = [];
    if (warnings.includes('incomplete_class')) {
      parts.push(
        `"${slug}": the workbook asked for ${entry.signalsInWorkbook} signal(s) but only `
          + `${entry.signalsToApply} would be written (incomplete_class).`,
      );
    }
    if (warnings.includes('content_regression') && entry.previousPublishedVersion) {
      parts.push(
        `"${slug}": published v${entry.previousPublishedVersion.version} has `
          + `${entry.previousPublishedVersion.signalCount} signal(s) and `
          + `${entry.previousPublishedVersion.failureModeCount} failure mode(s); this batch would write fewer `
          + '(content_regression).',
      );
    }
    return parts.join(' ');
  }

  private async applyClass(
    m: EntityManager, batch: CatalogImportBatch, slug: string, rows: CatalogImportRow[],
  ): Promise<ClassApplyResult> {
    const classRepo = m.getRepository(EquipmentClassProfile);
    const reqRepo = m.getRepository(EquipmentClassSensorRequirement);
    const formulaRepo = m.getRepository(EquipmentClassFormula);

    const { current, content: currentContent } = await loadCurrentClass(m, slug);
    const proposed = buildProposedClass(rows, currentContent);
    const identical = current !== null && classesIdentical(proposed, currentContent);

    // A recommendation row naming a missing failure mode is already invalid at
    // validate. This is the other way to get there: a batch that replaces the
    // failure modes and inherits recommendations pointing at a code it dropped. The
    // foreign key would refuse it mid-apply with a constraint name; this refuses it
    // first, naming both, and nothing is written.
    const dangling = danglingRecommendations(proposed.recommendations, proposed.failureModes);
    if (!identical && dangling.length) {
      throw new BadRequestException(`Refused: "${slug}": ${dangling.join(' ')}`);
    }

    let targetClass: EquipmentClassProfile;
    let action: ClassApplyResult['action'];

    const classFields = {
      name: proposed.name, description: proposed.description, category: proposed.category,
      serviceIntervalHours: proposed.serviceIntervalHours,
      // Deprecated jsonb, still written (task QREC0a) — the rows below are what is read.
      expectedSignals: proposed.expectedSignals, failureModes: toFailureModeJsonb(proposed.failureModes),
      defaultThresholds: proposed.defaultThresholds,
      source: SOURCE, importBatchId: batch.id,
    };

    if (identical) {
      // Content that would be written is byte-identical to what the current version
      // already holds — no new version, and the current one is never touched.
      targetClass = current!;
      action = 'unchanged';
    } else if (!current) {
      targetClass = await classRepo.save(classRepo.create({
        slug, version: 1, status: 'draft', publishedAt: null, ...classFields,
      }));
      action = 'create';
    } else {
      // A published version is never mutated, and — deliberately, not just for that
      // reason — neither is an existing draft: `ta_app` has no DELETE grant on
      // equipment_class_sensor_requirement or equipment_class_formula
      // (1757970000000-LibraryStructure.ts grants only SELECT/INSERT/UPDATE), so
      // reusing a version would mean updating rows in place with no way to remove
      // one the new content dropped. Always minting a fresh version number instead
      // needs no delete at all: nothing has ever been written under it before.
      targetClass = await classRepo.save(classRepo.create({
        slug, version: current.version + 1, status: 'draft', publishedAt: null, ...classFields,
      }));
      action = 'new_version';
    }

    const created: Record<string, number> = {};

    if (!identical) {
      const bySheetCount = (sheet: string) => rows.filter((r) => r.sheet === sheet).length;

      // Requirements and formulas live under one specific class_version, and this is
      // always a version nothing has been written under before (see above) — so this
      // is purely additive, not a delete-and-replace.
      if (proposed.sensorRequirements.length) {
        await reqRepo.save(proposed.sensorRequirements.map((r) => reqRepo.create({
          classSlug: slug, classVersion: targetClass.version,
          measurementRole: r.measurementRole, componentScope: r.componentScope, criticality: r.criticality,
          minCount: r.minCount, canonicalUnit: r.canonicalUnit, enables: r.enables, notes: r.notes,
          staleAfterSeconds: r.staleAfterSeconds, forecastEnabled: r.forecastEnabled,
          forecastHorizonHours: r.forecastHorizonHours,
          source: SOURCE, importBatchId: batch.id,
        })));
      }

      await insertClassContent(
        m, slug, targetClass.version, proposed.failureModes, proposed.recommendations,
        { source: SOURCE, importBatchId: batch.id },
      );

      if (proposed.formulas.length) {
        await formulaRepo.save(proposed.formulas.map((f) => formulaRepo.create({
          classSlug: slug, classVersion: targetClass.version,
          formulaKey: f.formulaKey, kind: f.kind, expression: f.expression, inputs: f.inputs,
          outputUnit: f.outputUnit, basis: f.basis,
          references: Array.isArray(f.references) ? f.references : [],
          // Bind mode (task QCE3): written through as data, same as any other
          // field. Substitution and compilation happen at publish, not here — a
          // bind-mode row is as uncompiled at apply as an expression-mode one.
          namedFormulaSlug: f.namedFormulaSlug, namedFormulaVersion: f.namedFormulaVersion, bindings: f.bindings,
          displayUnit: f.displayUnit, targetValue: f.targetValue, targetMin: f.targetMin, targetMax: f.targetMax,
          targetDirection: f.targetDirection, comparisonBasis: f.comparisonBasis,
          aggregationWindow: f.aggregationWindow, chartType: f.chartType,
          source: SOURCE, importBatchId: batch.id,
        })));
      }

      // The signal sheet is counted by logical entity, not by raw row: expected_signal
      // and default_threshold are written once per signal (proposed already dedupes
      // across component rows — see class-content.ts), while sensor_requirement is
      // one row per component.
      created.expected_signal = proposed.expectedSignals.length;
      created.failure_mode = bySheetCount('failure_mode');
      // Only present when the batch carried the sheet — a v3 batch's summary keeps
      // exactly the keys it always had.
      if (bySheetCount('recommendation')) created.recommendation = bySheetCount('recommendation');
      created.sensor_requirement = proposed.sensorRequirements.length;
      created.default_threshold = Object.keys(proposed.defaultThresholds).length;
      created.formula = bySheetCount('formula');
    }

    for (const r of rows) {
      r.status = 'applied';
      r.targetRef = targetClass.id;
    }

    return { action, version: targetClass.version, created };
  }
}
