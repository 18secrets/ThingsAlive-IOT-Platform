import { Logger } from '@nestjs/common';

/**
 * Boot-time configuration check.
 *
 * A service that starts with a missing secret and fails on the first request is
 * harder to diagnose than one that refuses to start. Production is strict;
 * development warns so the service is still runnable before every value exists.
 */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const logger = new Logger('Config');
  const isProd = raw.NODE_ENV === 'production';
  const required = ['AUTH_JWT_SECRET', 'CORS_ORIGINS'];
  const missing = required.filter((k) => !raw[k] || `${raw[k]}`.trim() === '');

  if (missing.length) {
    const msg = `Missing configuration: ${missing.join(', ')}`;
    if (isProd) throw new Error(`${msg}. Refusing to start.`);
    logger.warn(`${msg}. Continuing because NODE_ENV is not production.`);
  }

  if (isProd && `${raw.CORS_ORIGINS}`.includes('*')) {
    throw new Error('CORS_ORIGINS must not contain a wildcard in production.');
  }

  return raw;
}

/** Parse the comma-separated allowlist. No wildcard fallback exists (task P0-11). */
export function corsOrigins(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
