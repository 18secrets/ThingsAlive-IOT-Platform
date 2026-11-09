import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, StreamableFile, UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateNested,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { buildRosterTemplate, RosterWorkbookRefusal } from './roster-workbook';
import { ServiceRosterService } from './service-roster.service';

export class RosterEngineerDto {
  @IsEmail() email: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) rank?: number;
}

export class RosterRegionDto {
  @IsString() @IsNotEmpty() name: string;
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) siteCodes: string[];
  // @ValidateNested, or a whitelisting pipe strips the objects and then refuses them.
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RosterEngineerDto)
  engineers: RosterEngineerDto[];
}

/**
 * The service roster (U5): regions of sites and the engineers who cover them, so a job
 * raised on a machine goes to the right person. Edited a region at a time on screen,
 * or replaced whole from Excel.
 */
@ApiTags('Service roster')
@Controller('service-roster')
export class ServiceRosterController {
  constructor(private readonly roster: ServiceRosterService) {}

  @Get()
  @Requires('action.assign')
  @ApiOperation({ summary: 'Every region with its sites and its engineers in rank order' })
  list(@CurrentScope() scope: RequestScope) {
    return this.roster.list(scope);
  }

  @Put('regions/:code')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Create or replace one region: name, sites, engineers (rank 1 takes the job)' })
  put(@CurrentScope() scope: RequestScope, @Param('code') code: string, @Body() body: RosterRegionDto) {
    return this.roster.putRegion(scope, { code, ...body });
  }

  @Delete('regions/:code')
  @HttpCode(204)
  @Requires('action.assign')
  @ApiOperation({ summary: 'Remove a region. Its sites go back to unassigned jobs' })
  remove(@CurrentScope() scope: RequestScope, @Param('code') code: string) {
    return this.roster.removeRegion(scope, code);
  }

  @Get('template')
  @Requires('action.assign')
  @ApiOperation({ summary: 'The empty roster workbook, with a read-me and an example region' })
  async template(): Promise<StreamableFile> {
    return new StreamableFile(await buildRosterTemplate(), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="service-roster-template.xlsx"',
    });
  }

  @Post('import/plan')
  @HttpCode(200)
  @Requires('action.assign')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Check a roster workbook row by row. Writes nothing' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan(@CurrentScope() scope: RequestScope, @UploadedFile() file: any) {
    return this.refusals(() => this.roster.planImport(scope, this.bytes(file)));
  }

  @Post('import/apply')
  @HttpCode(200)
  @Requires('action.assign')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Replace the whole roster with the workbook. Refused whole on any row error' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(@CurrentScope() scope: RequestScope, @UploadedFile() file: any) {
    return this.refusals(() => this.roster.applyImport(scope, this.bytes(file)));
  }

  // Loosely typed as in the fleet import: Express.Multer.File is in @types/multer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bytes(file: any): Buffer {
    if (!file?.buffer) throw new BadRequestException('A workbook file is required (multipart field "file").');
    return file.buffer;
  }

  private async refusals<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RosterWorkbookRefusal) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
