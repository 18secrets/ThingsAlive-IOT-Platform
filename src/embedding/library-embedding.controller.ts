import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { LibraryEmbeddingService, MAX_RESULTS } from './library-embedding.service';

export class LibrarySearchDto {
  @IsString() @IsNotEmpty() @MaxLength(1000)
  query: string;

  // The shared contract's semantic candidate count is 30; nothing reads past it.
  @IsOptional() @IsInt() @Min(1) @Max(MAX_RESULTS)
  limit?: number;

  @IsOptional() @IsString() @IsNotEmpty()
  classSlug?: string;
}

const NOT_CONFIGURED = '503 embedding_not_configured when the model files are not on this server.';

/**
 * Semantic search over the account's library (task QEMB1).
 *
 * Search on `prediction.read`, the gate the recommendation evidence it serves already
 * uses. Reindex on `prediction.run`: it writes, though only derived rows the caller could
 * recompute, and it runs the model.
 */
@ApiTags('Library search')
@Controller('library-embeddings')
export class LibraryEmbeddingController {
  constructor(private readonly embeddings: LibraryEmbeddingService) {}

  @Post('search')
  @HttpCode(200)
  @Requires('prediction.read')
  @ApiOperation({
    summary: 'Find the account\'s failure modes and recommendations closest in meaning to a sentence',
    description: 'Hits carry a rank, never a score: relevance is not confidence. `coverage.stale` counts entries edited '
      + `since the last reindex, whose old text is what is searched until then. ${NOT_CONFIGURED}`,
  })
  search(@CurrentScope() scope: RequestScope, @Body() body: LibrarySearchDto) {
    return this.embeddings.search(scope, body.query, body.limit ?? MAX_RESULTS, body.classSlug);
  }

  @Post('reindex')
  @HttpCode(200)
  @Requires('prediction.run')
  @ApiOperation({
    summary: 'Embed every library entry that is new or changed. Idempotent: unchanged entries are not embedded again',
    description: NOT_CONFIGURED,
  })
  @ApiResponse({ status: 200, description: '{ profile, sources, embedded, unchanged }' })
  reindex(@CurrentScope() scope: RequestScope) {
    return this.embeddings.reindex(scope);
  }
}
