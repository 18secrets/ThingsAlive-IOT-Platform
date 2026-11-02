import { Module } from '@nestjs/common';
import { LegacyShiftMetricsReader } from './legacy-shift-metrics.reader';
import { LEGACY_SHIFT_METRICS_CONFIG, legacyShiftMetricsConfigFrom } from './legacy-source';

/**
 * The read path to the existing platform's shift totals (D50), apart from `LegacyModule`
 * because it is configured apart: LEGACY_SHIFT_DB_* opens this one and nothing else, and
 * LEGACY_DB_* leaves it alone. Still in `src/legacy`, so the rule that only this
 * directory holds a connection to the existing platform stays true (wiring.spec).
 */
@Module({
  providers: [
    { provide: LEGACY_SHIFT_METRICS_CONFIG, useFactory: () => legacyShiftMetricsConfigFrom(process.env) },
    LegacyShiftMetricsReader,
  ],
  exports: [LegacyShiftMetricsReader],
})
export class LegacyShiftMetricsModule {}
