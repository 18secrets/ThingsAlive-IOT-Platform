import { EquipmentClass } from './api';

/**
 * Which version of one class slug stands for it on a card or a detail page: the draft
 * in progress when it is newer than anything published, else the latest published
 * version, else the newest left. A draft older than the published version is never it.
 * One was left behind by a failed publish and a re-upload (tester bug TC_127) and,
 * shown, offered a Publish that would have retired the newer version. The database now
 * keeps a slug to one draft, but a page still decides by version, not by status alone.
 */
export function representativeOf(versions: EquipmentClass[]): EquipmentClass {
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  const published = newestFirst.find((v) => v.status === 'published');
  const draft = newestFirst.find((v) => v.status === 'draft');
  if (draft && (!published || draft.version > published.version)) return draft;
  return published ?? newestFirst[0];
}
