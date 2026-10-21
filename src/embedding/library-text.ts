import { createHash } from 'node:crypto';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClassRecommendation } from '../client-catalog/entities/client-equipment-class-recommendation.entity';

/**
 * How a library entry becomes the text that is embedded. Recorded on the profile as
 * `chunker_version` (the shared contract's name): a change here makes different vectors
 * from the same rows, so it is a new profile and a reindex, never an edit.
 */
export const CHUNKER_VERSION = 'library-entry@1';

export function failureModeText(fm: ClientEquipmentClassFailureMode): string {
  const signals = fm.signals?.length ? fm.signals.join(', ') : 'none named';
  return `Failure mode: ${fm.name} (${fm.code}). Equipment class: ${fm.clientEquipmentClassSlug}. `
    + `Symptom: ${fm.symptom || 'not described'}. Signals: ${signals}.`;
}

export function recommendationText(
  r: ClientEquipmentClassRecommendation, fm: ClientEquipmentClassFailureMode | undefined,
): string {
  const mode = fm ? `${fm.name} (${r.failureModeCode})` : r.failureModeCode;
  return `Recommended action for ${mode} on ${r.clientEquipmentClassSlug}: ${r.action}. Urgency: ${r.urgency}.`;
}

export const inputHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
