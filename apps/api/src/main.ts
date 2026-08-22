import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiModule } from './api.module';
import { LoggingInterceptor } from './common/logging.interceptor';
import { runWithRequestContext } from '@app/db';
import * as express from 'express';
import helmet from 'helmet';

async function bootstrap() {
  // bodyParser: false — we register express.json manually so the raw request
  // bytes can be captured for stamp verification (docs/STAMP_AUTH.md step 4).
  // The guard must hash exactly what the client signed, never a re-serialized
  // version of the parsed body.
  const app = await NestFactory.create(ApiModule, { bodyParser: false });

  // Capture per-request metadata (client IP, user agent) for consumers that
  // have no request object — e.g. AuditLogRepository populates
  // audit_log.ip_address / user_agent from this context. Must run first so
  // everything downstream (body parser, guards, services) is in scope.
  app.use(
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      runWithRequestContext(
        {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        next,
      );
    },
  );

  // Security headers (helmet). CSP is disabled: this is a JSON API whose
  // only browser surface is the Swagger UI in dev, which needs inline
  // scripts/styles — everything else (X-Content-Type-Options, framing,
  // referrer policy, HSTS) still applies.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(
    express.json({
      limit: '1mb',
      verify: (req: express.Request, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Global input validation — DTO decorators are enforced everywhere and
  // unknown properties are rejected (prevents mass-assignment).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global request/response logging for debugging and observability.
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Swagger is a development aid — never expose the API surface in prod.
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('BrokeTurnkey API')
      .setDescription('The API documentation for BrokeTurnkey')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
    console.log('Swagger docs available at: http://localhost:3000/docs');
  }

  const appConfig = app.get(ConfigService);
  await app.listen(appConfig.get<number>('app.port') ?? 3000);
}
void bootstrap();
