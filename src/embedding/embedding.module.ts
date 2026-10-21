import { Module } from '@nestjs/common';
import { DEFAULT_MODEL_DIR, EMBEDDING_RUNTIME, OnnxEmbeddingRuntime } from './embedder';
import { LibraryEmbeddingController } from './library-embedding.controller';
import { LibraryEmbeddingService } from './library-embedding.service';

/**
 * bge-small in the api, and the account's library as vectors (task QEMB1; D19, D47).
 *
 * Nothing is loaded at boot. The model loads on the first search or reindex, from files
 * the image carries; without them every call answers 503 embedding_not_configured and
 * nothing else on the server notices.
 */
@Module({
  controllers: [LibraryEmbeddingController],
  providers: [
    LibraryEmbeddingService,
    {
      provide: EMBEDDING_RUNTIME,
      useFactory: () => new OnnxEmbeddingRuntime(process.env.EMBEDDING_MODEL_DIR?.trim() || DEFAULT_MODEL_DIR),
    },
  ],
  exports: [LibraryEmbeddingService],
})
export class EmbeddingModule {}
