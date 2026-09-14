import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Capability, can } from '../capabilities';
import { REQUEST_SCOPE_KEY, RequestScope } from '../types/request-scope';

export const REQUIRES_KEY = 'ta:requires-capability';

/** Names the capability a route needs. The same list `/me/permissions` reports. */
export const Requires = (capability: Capability) => SetMetadata(REQUIRES_KEY, capability);

/**
 * Enforces `@Requires` (the server half of task P1-58).
 *
 * The UI reads its capabilities from `/me/permissions` and hides what it may not do.
 * That is a courtesy to the user, not a control — this guard is the control, and both
 * read the same table in `capabilities.ts`, so a screen can never grant itself
 * something the API would refuse.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability>(REQUIRES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const scope: RequestScope | undefined = ctx.switchToHttp().getRequest()?.[REQUEST_SCOPE_KEY];
    if (!scope) {
      // A route asked for a capability but nothing authenticated the caller. Refusing
      // is the only safe reading: the alternative is a public route quietly running
      // privileged work.
      throw new ForbiddenException('This route requires a capability and no scope was resolved.');
    }
    if (!can(scope, required)) {
      throw new ForbiddenException(`This action requires "${required}".`);
    }
    return true;
  }
}
