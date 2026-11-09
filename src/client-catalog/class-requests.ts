import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { runTenantSpanning, withTenantSession } from '../scope/tenant-session';

export const CLASS_REQUEST_STATUSES = ['new', 'in_progress', 'published', 'declined'] as const;
export type ClassRequestStatus = (typeof CLASS_REQUEST_STATUSES)[number];

export interface ClassRequest {
  id: string;
  tenantId: string;
  machineType: string;
  manufacturer: string | null;
  model: string | null;
  signals: string[];
  note: string | null;
  status: ClassRequestStatus;
  staffNote: string | null;
  publishedClassSlug: string | null;
  requestedBy: string;
  decidedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class CreateClassRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(120) machineType: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) signals?: string[];
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class UpdateClassRequestDto {
  @IsIn(CLASS_REQUEST_STATUSES as unknown as string[]) status: ClassRequestStatus;
  @IsOptional() @IsString() @MaxLength(2000) staffNote?: string;
  @IsOptional() @IsString() @MaxLength(120) publishedClassSlug?: string;
}

const COLUMNS = `"id", "tenant_id" AS "tenantId", "machine_type" AS "machineType", "manufacturer", "model", "signals",
  "note", "status", "staff_note" AS "staffNote", "published_class_slug" AS "publishedClassSlug",
  "requested_by" AS "requestedBy", "decided_by" AS "decidedBy", "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;

/**
 * Asking for a class the library does not have (test report OB-6), and Things Alive
 * answering. The account sees its own requests and where each one is; staff see every
 * open request, oldest first, and move it on. The rules that keep a status honest are
 * the table's (ClassRequests migration); this turns its refusals into sentences.
 */
@Injectable()
export class ClassRequestService {
  constructor(private readonly ds: DataSource) {}

  async create(scope: RequestScope, input: CreateClassRequestDto): Promise<ClassRequest> {
    this.requireAccount(scope);
    const signals = [...new Set((input.signals ?? []).map((s) => s.trim()).filter(Boolean))];
    return withTenantSession(this.ds, scope, async (m) => {
      const [row] = await m.query(
        `INSERT INTO "class_request" ("tenant_id", "machine_type", "manufacturer", "model", "signals", "note", "requested_by")
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [scope.tenantId, input.machineType.trim(), input.manufacturer?.trim() || null, input.model?.trim() || null,
          signals, input.note?.trim() || null, scope.userId],
      );
      return row;
    }).catch(rethrow);
  }

  async listOwn(scope: RequestScope): Promise<ClassRequest[]> {
    this.requireAccount(scope);
    return withTenantSession(this.ds, scope, (m) => m.query(
      `SELECT ${COLUMNS} FROM "class_request" WHERE "tenant_id" = $1 ORDER BY "created_at" DESC`, [scope.tenantId]));
  }

  /** Staff: open requests first (oldest at the top), then the answered ones. */
  async queue(scope: RequestScope, status?: string): Promise<ClassRequest[]> {
    this.requireStaff(scope);
    if (status && !(CLASS_REQUEST_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`status must be one of ${CLASS_REQUEST_STATUSES.join(', ')}.`);
    }
    return runTenantSpanning(this.ds, `class request queue for ${scope.userId}`, (m) => m.query(
      `SELECT ${COLUMNS} FROM "class_request"
        WHERE ($1::text IS NULL OR "status" = $1)
        ORDER BY ("status" IN ('new', 'in_progress')) DESC, "created_at"`, [status ?? null]));
  }

  async update(scope: RequestScope, id: string, input: UpdateClassRequestDto): Promise<ClassRequest> {
    this.requireStaff(scope);
    return runTenantSpanning(this.ds, `class request ${id} by ${scope.userId}`, async (m) => {
      // Locked, so two staff answering the same request at once queue; the second then
      // meets the finality rule rather than overwriting the first answer.
      const [current] = await m.query(`SELECT "id" FROM "class_request" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!current) throw new NotFoundException(`No class request ${id}.`);
      // "Published" sends the account to look for a class; it has to be there to find.
      if (input.status === 'published' && input.publishedClassSlug) {
        const [found] = await m.query(
          `SELECT 1 FROM "equipment_class_profile" WHERE "slug" = $1 AND "status" = 'published' LIMIT 1`, [input.publishedClassSlug.trim()]);
        if (!found) throw new BadRequestException(`No published class "${input.publishedClassSlug}" in the library.`);
      }
      // TypeORM's postgres driver returns [rows, affected] for UPDATE ... RETURNING.
      const result: unknown = await m.query(
        `UPDATE "class_request"
            SET "status" = $2,
                "staff_note" = coalesce($3, "staff_note"),
                "published_class_slug" = coalesce($4, "published_class_slug"),
                "decided_by" = CASE WHEN $2 IN ('published', 'declined') THEN $5 ELSE "decided_by" END
          WHERE "id" = $1 RETURNING ${COLUMNS}`,
        [id, input.status, input.staffNote?.trim() || null, input.publishedClassSlug?.trim() || null, scope.userId],
      );
      const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as ClassRequest[];
      return rows[0];
    }).catch(rethrow);
  }

  private requireAccount(scope: RequestScope): void {
    if (scope.isPlatformRole || !scope.tenantId) throw new ForbiddenException('Class requests are made from an account.');
  }

  private requireStaff(scope: RequestScope): void {
    if (!scope.isPlatformRole) throw new ForbiddenException('Only Things Alive staff work the class request queue.');
  }
}

/** The table's refusals, as something the person can act on. */
function rethrow(err: unknown): never {
  if (err instanceof NotFoundException || err instanceof ForbiddenException || err instanceof BadRequestException) throw err;
  const e = err as { code?: string; constraint?: string; driverError?: { constraint?: string }; message?: string };
  const constraint = e.constraint ?? e.driverError?.constraint;
  const sentences: Record<string, string> = {
    ck_class_request_published: 'Name the published class (publishedClassSlug) so the account can find it.',
    ck_class_request_declined: 'Say why it was declined (staffNote); the account sees it.',
    ck_class_request_final: 'This request is already answered. The account can make a new one.',
    ck_class_request_machine_type: 'Describe the machine type in 2 to 120 characters.',
  };
  if (e.code === '23514' && constraint && sentences[constraint]) throw new BadRequestException(sentences[constraint]);
  throw err;
}

@ApiTags('Client catalog')
@Controller('my-catalog/class-requests')
export class MyClassRequestController {
  constructor(private readonly requests: ClassRequestService) {}

  @Post()
  @Requires('client-catalog.write')
  @ApiOperation({ summary: 'Ask Things Alive for an equipment class the library does not have' })
  create(@CurrentScope() scope: RequestScope, @Body() body: CreateClassRequestDto) {
    return this.requests.create(scope, body);
  }

  @Get()
  @Requires('client-catalog.read')
  @ApiOperation({ summary: 'This account\'s class requests and where each one is' })
  list(@CurrentScope() scope: RequestScope) {
    return this.requests.listOwn(scope);
  }
}

@ApiTags('Catalog')
@Controller('catalog/class-requests')
export class ClassRequestQueueController {
  constructor(private readonly requests: ClassRequestService) {}

  @Get()
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Every account\'s class requests, open ones first' })
  queue(@CurrentScope() scope: RequestScope, @Query('status') status?: string) {
    return this.requests.queue(scope, status);
  }

  @Patch(':id')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Move a request on: in_progress, published (with the class) or declined (with why)' })
  update(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: UpdateClassRequestDto) {
    return this.requests.update(scope, id, body);
  }
}
