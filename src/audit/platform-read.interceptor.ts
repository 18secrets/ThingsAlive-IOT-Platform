import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { REQUEST_SCOPE_KEY, RequestScope } from '../auth/types/request-scope';
import { AuditService } from './audit.service';

/**
 * Records the requests a Things Alive role makes against tenant routes (P1-59).
 *
 * Only platform roles are recorded. Logging every tenant user's own reads would bury
 * the handful of records anyone will ever need to search, and a customer reading
 * their own data is not the question this log answers.
 *
 * Recorded after the handler succeeds, so a refused request is not filed as an
 * access that happened.
 */
@Injectable()
export class PlatformReadInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const scope: RequestScope | undefined = req?.[REQUEST_SCOPE_KEY];
    if (!scope?.isPlatformRole) return next.handle();

    const method = String(req.method ?? '');
    if (method !== 'GET') return next.handle();

    return next.handle().pipe(
      tap(() => {
        void this.audit.recordRouteRead(scope, {
          resource: `${ctx.getClass().name}.${ctx.getHandler().name}`,
          method,
          path: String(req.originalUrl ?? req.url ?? ''),
        });
      }),
    );
  }
}
