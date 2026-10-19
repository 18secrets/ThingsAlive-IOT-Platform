import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';

export const ASSET_STORAGE = Symbol('ta:asset-storage');

/** The image types a class visual may be. Closed; anything else is refused, naming it. */
export const VISUAL_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type VisualContentType = (typeof VISUAL_CONTENT_TYPES)[number];

/** A sanity bound on what a confirm will accept, not a processing step. */
export const MAX_VISUAL_BYTES = 50 * 1024 * 1024;

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const READ_URL_TTL_SECONDS = 15 * 60;

export interface ObjectHead { contentType: string | null; size: number }

/**
 * Where class visuals' bytes live (task QREC0c §1). The database stores a key; the
 * bucket stores bytes — a 5–50 MB file in a row is a bandwidth bill and a backup
 * problem.
 *
 * An interface, not the SDK directly, so the one call that needs a network (`head`,
 * at confirm) can be faked in tests; presigning is computed offline by the SDK and is
 * tested for real.
 */
export interface AssetStorage {
  readonly configured: boolean;
  /** A short-lived URL the console PUTs the bytes to. The API never streams them. */
  presignPut(key: string, contentType: string): Promise<string>;
  /** A short-lived GET URL, or the CDN URL when one is configured. Never credentials. */
  readUrl(key: string): Promise<string>;
  /** What is actually at `key`, or null when nothing is — checked at confirm. */
  head(key: string): Promise<ObjectHead | null>;
}

export interface AssetStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  publicBaseUrl: string | null;
  /**
   * Where under the bucket 2.0's objects live, e.g. `ta2/`. Empty means the bucket root.
   *
   * Exists because 2.0 shares a bucket with IoT Platform 1.0, whose database backups
   * sit under `db-backups/` (D44). Applied here, at the one place keys meet the bucket,
   * so the keys stored in the database stay prefix-free and a later move to a bucket of
   * 2.0's own is a configuration change, not a data migration.
   */
  keyPrefix: string;
}

const PREFIX_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Any provider with an S3 API (R2, MinIO, S3 itself) — chosen entirely by environment.
 * Half a configuration is treated as none, for the reason legacy-source.ts gives: it
 * would fail at the first upload rather than at boot. */
export function assetConfigFrom(env: Record<string, string | undefined>): AssetStorageConfig | null {
  const endpoint = env.ASSET_S3_ENDPOINT?.trim();
  const bucket = env.ASSET_S3_BUCKET?.trim();
  const accessKeyId = env.ASSET_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.ASSET_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const prefix = (env.ASSET_S3_KEY_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
  // Refused at boot rather than trusted: a prefix like `../` or one with spaces is a
  // key nobody meant, written next to somebody else's objects.
  if (prefix && (!PREFIX_PATTERN.test(prefix) || prefix.split('/').some((seg) => seg === '.' || seg === '..'))) {
    throw new Error(`ASSET_S3_KEY_PREFIX "${prefix}" is not a plain path (letters, digits, . _ - and /).`);
  }
  return {
    endpoint, bucket, accessKeyId, secretAccessKey,
    region: env.ASSET_S3_REGION?.trim() || 'auto',
    publicBaseUrl: env.ASSET_S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
    keyPrefix: prefix ? `${prefix}/` : '',
  };
}

export class S3AssetStorage implements AssetStorage {
  readonly configured = true;
  private readonly client: S3Client;

  constructor(private readonly config: AssetStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  /** The object's key in the bucket: the stored key under the configured prefix. */
  private at(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  presignPut(key: string, contentType: string): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.config.bucket, Key: this.at(key), ContentType: contentType,
    }), { expiresIn: UPLOAD_URL_TTL_SECONDS });
  }

  readUrl(key: string): Promise<string> {
    if (this.config.publicBaseUrl) return Promise.resolve(`${this.config.publicBaseUrl}/${this.at(key)}`);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.bucket, Key: this.at(key) }), {
      expiresIn: READ_URL_TTL_SECONDS,
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.at(key) }));
      return { contentType: out.ContentType ?? null, size: out.ContentLength ?? 0 };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }
}

/** No bucket configured: the API still boots, and visuals read
 * `not_available` / `assets_unavailable`. A missing bucket makes visuals unavailable
 * and nothing else. */
export class UnconfiguredAssetStorage implements AssetStorage {
  readonly configured = false;
  private refuse(): never { throw new Error('Asset storage is not configured (ASSET_S3_*).'); }
  presignPut(): Promise<string> { return this.refuse(); }
  readUrl(): Promise<string> { return this.refuse(); }
  head(): Promise<ObjectHead | null> { return this.refuse(); }
}

export function assetStorageFrom(env: Record<string, string | undefined>, logger = new Logger('AssetStorage')): AssetStorage {
  const config = assetConfigFrom(env);
  if (!config) {
    logger.warn(
      'No ASSET_S3_* configuration. Class visuals cannot be uploaded or served, so every '
        + 'schematic reads not_available / assets_unavailable. This is expected until a bucket exists.',
    );
    return new UnconfiguredAssetStorage();
  }
  return new S3AssetStorage(config);
}
