import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { CodeInput, CodeQuery, FaultCodeLibraryService } from './services/fault-code-library.service';

export class GrantFaultCodeTypeDto {
  @IsString() @IsNotEmpty()
  tenantId: string;

  /** vehicle-j1939, vehicle-obd2 or motor-pump. */
  @IsString() @IsNotEmpty()
  codeType: string;

  @IsOptional() @IsString()
  note?: string;
}

/**
 * A code's fields as Master Admin writes them. Each is optional here: adding a code needs a
 * description (and its key — code, or spn and fmi for J1939), which the service checks;
 * an edit sends only what changes, and null clears a field.
 */
export class FaultCodeDto implements CodeInput {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsInt() @Min(0) spn?: number | null;
  @IsOptional() @IsInt() @Min(0) fmi?: number | null;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() symptom?: string | null;
  @IsOptional() @IsString() causes?: string | null;
  @IsOptional() @IsString() remedies?: string | null;
  @IsOptional() @IsString() detection?: string | null;
  @IsOptional() @IsIn(['logger', 'technician']) foundBy?: 'logger' | 'technician' | null;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsString() lamp?: string;
  // A vehicle code's (VehicleCodesOwned1765600000000); a motor code ignores them.
  @IsOptional() @IsString() system?: string | null;
  @IsOptional() @IsString() oemCode?: string | null;
  @IsOptional() @IsString() sensor?: string | null;
  @IsOptional() @IsString() location?: string | null;
  @IsOptional() @IsString() pinDetails?: string | null;
  @IsOptional() @IsString() voltageRange?: string | null;
  @IsOptional() @IsString() signalRange?: string | null;
  @IsOptional() @IsString() diagnosticAids?: string | null;
  @IsOptional() @IsString() troubleshooting?: string | null;
  @IsOptional() @IsString() vehicleReaction?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function workbookBytes(file: any): Buffer {
  if (!file?.buffer) throw new BadRequestException('A workbook file is required (multipart field "file").');
  return file.buffer;
}

const codeQuery = (q?: string, limit?: string, offset?: string, includeRetired?: string): CodeQuery => ({
  q, limit: limit === undefined ? undefined : Number(limit), offset: offset === undefined ? undefined : Number(offset),
  includeRetired: includeRetired === 'true',
});

/**
 * The fault code library. Master Admin gives accounts kinds of code (`entitlement.grant`,
 * as class entitlements); the library's editors add, change and retire the codes 2.0 owns
 * (`catalog.write`, as every other library); an account reads the codes of the kinds it
 * was given.
 */
@ApiTags('Fault code library')
@Controller()
export class FaultCodeLibraryController {
  constructor(private readonly library: FaultCodeLibraryService) {}

  // Declared before `catalog/fault-codes/:type`, which would otherwise take "grants".
  @Get('catalog/fault-codes/grants')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Which kinds of fault code each account is given — master admin only' })
  listGrants() {
    return this.library.listGrants();
  }

  @Post('catalog/fault-codes/grants')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Give an account a kind of fault code. Granting what it has changes nothing' })
  grant(@CurrentScope() scope: RequestScope, @Body() dto: GrantFaultCodeTypeDto) {
    return this.library.grant(scope, dto.tenantId, dto.codeType, dto.note);
  }

  @Post('catalog/fault-codes/grants/:id/revoke')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Withdraw a kind of fault code from an account. The row stays; revoked is not deleted' })
  revoke(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.library.revoke(scope, id);
  }

  // Whoever edits the library reads it: catalog.write, as every other library editor.
  @Get('catalog/fault-codes/:type')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every code of one kind (vehicle-j1939, vehicle-obd2, motor-pump), for the library editor' })
  codes(
    @Param('type') type: string,
    @Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string,
    @Query('includeRetired') includeRetired?: string,
  ) {
    return this.library.codes(type, codeQuery(q, limit, offset, includeRetired));
  }

  // ---- bulk import (step 3). Declared before the :id routes below, which share their
  // segment count.

  @Get('catalog/fault-codes/:type/template')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'The workbook for one kind: its columns, a read-me of every column, and one example row' })
  async template(@Param('type') type: string): Promise<StreamableFile> {
    return new StreamableFile(await this.library.template(type), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="fault-codes-${type}.xlsx"`,
    });
  }

  @Post('catalog/fault-codes/:type/import/check')
  @HttpCode(200)
  @Requires('catalog.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Check a fault code workbook row by row: new, changed, unchanged or in error. Writes nothing' })
  // Loosely typed as in the roster import: Express.Multer.File is in @types/multer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check(@CurrentScope() scope: RequestScope, @Param('type') type: string, @UploadedFile() file: any) {
    return this.library.importCodes(scope, type, workbookBytes(file), false);
  }

  @Post('catalog/fault-codes/:type/import/apply')
  @HttpCode(200)
  @Requires('catalog.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Apply a fault code workbook: refused whole while any row is in error. Applying it again changes nothing' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(@CurrentScope() scope: RequestScope, @Param('type') type: string, @UploadedFile() file: any) {
    return this.library.importCodes(scope, type, workbookBytes(file), true);
  }

  // ---- editing (step 2): the codes 2.0 owns. 1.0's vehicle codes are refused, here and
  // by the database.

  @Post('catalog/fault-codes/:type')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Add a code 2.0 owns: a motor code, or a 2.0 vehicle code' })
  create(@CurrentScope() scope: RequestScope, @Param('type') type: string, @Body() dto: FaultCodeDto) {
    return this.library.create(scope, type, dto);
  }

  @Patch('catalog/fault-codes/:type/:id')
  @Requires('catalog.write')
  @ApiOperation({ summary: "Change a code's text; every changed field is written to its history" })
  update(@CurrentScope() scope: RequestScope, @Param('type') type: string, @Param('id') id: string, @Body() dto: FaultCodeDto) {
    return this.library.update(scope, type, id, dto);
  }

  @Post('catalog/fault-codes/:type/:id/retire')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Retire a code. Never deleted: fault history points at it' })
  retire(@CurrentScope() scope: RequestScope, @Param('type') type: string, @Param('id') id: string) {
    return this.library.setRetired(scope, type, id, true);
  }

  @Post('catalog/fault-codes/:type/:id/restore')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Bring a retired code back' })
  restore(@CurrentScope() scope: RequestScope, @Param('type') type: string, @Param('id') id: string) {
    return this.library.setRetired(scope, type, id, false);
  }

  @Get('catalog/fault-codes/:type/:id/history')
  @Requires('catalog.write')
  @ApiOperation({ summary: "A code's edits, newest first: who changed which field, from what, and when" })
  history(@Param('type') type: string, @Param('id') id: string) {
    return this.library.history(type, id);
  }

  @Get('my-catalog/fault-codes')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'The kinds of fault code this account is given, with how many codes each holds' })
  myTypes(@CurrentScope() scope: RequestScope) {
    return this.library.myTypes(scope);
  }

  @Get('my-catalog/fault-codes/:type')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'The codes of one kind this account is given; a kind it was not given is not found' })
  myCodes(
    @CurrentScope() scope: RequestScope, @Param('type') type: string,
    @Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string,
  ) {
    return this.library.myCodes(scope, type, codeQuery(q, limit, offset));
  }
}
