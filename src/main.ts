import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './common/logger/winston.config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import session from 'express-session';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  // Enable validation pipe
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const configService = app.get(ConfigService);

  // Configure session middleware
  app.use(
    session({
      secret:
        configService.get<string>('SESSION_SECRET') ||
        'instadrop_secret_key_12345',
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 1 day
    }),
  );

  // Configure EJS view engine
  app.setBaseViewsDir(join(__dirname, 'admin', 'views'));
  app.setViewEngine('ejs');

  const port = configService.get<number>('PORT') || 3000;

  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
