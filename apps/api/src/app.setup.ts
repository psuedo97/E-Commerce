import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { uploadsDir } from './storage/storage.service';

/** Shared by main.ts and the e2e tests so the tests run against the real HTTP configuration. */
export function configureApp(app: NestExpressApplication) {
  // Images are loaded by the web app from another origin, so allow cross-origin embedding.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN, credentials: true });
  app.useStaticAssets(uploadsDir(), { prefix: '/uploads' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
