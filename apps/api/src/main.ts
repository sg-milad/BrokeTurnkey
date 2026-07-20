import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);

  const config = new DocumentBuilder()
    .setTitle('BrokeTurnkey API')
    .setDescription('The API documentation for BrokeTurnkey')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app as any, config);
  SwaggerModule.setup('docs', app as any, document);
  console.log("Swagger docs available at: http://localhost:3000/docs");
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
