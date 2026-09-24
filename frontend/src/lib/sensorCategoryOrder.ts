// Sensor categories are ordered by how often each shows up when diagnosing
// equipment, not alphabetically — Engine/Transmission/Hydraulics/Electrical are
// the ones every operator checks first. Anything else falls back to
// alphabetical, after the pinned ones.
const CATEGORY_PRIORITY = ['Engine', 'Transmission', 'Hydraulics', 'Electrical'];

function categoryRank(name: string): number {
  const idx = CATEGORY_PRIORITY.indexOf(name);
  return idx === -1 ? CATEGORY_PRIORITY.length : idx;
}

export function compareByCategoryOrder(a: string, b: string): number {
  const ra = categoryRank(a);
  const rb = categoryRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/** Sorts by category priority first, then alphabetically within a category. */
export function sortByCategory<T>(items: T[], categoryOf: (item: T) => string, labelOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const byCategory = compareByCategoryOrder(categoryOf(a), categoryOf(b));
    return byCategory !== 0 ? byCategory : labelOf(a).localeCompare(labelOf(b));
  });
}
