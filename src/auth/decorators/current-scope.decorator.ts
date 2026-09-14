import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { REQUEST_SCOPE_KEY, RequestScope } from '../types/request-scope';

/** Injects the RequestScope the guard resolved. Throws if used on a public route. */
export const CurrentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestScope => {
    const scope = ctx.switchToHttp().getRequest()[REQUEST_SCOPE_KEY];
    if (!scope) {
      throw new InternalServerErrorException(
        'No request scope. @CurrentScope() was used on a route the guard did not authenticate.',
      );
    }
    return scope;
  },
);
