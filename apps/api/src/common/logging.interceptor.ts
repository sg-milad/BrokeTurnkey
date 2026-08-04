import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, url, body, headers } = request;
    const timestamp = new Date().toISOString();

    // Log incoming request
    this.logger.log({
      type: 'REQUEST',
      timestamp,
      method,
      url,
      body: this.sanitizeBody(body),
      userAgent: headers['user-agent'],
      ip: request.ip,
    });

    const startTime = Date.now();

    return next.handle().pipe(
      tap((responseData) => {
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
          responseBody: this.sanitizeBody(responseData),
        });
      }),
    );
  }

  /**
   * Sanitize sensitive fields from logs (passwords, tokens, keys)
   */
  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;

    const sensitiveFields = [
      'password',
      'token',
      'secret',
      'apiKey',
      'api_key',
      'authorization',
      'privateKey',
      'private_key',
      'mnemonic',
      'seed',
    ];

    const sanitized = Array.isArray(body) ? [...body] : { ...body };

    for (const key of Object.keys(sanitized)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some((field) => lowerKey.includes(field.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeBody(sanitized[key]);
      }
    }

    return sanitized;
  }
}
