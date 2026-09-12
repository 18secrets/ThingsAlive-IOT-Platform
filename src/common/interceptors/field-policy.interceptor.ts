import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { REQUEST_SCOPE_KEY, RequestScope } from '../../auth/types/request-scope';
import { FIELD_POLICY_KEY, FieldPolicy, applyFieldPolicy } from '../field-policy';

/**
 * Applies each route's field policy to what it returns (task P1-55).
 *
 * Filtering happens on the way out, once, rather than in each handler. A handler that
 * assembles its own response and forgets to redact is the ordinary way this control
 * fails, and it fails silently — the data looks right to whoever wrote it, because
 * they have the role.
 */
@Injectable()
export class FieldPolicyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const policy = this.reflector.getAllAndOverride<FieldPolicy>(FIELD_POLICY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!policy) return next.handle();

    const scope: RequestScope | undefined = ctx.switchToHttp().getRequest()?.[REQUEST_SCOPE_KEY];
    // No scope means the route is public. A public route with a field policy would be
    // filtered against nothing, so it is filtered against everything.
    const effective: RequestScope = scope ?? ({ roles: [] } as unknown as RequestScope);

    return next.handle().pipe(map((body) => applyFieldPolicy(body, policy, effective)));
  }
}
