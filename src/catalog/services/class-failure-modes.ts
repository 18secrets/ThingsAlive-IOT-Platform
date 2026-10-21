import { EntityManager } from 'typeorm';
import { Severity } from '../../common/severity';
import { EquipmentClassFailureMode } from '../entities/equipment-class-failure-mode.entity';
import { FailureMode } from '../entities/equipment-class-profile.entity';
import {
  EquipmentClassRecommendation, RecommendationUrgency,
} from '../entities/equipment-class-recommendation.entity';

export interface FailureModeContent {
  code: string;
  name: string;
  symptom: string;
  severity: Severity | null;
  signals: string[];
}

export interface RecommendationContent {
  failureModeCode: string;
  action: string;
  urgency: RecommendationUrgency;
  estimatedHours: number | null;
  requiredParts: unknown[] | null;
}

type Provenance = { source: 'manual' | 'excel-import'; importBatchId: string | null };

/**
 * Failure modes and recommendations for one class version, read and written in one
 * place (task QREC0a).
 *
 * Four paths write class content — the importer, authoring, the seeder and
 * copy-on-grant's source read — and the jsonb this replaces was written by all four
 * through the profile row for free. Rows are not, so each path calling its own
 * repository code would be four chances to forget one table; this file is the one.
 */
export async function loadFailureModes(
  m: EntityManager, classSlug: string, classVersion: number,
): Promise<FailureModeContent[]> {
  const rows = await m.getRepository(EquipmentClassFailureMode).find({
    where: { classSlug, classVersion }, order: { code: 'ASC' },
  });
  return rows.map((r) => ({
    code: r.code, name: r.name, symptom: r.symptom, severity: r.severity, signals: r.signals,
  }));
}

export async function loadRecommendations(
  m: EntityManager, classSlug: string, classVersion: number,
): Promise<RecommendationContent[]> {
  const rows = await m.getRepository(EquipmentClassRecommendation).find({
    where: { classSlug, classVersion }, order: { failureModeCode: 'ASC', action: 'ASC' },
  });
  return rows.map((r) => ({
    failureModeCode: r.failureModeCode, action: r.action, urgency: r.urgency,
    estimatedHours: r.estimatedHours, requiredParts: r.requiredParts,
  }));
}

/** Under a version nothing has been written under before — insert only, failure
 * modes first, because the foreign key on a recommendation needs its target to exist. */
export async function insertClassContent(
  m: EntityManager, classSlug: string, classVersion: number,
  modes: FailureModeContent[], recommendations: RecommendationContent[], provenance: Provenance,
): Promise<void> {
  if (modes.length) {
    const repo = m.getRepository(EquipmentClassFailureMode);
    await repo.save(modes.map((f) => repo.create({ classSlug, classVersion, ...f, ...provenance })));
  }
  if (recommendations.length) {
    const repo = m.getRepository(EquipmentClassRecommendation);
    await repo.save(recommendations.map((r) => repo.create({ classSlug, classVersion, ...r, ...provenance })));
  }
}

/**
 * Makes a draft's failure modes exactly `modes`, keeping its recommendations.
 *
 * A failure mode that a recommendation still points at cannot be removed: the
 * foreign key would refuse it anyway, but with a constraint name instead of the two
 * things a person needs to know — which recommendation, and which failure mode.
 */
export async function replaceDraftFailureModes(
  m: EntityManager, classSlug: string, classVersion: number,
  raw: (FailureMode & { severity?: Severity | null })[], provenance: Provenance,
): Promise<void> {
  const modes = fromFailureModeJsonb(raw);
  const repo = m.getRepository(EquipmentClassFailureMode);
  const existing = await repo.find({ where: { classSlug, classVersion } });
  const wanted = new Map(modes.map((f) => [f.code, f]));
  const removed = existing.filter((r) => !wanted.has(r.code));

  if (removed.length) {
    const recs = await m.getRepository(EquipmentClassRecommendation).find({ where: { classSlug, classVersion } });
    const blocked = recs.filter((r) => removed.some((f) => f.code === r.failureModeCode));
    if (blocked.length) {
      throw new ClassContentError(
        `Cannot remove failure mode(s) from "${classSlug}" v${classVersion}: `
          + blocked.map((r) => `recommendation "${r.action}" points at failure mode "${r.failureModeCode}"`).join('; ')
          + '. Remove or repoint the recommendation first.',
      );
    }
    await repo.remove(removed);
  }

  const byCode = new Map(existing.map((r) => [r.code, r]));
  await repo.save(modes.map((f) => {
    const prior = byCode.get(f.code);
    return repo.create({
      ...(prior ?? { classSlug, classVersion, ...provenance }), ...f,
      // The authoring API speaks the jsonb shape, where severity is optional: an
      // edit that does not mention it keeps the one already there.
      severity: severityGiven(raw, f.code) ? f.severity : prior?.severity ?? null,
    });
  }));
}

/** Whether an edit in the jsonb shape actually said something about severity. */
export function severityGiven(raw: { code: string; severity?: unknown }[], code: string): boolean {
  const entry = raw.find((f) => f.code === code);
  return entry !== undefined && entry.severity !== undefined;
}

/** A fork carries everything the version it came from had — the jsonb did this for
 * free by riding on the profile row, and a row table only does it if asked. */
export async function copyClassContent(
  m: EntityManager, classSlug: string, fromVersion: number, toVersion: number,
): Promise<void> {
  const [modes, recommendations] = await Promise.all([
    loadFailureModes(m, classSlug, fromVersion),
    loadRecommendations(m, classSlug, fromVersion),
  ]);
  await insertClassContent(m, classSlug, toVersion, modes, recommendations, { source: 'manual', importBatchId: null });
}

/** The deprecated jsonb shape, still written so that QREC0c's drop has a way back. */
export function toFailureModeJsonb(modes: FailureModeContent[]): FailureMode[] {
  return modes.map((f) => ({ code: f.code, name: f.name, symptom: f.symptom, signals: f.signals }));
}

/** From the jsonb shape the authoring API and the seed files still speak. */
export function fromFailureModeJsonb(modes: (FailureMode & { severity?: Severity | null })[]): FailureModeContent[] {
  return modes.map((f) => ({
    code: f.code, name: f.name, symptom: f.symptom ?? '', severity: f.severity ?? null, signals: f.signals ?? [],
  }));
}

/** Content that references something absent is a defect, not a draft — the same rule
 * QREC0c will apply to visual anchors. One sentence per signal, naming it. */
export function undeclaredFailureModeSignals(
  modes: Pick<FailureModeContent, 'code' | 'signals'>[], declared: Iterable<string>,
): string[] {
  const known = new Set(declared);
  const problems: string[] = [];
  for (const f of modes) {
    for (const signal of f.signals) {
      if (!known.has(signal)) {
        problems.push(`failure mode "${f.code}" names signal "${signal}", which the class does not declare.`);
      }
    }
  }
  return problems;
}

export function danglingRecommendations(
  recommendations: Pick<RecommendationContent, 'failureModeCode' | 'action'>[],
  modes: Pick<FailureModeContent, 'code'>[],
): string[] {
  const codes = new Set(modes.map((f) => f.code));
  return recommendations
    .filter((r) => !codes.has(r.failureModeCode))
    .map((r) => `recommendation "${r.action}" names failure mode "${r.failureModeCode}", which this class version does not have.`);
}

export class ClassContentError extends Error {}
