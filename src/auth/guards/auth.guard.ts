import {
  CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SCOPE_RESOLVER, ScopeResolver } from '../scope-resolver';
import { PLATFORM_ROLE_SET as PLATFORM_ROLES } from '../platform-roles';
import { REQUEST_SCOPE_KEY, RequestScope } from '../types/request-scope';

/**
 * Authenticated by default (task P0-03), and tenant-aware by construction (P0-05).
 *
 * 2.0 issues no credentials of its own: it verifies the token the existing platform
 * issued and reads the tenant claim from it. A token without a resolvable tenant is
 * rejected rather than treated as "all tenants" — the failure mode that turns a bug
 * into a cross-customer data leak.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    // Optional so the guard stands alone. Absent, the token is the whole story —
    // which is what the contract and isolation suites rely on, and what a platform
    // caller gets, since Things Alive staff hold no row in any customer's account.
    @Optional() @Inject(SCOPE_RESOLVER) private readonly resolver?: ScopeResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const publicReason = this.reflector.get<string>(IS_PUBLIC_KEY, ctx.getHandler());
    if (publicReason) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = bearerFrom(req.headers?.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required.');

    let payload: Record<string, any>;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('AUTH_JWT_SECRET'),
        issuer: this.config.get<string>('AUTH_JWT_ISSUER') || undefined,
      });
    } catch {
      throw new UnauthorizedException('Token is not valid.');
    }

    const tenantClaim = this.config.get<string>('AUTH_TENANT_CLAIM') || 'client_id';
    const tenantId = payload[tenantClaim];
    if (tenantId === undefined || tenantId === null || `${tenantId}`.trim() === '') {
      // The legacy prerequisite (task P0-15). Loud, not lenient.
      throw new UnauthorizedException(
        `Token carries no "${tenantClaim}" claim. 2.0 cannot resolve a tenant for this request.`,
      );
    }

    const roles: string[] = normaliseRoles(payload.roles ?? payload.role);
    const userId = String(payload.sub ?? payload.user_id ?? '');
    let scope: RequestScope = {
      tenantId: String(tenantId),
      userId,
      roles,
      isPlatformRole: roles.some((r) => PLATFORM_ROLES.has(r)),
      plantIds: asIdList(payload.plant_ids),
      equipmentIds: asIdList(payload.equipment_ids),
      deviceIds: asIdList(payload.device_ids),
    };

    // What the account says now beats what the token said when it was issued. This is
    // the whole reason scope is resolved per request: a suspension, a role change or
    // a withdrawn assignment applies to the next request rather than whenever the
    // token happens to expire.
    if (this.resolver && userId && !scope.isPlatformRole) {
      const resolved = await this.resolver.resolve(scope.tenantId, userId);
      if (resolved) {
        scope = {
          ...scope,
          roles: resolved.roles,
          capabilities: resolved.capabilities,
          plantIds: resolved.plantIds,
          equipmentIds: resolved.equipmentIds,
        };
      }
    }

    req[REQUEST_SCOPE_KEY] = scope;
    return true;
  }
}

function bearerFrom(header?: string): string | null {
  if (!header) return null;
  const [kind, value] = header.split(' ');
  return kind?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

function normaliseRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim().toLowerCase()];
  return [];
}

/** undefined means unrestricted within the tenant; an empty array means nothing. */
function asIdList(raw: unknown): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v));
}
