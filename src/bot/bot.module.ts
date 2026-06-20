import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotService } from './bot.service';
import { DownloadModule } from '../download/download.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, DownloadModule, UsersModule],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
