import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ResponseInterceptor } from './response.interceptor';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api/v1');

  // Serve static uploaded media files
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
  });

  const allowedOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000']);
  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // Strip non-whitelisted properties
      transform: true,              // Auto-transform payloads to DTO instances
      forbidNonWhitelisted: false,  // Log warnings for unknown properties (set true in production)
      validateCustomDecorators: true, // Validate custom decorators
      stopAtFirstError: false,      // Show all errors at once
    }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());

  const port = process.env.PORT || 4000;
  await app.listen(port);
  console.log(`Backend running on port ${port} with prefix /api/v1`);
}
bootstrap();
