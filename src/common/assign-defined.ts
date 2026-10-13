/**
 * `draft` is a class-validator DTO: every optional field TypeScript declares is
 * defined as an own property (value `undefined`) at construction time, even when the
 * request body omitted it — an ordinary Object.assign would copy those `undefined`s
 * onto the entity and null out fields the caller never touched.
 *
 * Shared since dashboard testing found the same mistake in catalog authoring (issues
 * 7 and 8): on a fork from a published version the copied `undefined` reached an
 * INSERT as NULL, and on an alert template it renamed the class to "undefined"
 * before validation looked the signal up.
 */
export function assignDefined<T extends object>(target: T, draft: Partial<T>): T {
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) (target as unknown as Record<string, unknown>)[key] = value;
  }
  return target;
}
