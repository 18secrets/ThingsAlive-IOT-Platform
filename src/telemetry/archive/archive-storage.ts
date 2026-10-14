import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export const ARCHIVE_STORAGE = Symbol('ta:archive-storage');

/**
 * Where archived telemetry goes (task QARCH1, D14). An interface so the archiver can be
 * tested against something that can be made to lose or truncate a file — which is
 * exactly the case verify-then-drop exists for.
 */
export interface ArchiveStorage {
  readonly configured: boolean;
  put(key: string, localPath: string): Promise<void>;
  /** Writes the object at `key` to `localPath`; throws when there is none. */
  get(key: string, localPath: string): Promise<void>;
}

export interface ArchiveStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * Its own bucket and credentials, not the class-visual ones: archives are the tenant
 * data that leaves the database, and per-tenant read credentials scoped to each
 * `tenants/<id>/` prefix (D14.3) are configured on this bucket — something a bucket
 * that also serves public images cannot be. Half a configuration is none.
 */
export function archiveConfigFrom(env: Record<string, string | undefined>): ArchiveStorageConfig | null {
  const endpoint = env.ARCHIVE_S3_ENDPOINT?.trim();
  const bucket = env.ARCHIVE_S3_BUCKET?.trim();
  const accessKeyId = env.ARCHIVE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.ARCHIVE_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.ARCHIVE_S3_REGION?.trim() || 'auto' };
}

export class S3ArchiveStorage implements ArchiveStorage {
  readonly configured = true;
  private readonly client: S3Client;

  constructor(private readonly config: ArchiveStorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, localPath: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: key, Body: createReadStream(localPath),
      ContentLength: statSync(localPath).size, ContentType: 'application/vnd.apache.parquet',
    }));
  }

  async get(key: string, localPath: string): Promise<void> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    await pipeline(out.Body as Readable, createWriteStream(localPath));
  }
}

/** No bucket: the archiver reports `not_configured` and touches nothing. */
export class UnconfiguredArchiveStorage implements ArchiveStorage {
  readonly configured = false;
  put(): Promise<void> { return Promise.reject(new Error('No ARCHIVE_S3_* configuration.')); }
  get(): Promise<void> { return Promise.reject(new Error('No ARCHIVE_S3_* configuration.')); }
}

export function archiveStorageFrom(env: Record<string, string | undefined>): ArchiveStorage {
  const config = archiveConfigFrom(env);
  return config ? new S3ArchiveStorage(config) : new UnconfiguredArchiveStorage();
}
