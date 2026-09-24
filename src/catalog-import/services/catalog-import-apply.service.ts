import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EquipmentClassFormula } from '../../catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { EquipmentClassSensorRequirement } from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { Sensor } from '../../device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../../device-catalog/entities/sensor-role-capability.entity';
import { CatalogImportBatch } from '../entities/catalog-import-batch.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import {
  buildProposedClass, classesIdentical, loadCurrentClass, str, strOrNull,
} from './class-content';

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

  async apply(batchId: string, appliedBy: string): Promise<ApplySummary> {
    return this.ds.transaction(async (m) => {
      const batchRepo = m.getRepository(CatalogImportBatch);
      const batch = await batchRepo.findOneOrFail({ where: { id: batchId } });
      if (batch.status !== 'validated') {
        throw new BadRequestException(`Batch is "${batch.status}"; only a validated batch can be applied.`);
      }

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

      const classSummaries: Record<string, ClassApplyResult> = {};
      for (const [slug, slugRows] of bySlug) {
        classSummaries[slug] = await this.applyClass(m, batch, slug, slugRows);
      }

      // sensor_capability: class-agnostic, resolved by sensor name alone. Not
      // versioned like a class, so re-applying an unchanged row has to be idempotent
      // by lookup rather than by never reaching this code — `uq_sensor_role_capability`
      // is a real unique index and a second insert would violate it outright.
      const capRepo = m.getRepository(SensorRoleCapability);
      let capabilitiesCreated = 0;
      for (const r of validRows.filter((r) => r.sheet === 'sensor_capability')) {
        const sensor = await m.getRepository(Sensor).findOneOrFail({
          where: { sensorName: str(r.payload.sensor_name) },
        });
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

  private async applyClass(
    m: EntityManager, batch: CatalogImportBatch, slug: string, rows: CatalogImportRow[],
  ): Promise<ClassApplyResult> {
    const classRepo = m.getRepository(EquipmentClassProfile);
    const reqRepo = m.getRepository(EquipmentClassSensorRequirement);
    const formulaRepo = m.getRepository(EquipmentClassFormula);

    const { current, content: currentContent } = await loadCurrentClass(m, slug);
    const proposed = buildProposedClass(rows, currentContent);
    const identical = current !== null && classesIdentical(proposed, currentContent);

    let targetClass: EquipmentClassProfile;
    let action: ClassApplyResult['action'];

    const classFields = {
      name: proposed.name, description: proposed.description, category: proposed.category,
      serviceIntervalHours: proposed.serviceIntervalHours,
      expectedSignals: proposed.expectedSignals, failureModes: proposed.failureModes,
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
          source: SOURCE, importBatchId: batch.id,
        })));
      }

      if (proposed.formulas.length) {
        await formulaRepo.save(proposed.formulas.map((f) => formulaRepo.create({
          classSlug: slug, classVersion: targetClass.version,
          formulaKey: f.formulaKey, kind: f.kind, expression: f.expression, inputs: f.inputs,
          outputUnit: f.outputUnit, basis: f.basis,
          references: Array.isArray(f.references) ? f.references : [],
          source: SOURCE, importBatchId: batch.id,
        })));
      }

      // The signal sheet is counted by logical entity, not by raw row: expected_signal
      // and default_threshold are written once per signal (proposed already dedupes
      // across component rows — see class-content.ts), while sensor_requirement is
      // one row per component.
      created.expected_signal = proposed.expectedSignals.length;
      created.failure_mode = bySheetCount('failure_mode');
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
