import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiModule } from './api.module';
import { LoggingInterceptor } from './common/logging.interceptor';
import * as express from 'express';

async function bootstrap() {
  // bodyParser: false — we register express.json manually so the raw request
  // bytes can be captured for stamp verification (docs/STAMP_AUTH.md step 4).
  // The guard must hash exactly what the client signed, never a re-serialized
  // version of the parsed body.
  const app = await NestFactory.create(ApiModule, { bodyParser: false });

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
