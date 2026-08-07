import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

/**
 * Recursively sanitize sensitive fields from an unknown value.
 * Returns a safe-to-log copy with passwords/tokens/keys redacted.
 */
function sanitizeForLog(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'apikey',
    'api_key',
    'authorization',
    'privatekey',
    'private_key',
    'publickey',
    'public_key',
    'mnemonic',
    'seed',
    'encrypted',
    'dek',
    'bootstrap',
    'nonce',
  ];

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some((field) => lowerKey.includes(field))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitizeForLog(val);
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const method: string = request.method;
    const url: string = request.url;
    const body: unknown = request.body;
    const headers = request.headers;
    const timestamp = new Date().toISOString();

    // Log incoming request
    this.logger.log({
      type: 'REQUEST',
      timestamp,
      method,
      url,
      body: sanitizeForLog(body),
      userAgent: headers['user-agent'],
      ip: request.ip,
    });

    const startTime = Date.now();

    return next.handle().pipe(
      tap((responseData: unknown) => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;

        // Log outgoing response
        this.logger.log({
          type: 'RESPONSE',
          timestamp: new Date().toISOString(),
          method,
          url,
          statusCode,
          duration: `${duration}ms`,
          responseBody: sanitizeForLog(responseData),
        });
      }),
    );
  }
}
