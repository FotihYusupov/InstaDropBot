import { Module } from '@nestjs/common';
import { AdminController } from './controllers/admin.controller';
import { AdminService } from './services/admin.service';
import { UsersModule } from '../users/users.module';
import { DownloadModule } from '../download/download.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [UsersModule, DownloadModule, BotModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
