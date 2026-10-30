import type { Prediction, PredictionSeverity } from './api';

const SEVERITY_RANK: Record<PredictionSeverity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const rankOf = (severity: string) => (severity in SEVERITY_RANK ? SEVERITY_RANK[severity as PredictionSeverity] : 0);

/**
 * The one prediction that speaks for a machine: the most severe of its scenarios, and
 * among equally severe ones the highest risk score. ThingsCare kept the first of a tie
 * and Live Predictions the highest, so one machine read 21 on one page and 29 on the
 * other on the same day (test report MAJ-7). Both pages now ask this.
 */
export function worstPrediction(predictions: readonly Prediction[]): Prediction | null {
  if (!predictions.length) return null;
  return predictions.reduce((worst, p) => {
    const byRank = rankOf(p.severity) - rankOf(worst.severity);
    return byRank > 0 || (byRank === 0 && p.riskScore > worst.riskScore) ? p : worst;
  });
}
