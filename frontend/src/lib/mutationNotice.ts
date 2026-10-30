/**
 * Every create, update and delete says whether it worked (tester request, 26 Oct
 * 2026): a toast, green or red, top right. Raised once, in `authFetch`, rather than on
 * each of the ~160 calls that write — a screen added later gets it without anyone
 * remembering to. `api.ts` knows nothing of React, so it reports here and
 * `MutationToasts` (mounted once) shows it.
 */
export type MutationKind = "save" | "delete";

export type MutationNotice =
  | { ok: true; kind: MutationKind }
  | { ok: false; kind: MutationKind; message: string | null };

const listeners = new Set<(notice: MutationNotice) => void>();

export function onMutationNotice(listener: (notice: MutationNotice) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * POSTs that ask a question rather than change anything: a chat reply, a dry run, a
 * check, an analysis, or the first half of an upload whose second half is the save.
 * A green "saved" after each of those would teach people to ignore the green.
 */
const NOT_A_WRITE: RegExp[] = [
  /^\/assistant\/(chat|onboarding\/chat)$/,
  /\/upload-url$/,
  /^\/workflows\/assemble$/,
  /\/compile$/,
  /\/rec-evidence(\/|$)/,
  /^\/intelligence\/chains\/[^/]+\/project$/,
  /^\/fleet-import\/plan(\?|$)/,
  // A signed-in tab handing a new tab its session: nothing the person saved.
  /^\/auth\/fork$/,
];

/** What a request is, for a notice: null when it is a read, or a POST that writes nothing. */
export function mutationKind(path: string, method: string | undefined): MutationKind | null {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return null;
  if (NOT_A_WRITE.some((re) => re.test(path))) return null;
  return m === "DELETE" ? "delete" : "save";
}

export function reportMutation(notice: MutationNotice): void {
  for (const listener of listeners) listener(notice);
}
