import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Every non-2xx response carries the same envelope:
 *   { "error": { "code", "message", "details" } }
 * as specified in the architecture paper's API conventions.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let code = 'internal_error';
    let message = 'An unexpected error occurred.';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      code = codeFor(status);
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, any>;
        message = Array.isArray(b.message) ? 'Request validation failed.' : b.message ?? message;
        if (Array.isArray(b.message)) details = { violations: b.message };
        if (b.code) code = b.code;
      }
    } else {
      // Never leak an internal message or stack to the caller.
      this.logger.error(
        `Unhandled error on ${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({ error: { code, message, details } });
  }
}

function codeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST: return 'bad_request';
    case HttpStatus.UNAUTHORIZED: return 'unauthenticated';
    case HttpStatus.FORBIDDEN: return 'forbidden';
    case HttpStatus.NOT_FOUND: return 'not_found';
    case HttpStatus.CONFLICT: return 'conflict';
    case HttpStatus.UNPROCESSABLE_ENTITY: return 'unprocessable';
    case HttpStatus.TOO_MANY_REQUESTS: return 'rate_limited';
    default: return status >= 500 ? 'internal_error' : 'request_failed';
  }
}
