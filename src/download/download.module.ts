import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { YtDlpService } from './yt-dlp.service';
import { DownloadQueueService } from './download-queue.service';
import { RateLimiterService } from './rate-limiter.service';

@Module({
  imports: [ConfigModule],
  providers: [YtDlpService, DownloadQueueService, RateLimiterService],
  exports: [YtDlpService, DownloadQueueService, RateLimiterService],
})
export class DownloadModule {}
