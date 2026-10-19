import { assetConfigFrom, S3AssetStorage } from '../src/assets/asset-storage';

const ENV = {
  ASSET_S3_ENDPOINT: 'https://innoida.example.test',
  ASSET_S3_BUCKET: 'shared-bucket',
  ASSET_S3_ACCESS_KEY_ID: 'AKIATESTPREFIX',
  ASSET_S3_SECRET_ACCESS_KEY: 'secret-that-must-never-be-returned',
  ASSET_S3_REGION: 'ap-south-in-noida-1',
};
const KEY = 'class-visuals/genset/v1/abc.png';

/**
 * The asset key prefix (D44). 2.0 shares a bucket with IoT Platform 1.0, whose
 * database backups live under `db-backups/`, so every object 2.0 writes, reads or
 * checks must be under its own prefix — and the key stored in the database must not
 * carry it, so leaving the shared bucket later is a configuration change.
 */
describe('asset storage: the key prefix of a shared bucket', () => {
  const storage = (extra: Record<string, string> = {}) => new S3AssetStorage(assetConfigFrom({ ...ENV, ...extra })!);

  it('puts every upload under the prefix, whatever slashes it was configured with', async () => {
    for (const prefix of ['ta2', 'ta2/', '/ta2/']) {
      const url = new URL(await storage({ ASSET_S3_KEY_PREFIX: prefix }).presignPut(KEY, 'image/png'));
      expect(url.pathname).toBe(`/shared-bucket/ta2/${KEY}`);
    }
  });

  it('reads from the prefixed key, signed or through a public base URL', async () => {
    const signed = new URL(await storage({ ASSET_S3_KEY_PREFIX: 'ta2' }).readUrl(KEY));
    expect(signed.pathname).toBe(`/shared-bucket/ta2/${KEY}`);
    expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(await storage({ ASSET_S3_KEY_PREFIX: 'ta2', ASSET_S3_PUBLIC_BASE_URL: 'https://cdn.example.test/' }).readUrl(KEY))
      .toBe(`https://cdn.example.test/ta2/${KEY}`);
  });

  it('checks the prefixed key at confirm', async () => {
    const s = storage({ ASSET_S3_KEY_PREFIX: 'ta2' });
    const sent: { Bucket?: string; Key?: string }[] = [];
    // The one network call, intercepted: what matters is which object it asks about.
    (s as unknown as { client: { send: (c: { input: { Bucket?: string; Key?: string } }) => Promise<unknown> } }).client = {
      send: async (c) => { sent.push(c.input); return { ContentType: 'image/png', ContentLength: 4 }; },
    };
    expect(await s.head(KEY)).toEqual({ contentType: 'image/png', size: 4 });
    expect(sent).toEqual([{ Bucket: 'shared-bucket', Key: `ta2/${KEY}` }]);
  });

  it('with no prefix, keys are exactly as stored, as before', async () => {
    expect(new URL(await storage().presignPut(KEY, 'image/png')).pathname).toBe(`/shared-bucket/${KEY}`);
    expect(assetConfigFrom(ENV)!.keyPrefix).toBe('');
  });

  it('refuses a prefix that is not a plain path, at boot', () => {
    for (const bad of ['../db-backups', 'ta2/../db-backups', 'ta 2', 'ta2//x', 'ta2?x=1']) {
      expect(() => assetConfigFrom({ ...ENV, ASSET_S3_KEY_PREFIX: bad })).toThrow(/is not a plain path/);
    }
  });
});
