import {
  BadRequestException, Controller, Get, Header, HttpCode, Param, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ReadingsCsvRefusal } from './readings-csv';
import { ReadingsImportService } from './readings-import.service';

const FORMAT = 'CSV with header timestamp,sensor,value[,unit]. timestamp is ISO 8601 with a zone '
  + '(2026-09-01T10:00:00+05:30 or ...Z); sensor is a signal bound to this machine; unit, if given, must be the '
  + 'binding\'s. Stored as source "replayed", so results computed from it are never mistaken for live ones.';

/**
 * Historical readings for one machine, over HTTP (multipart field "file", up to 20 MB).
 *
 * `equipment.write`, the capability that registers the machine and binds its sensors:
 * loading a machine's history is configuring that machine, and only the roles that can
 * do the one may do the other. Plan and apply take the same file; there is no stored batch.
 */
@ApiTags('Readings import')
@Controller('equipment/:sourceSystem/:externalId/readings')
export class ReadingsImportController {
  constructor(private readonly readings: ReadingsImportService) {}

  @Get('import-template')
  @Requires('equipment.write')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'An empty CSV naming this machine\'s bound sensors and their units', description: FORMAT })
  template(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.readings.template(scope, { sourceSystem, externalId });
  }

  @Post('import/plan')
  @HttpCode(200)
  @Requires('equipment.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Check a CSV: every refused line with its reason, per-sensor ranges, how many are already stored. Writes nothing', description: FORMAT })
  plan(
    // Loosely typed for the same reason as the fleet import: Express.Multer.File lives in
    // @types/multer, a dependency for the one field read here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @UploadedFile() file: any,
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.refusalsAsBadRequest(() => this.readings.plan(scope, { sourceSystem, externalId }, this.text(file)));
  }

  @Post('import')
  @HttpCode(200)
  @Requires('equipment.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Store the readings. Refused whole (422) if any row is refused; idempotent', description: FORMAT })
  apply(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @UploadedFile() file: any,
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.refusalsAsBadRequest(() => this.readings.apply(scope, { sourceSystem, externalId }, this.text(file)));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private text(file: any): string {
    if (!file?.buffer) throw new BadRequestException('A CSV file is required (multipart field "file").');
    return (file.buffer as Buffer).toString('utf8');
  }

  private async refusalsAsBadRequest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReadingsCsvRefusal) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
