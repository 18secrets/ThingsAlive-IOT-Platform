import {
  BadRequestException, Controller, Get, HttpCode, Post, Query, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { FleetImportService } from './fleet-import.service';
import { buildFleetTemplate, FleetWorkbookRefusal } from './fleet-workbook';

/**
 * Bulk upload of equipment and devices, over HTTP.
 *
 * `equipment.write` on every route, the capability `POST /equipment` already asks
 * for: a workbook of machines is that call, many times. Fitting loggers additionally
 * needs `device.claim`, checked in the service because only a workbook with a Devices
 * sheet asks for it. Plan and apply take the same file; there is no stored batch.
 */
@ApiTags('Fleet import')
@Controller('fleet-import')
export class FleetImportController {
  constructor(private readonly fleet: FleetImportService) {}

  @Get('template')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'The empty fleet workbook: Equipment and Devices sheets with their headers' })
  async template(): Promise<StreamableFile> {
    return new StreamableFile(await buildFleetTemplate(), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="fleet-import-template.xlsx"',
    });
  }

  @Post('plan')
  @HttpCode(200)
  @Requires('equipment.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'What this workbook would add, per row, with every error and conflict. Writes nothing' })
  plan(
    // Loosely typed for the same reason as the catalog import: Express.Multer.File
    // lives in @types/multer, a dependency for the one field read here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @UploadedFile() file: any,
    @CurrentScope() scope: RequestScope,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.refusalsAsBadRequest(() => this.fleet.plan(scope, this.bytes(file), tenantId));
  }

  @Post('apply')
  @HttpCode(200)
  @Requires('equipment.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Add the machines and fit the loggers. Refused whole on any row error; idempotent' })
  apply(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @UploadedFile() file: any,
    @CurrentScope() scope: RequestScope,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.refusalsAsBadRequest(() => this.fleet.apply(scope, this.bytes(file), tenantId));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bytes(file: any): Buffer {
    if (!file?.buffer) throw new BadRequestException('A workbook file is required (multipart field "file").');
    return file.buffer;
  }

  private async refusalsAsBadRequest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FleetWorkbookRefusal) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
