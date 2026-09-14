import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule, AppOptions } from './app.module';
import { corsOrigins } from './config/env.validation';

export async function createApp(options: AppOptions = {}) {
  const app = await NestFactory.create(AppModule.register(options), { bufferLogs: false });
  const config = app.get(ConfigService);

  // Versioned from the first commit (task P0-01). There are no legacy callers to
  // keep compatible, so the prefix costs nothing now and cannot be added cheaply later.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // An explicit allowlist with no permissive fallback (task P0-11).
  const origins = corsOrigins(config.get<string>('CORS_ORIGINS'));
  app.enableCors({
    origin: origins.length ? origins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = await createApp();
  const config = app.get(ConfigService);

  const doc = new DocumentBuilder()
    .setTitle('Things Alive IoT Platform 2.0')
    .setDescription('Prediction scenarios, catalog, actions and integrations.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .addSecurityRequirements('bearer')
    .build();
  SwaggerModule.setup('api-docs', app, SwaggerModule.createDocument(app, doc), {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = Number(config.get('PORT') ?? 8080);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Platform 2.0 listening on ${await app.getUrl()}`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap();
}
