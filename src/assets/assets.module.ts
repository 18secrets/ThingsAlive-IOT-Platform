import { Global, Module } from '@nestjs/common';
import { ASSET_STORAGE, assetStorageFrom } from './asset-storage';

/**
 * Object storage for class visuals (task QREC0c). Global, because both authoring and
 * the composed page read it, and resolved once from the environment at boot — the same
 * shape as the legacy source: unconfigured is a warning and a working API, not a crash.
 */
@Global()
@Module({
  providers: [{ provide: ASSET_STORAGE, useFactory: () => assetStorageFrom(process.env) }],
  exports: [ASSET_STORAGE],
})
export class AssetsModule {}
