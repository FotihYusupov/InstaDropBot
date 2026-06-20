import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  BOT_TOKEN: string;

  @IsString()
  @IsNotEmpty()
  MONGO_URL: string;

  @IsNumber()
  PORT: number;

  @IsNumber()
  MAX_CONCURRENT_DOWNLOADS: number;

  @IsNumber()
  RATE_LIMIT_LIMIT: number;

  @IsNumber()
  RATE_LIMIT_WINDOW_MS: number;

  @IsString()
  DOWNLOAD_DIR: string;

  @IsString()
  YT_DLP_PATH: string;

  @IsString()
  @IsNotEmpty()
  ADMIN_USERNAME: string;

  @IsString()
  @IsNotEmpty()
  ADMIN_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  SESSION_SECRET: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(
    EnvironmentVariables,
    {
      ...config,
      // Provide sensible defaults if not defined
      PORT: config.PORT ? parseInt(config.PORT as string, 10) : 3000,
      MAX_CONCURRENT_DOWNLOADS: config.MAX_CONCURRENT_DOWNLOADS 
        ? parseInt(config.MAX_CONCURRENT_DOWNLOADS as string, 10) 
        : 2,
      RATE_LIMIT_LIMIT: config.RATE_LIMIT_LIMIT 
        ? parseInt(config.RATE_LIMIT_LIMIT as string, 10) 
        : 5,
      RATE_LIMIT_WINDOW_MS: config.RATE_LIMIT_WINDOW_MS 
        ? parseInt(config.RATE_LIMIT_WINDOW_MS as string, 10) 
        : 60000,
      DOWNLOAD_DIR: config.DOWNLOAD_DIR || './temp_downloads',
      MONGO_URL: config.MONGO_URL || 'mongodb://localhost:27017/instadrop',
      YT_DLP_PATH: config.YT_DLP_PATH || 'yt-dlp',
      ADMIN_USERNAME: config.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD: config.ADMIN_PASSWORD || 'admin',
      SESSION_SECRET: config.SESSION_SECRET || 'instadrop_secret_key_12345',
    },
    { enableImplicitConversion: true }
  );

  const errors = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(`Config validation error: ${errors.toString()}`);
  }
  return validatedConfig;
}
