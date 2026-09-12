/**
 * One severity vocabulary for the whole of Platform 2.0 (task P0-09).
 *
 * The existing platform carries at least three: the backend's alert strings, the
 * architecture paper's warning|critical, and the UI's five-level scale. 2.0 defines
 * exactly one and maps everything else at the boundary where foreign data enters —
 * never by sprinkling conversions through the application.
 */
export enum Severity {
  None = 'none',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export const SEVERITY_ORDER: readonly Severity[] = [
  Severity.None,
  Severity.Low,
  Severity.Medium,
  Severity.High,
  Severity.Critical,
];

/** Raised when foreign data carries a severity 2.0 has no mapping for. */
export class UnmappedSeverityError extends Error {
  constructor(readonly value: string) {
    super(
      `Unmapped severity "${value}". Add it to LEGACY_SEVERITY_MAP rather than ` +
        `defaulting — a silently downgraded severity is a missed alert.`,
    );
    this.name = 'UnmappedSeverityError';
  }
}

/**
 * Every severity value observed in the existing platform and in the UI, mapped to
 * exactly one 2.0 value. Keys are compared lower-cased and trimmed.
 */
const LEGACY_SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  // 2.0's own values round-trip unchanged.
  none: Severity.None,
  low: Severity.Low,
  medium: Severity.Medium,
  high: Severity.High,
  critical: Severity.Critical,

  // Existing backend / alert engine.
  info: Severity.None,
  informational: Severity.None,
  normal: Severity.None,
  ok: Severity.None,
  minor: Severity.Low,
  warn: Severity.Medium,
  warning: Severity.Medium,
  major: Severity.High,
  severe: Severity.Critical,
  fatal: Severity.Critical,
  emergency: Severity.Critical,

  // Numeric scales seen on alarm payloads.
  '0': Severity.None,
  '1': Severity.Low,
  '2': Severity.Medium,
  '3': Severity.High,
  '4': Severity.Critical,
};

/**
 * Map a foreign severity onto 2.0's vocabulary.
 * Throws rather than defaulting: an unknown value is a data-contract problem and
 * should stop the row, not quietly become "low".
 */
export function mapLegacySeverity(value: string | number | null | undefined): Severity {
  if (value === null || value === undefined || `${value}`.trim() === '') {
    throw new UnmappedSeverityError(String(value));
  }
  const key = `${value}`.trim().toLowerCase();
  const mapped = LEGACY_SEVERITY_MAP[key];
  if (!mapped) throw new UnmappedSeverityError(String(value));
  return mapped;
}

/** True when `a` is at least as severe as `b`. */
export function atLeast(a: Severity, b: Severity): boolean {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b);
}

/** The values 2.0 knows how to map — used by the boundary test. */
export function knownLegacySeverities(): string[] {
  return Object.keys(LEGACY_SEVERITY_MAP);
}
