/**
 * The arithmetic of the retrieval eval (QEVAL1 §3), apart from the database so the tests
 * can check it against numbers worked by hand.
 *
 * recall@8 is the shared contract's cut-off; reciprocal rank is taken over everything the
 * search returned (up to 30). A query that was scored and found nothing scores 0 — that
 * is a result. A query that could not be scored is excluded under its reason and is not
 * in any denominator: an absent library entry is not a retrieval miss.
 */
export const RECALL_CUTOFF = 8;

export interface QueryScore {
  expected: number;
  /** Rank of each expected entry in the results, or null when it was not returned. */
  ranks: (number | null)[];
  recallAt8: number;
  reciprocalRank: number;
  hitAt1: boolean;
}

export function scoreQuery(expectedIds: string[], rankedIds: string[]): QueryScore {
  const ranks = expectedIds.map((id) => {
    const i = rankedIds.indexOf(id);
    return i < 0 ? null : i + 1;
  });
  const found = ranks.filter((r): r is number => r !== null);
  const first = found.length ? Math.min(...found) : null;
  return {
    expected: expectedIds.length,
    ranks,
    recallAt8: found.filter((r) => r <= RECALL_CUTOFF).length / expectedIds.length,
    reciprocalRank: first === null ? 0 : 1 / first,
    hitAt1: first === 1,
  };
}

export interface Aggregate {
  /** Queries scored: the denominator of every mean below. */
  n: number;
  recallAt8: number | null;
  mrr: number | null;
  hitAt1: number | null;
  reason: string | null;
}

/** Means over the scored queries. Over none it is null with the reason, never 0. */
export function aggregate(scores: QueryScore[]): Aggregate {
  if (!scores.length) return { n: 0, recallAt8: null, mrr: null, hitAt1: null, reason: 'no_scored_queries' };
  const mean = (f: (s: QueryScore) => number) => round(scores.reduce((a, s) => a + f(s), 0) / scores.length);
  return {
    n: scores.length,
    recallAt8: mean((s) => s.recallAt8),
    mrr: mean((s) => s.reciprocalRank),
    hitAt1: mean((s) => (s.hitAt1 ? 1 : 0)),
    reason: null,
  };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
