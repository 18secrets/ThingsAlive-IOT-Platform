import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { SHIELD_CATEGORIES, SHIELD_RESULTS, ShieldCategory, ShieldResult } from './shield-evidence-record.entity';
import { EvidenceInput, ShieldService } from './shield.service';

/** A correction carries everything but the category: a revision stays in its category,
 * and the database refuses one that tries to leave it. `recordedBy` is not a field —
 * the recorder is the caller, and a body naming someone else is refused outright. */
export class ReviseEvidenceDto {
  @ApiProperty({ example: 'Guard / isolation inspection' })
  @IsString() @IsNotEmpty() title: string;

  @ApiProperty({ enum: SHIELD_RESULTS, example: 'attention' })
  @IsIn(SHIELD_RESULTS as unknown as string[]) result: ShieldResult;

  @ApiProperty({ example: '2026-10-10T09:30:00.000Z', description: 'When the check happened. Not in the future.' })
  @IsISO8601() performedAt: string;

  @ApiPropertyOptional({ example: '2027-01-10T00:00:00.000Z', description: 'When the next one is due; omit for a one-off.' })
  @IsOptional() @IsISO8601() dueAt?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'A user of this account. At least one of ownerUserId and ownerName.' })
  @IsOptional() @IsUUID() ownerUserId?: string | null;

  @ApiPropertyOptional({ example: 'R. Kulkarni (contractor)' })
  @IsOptional() @IsString() ownerName?: string | null;

  @ApiPropertyOptional({ example: 'CHK-2026-0412' })
  @IsOptional() @IsString() reference?: string | null;

  @ApiPropertyOptional({ example: 'Guard latch needs adjustment; machine left isolated.' })
  @IsOptional() @IsString() findings?: string | null;
}

export class RecordEvidenceDto extends ReviseEvidenceDto {
  @ApiProperty({ enum: SHIELD_CATEGORIES, example: 'safety' })
  @IsIn(SHIELD_CATEGORIES as unknown as string[]) category: ShieldCategory;
}

const input = (b: ReviseEvidenceDto): EvidenceInput => ({
  title: b.title, result: b.result, performedAt: new Date(b.performedAt),
  dueAt: b.dueAt ? new Date(b.dueAt) : null,
  ownerUserId: b.ownerUserId ?? null, ownerName: b.ownerName ?? null,
  reference: b.reference ?? null, findings: b.findings ?? null,
});

/**
 * ThingsShield (task QSHIELD1): inspection and check evidence per machine, and a
 * status derived from it at read time. Every status, including `not_recorded`, is in
 * the summary — the page never has to infer one from an absence.
 */
@ApiTags('ThingsShield')
@Controller('shield')
export class ShieldController {
  constructor(private readonly shield: ShieldService) {}

  @Get('summary')
  @Requires('shield.read')
  @ApiOperation({ summary: 'Per machine and category: the standing status and the record behind it; fleet counts per status' })
  summary(@CurrentScope() scope: RequestScope) {
    return this.shield.summary(scope);
  }

  @Get('equipment/:sourceSystem/:externalId/records')
  @Requires('shield.read')
  @ApiOperation({ summary: 'Every record on the machine, newest check first, corrected ones included and marked' })
  records(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.shield.records(scope, sourceSystem, externalId);
  }

  @Post('equipment/:sourceSystem/:externalId/records')
  @Requires('shield.write')
  @ApiOperation({ summary: 'Record a check performed on the machine' })
  record(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: RecordEvidenceDto,
  ) {
    return this.shield.record(scope, sourceSystem, externalId, body.category, input(body));
  }

  @Post('records/:id/revisions')
  @Requires('shield.write')
  @ApiOperation({
    summary: 'Correct a record. The original stays; a record is corrected once — retrying the same correction returns it, a different one is a 409',
  })
  revise(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: ReviseEvidenceDto) {
    return this.shield.revise(scope, id, input(body));
  }
}
