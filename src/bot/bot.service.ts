import { Injectable, OnModuleInit, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
import { YtDlpService } from '../download/yt-dlp.service';
import { DownloadQueueService } from '../download/download-queue.service';
import { RateLimiterService } from '../download/rate-limiter.service';
import { UsersService } from '../users/users.service';
import { cleanAndValidateInstagramUrl } from '../common/utils/url.validator';
import { createReadStream } from 'fs';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Telegraf<Context>;

  constructor(
    private configService: ConfigService,
    private ytDlpService: YtDlpService,
    private downloadQueueService: DownloadQueueService,
    private rateLimiterService: RateLimiterService,
    private usersService: UsersService,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('BOT_TOKEN');
    if (!token) {
      this.logger.error('BOT_TOKEN is not defined in config!');
      return;
    }

    this.bot = new Telegraf<Context>(token);
    this.setupHandlers();
    
    // Launch bot asynchronously
    this.bot.launch().then(() => {
      this.logger.log('Telegram Bot successfully launched.');
    }).catch(err => {
      this.logger.error('Failed to launch Telegram Bot:', err);
    });
  }

  onModuleDestroy() {
    if (this.bot) {
      this.bot.stop('SIGTERM');
      this.logger.log('Telegram Bot stopped.');
    }
  }

  private setupHandlers() {
    // Start command
    this.bot.start(async (ctx) => {
      try {
        const from = ctx.from;
        if (!from) return;
        await this.usersService.findOrCreateUser(from.id.toString(), from.username, from.first_name, from.last_name);

        const welcomeText = 
          `👋 Hello, ${from.first_name || 'there'}!\n\n` +
          `Welcome to **InstaDrop Bot** 🚀\n\n` +
          `Send me any Instagram URL (Reel, Post, Video, Photo, or Carousel) and I will download and send it back to you!\n\n` +
          `ℹ️ Use /help for instructions.\n` +
          `📊 Use /stats to see bot statistics.`;

        await ctx.replyWithMarkdown(welcomeText);
      } catch (err) {
        this.logger.error('Error handling /start command:', err);
      }
    });

    // Help command
    this.bot.help(async (ctx) => {
      const helpText = 
        `📖 **InstaDrop Bot Help Guide**\n\n` +
        `**How to use:**\n` +
        `1. Open Instagram and find the post, reel, or photo you want to download.\n` +
        `2. Copy the share link.\n` +
        `3. Paste and send the link to this bot.\n` +
        `4. Wait a few seconds for the media to be processed and sent back to you!\n\n` +
        `📊 /stats - View general usage and bot metrics.`;
      
      await ctx.replyWithMarkdown(helpText);
    });

    // Stats command
    this.bot.command('stats', async (ctx) => {
      try {
        const stats = await this.usersService.getStats();
        const statsText = 
          `📊 **InstaDrop Bot Statistics**\n\n` +
          `👥 **Total Users:** ${stats.totalUsers}\n` +
          `📥 **Total Downloads Processed:** ${stats.totalDownloads}\n` +
          `✅ **Successful Downloads:** ${stats.completedDownloads}\n` +
          `❌ **Failed Downloads:** ${stats.failedDownloads}`;
        
        await ctx.replyWithMarkdown(statsText);
      } catch (err) {
        this.logger.error('Error handling /stats command:', err);
        await ctx.reply('⚠️ Failed to load statistics. Please try again later.');
      }
    });

    // Handle text messages (look for Instagram URLs)
    this.bot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();
      const from = ctx.from;
      if (!from) return;

      const validatedUrl = cleanAndValidateInstagramUrl(text);
      if (!validatedUrl) {
        if (text.toLowerCase().includes('instagram.com') || text.startsWith('http')) {
          await ctx.reply('❌ Invalid Instagram URL. Please send a valid Post, Reel, or Carousel link.');
        }
        return;
      }

      const userIdStr = from.id.toString();

      // 1. Rate Limiting Check
      const rateLimitStatus = this.rateLimiterService.isRateLimited(userIdStr);
      if (rateLimitStatus.limited) {
        await ctx.reply(`⚠️ Too many requests. Please wait ${rateLimitStatus.retryAfterSeconds} seconds before sending another link.`);
        return;
      }

      // Upsert User
      await this.usersService.findOrCreateUser(userIdStr, from.username, from.first_name, from.last_name);

      // Send initial progress message to user
      const statusMessage = await ctx.reply('⏳ Adding your request to the download queue...');

      // 2. Add to Queue and Process
      const taskId = `dl_${userIdStr}_${Date.now()}`;
      const startTime = Date.now();
      
      this.downloadQueueService.add(taskId, async () => {
        // Update status to Downloading
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          '📥 Downloading media from Instagram...'
        ).catch(() => {});

        // Run download
        const downloadResult = await this.ytDlpService.downloadMedia(validatedUrl);
        
        // Update status to Uploading
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          '📤 Sending media to you...'
        ).catch(() => {});

        return downloadResult;
      })
      .then(async (result) => {
        const duration = Date.now() - startTime;
        const totalSize = result.files.reduce((sum, file) => sum + (file.size || 0), 0);

        // Send files to Telegram
        await this.sendMedia(ctx, result.files);

        // Delete status message
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});

        // Log success in DB
        await this.usersService.logDownload(
          userIdStr,
          validatedUrl,
          'COMPLETED',
          duration,
          totalSize,
          undefined,
          result.instagramAccount,
        );

        // Cleanup
        await this.ytDlpService.cleanupFolder(result.folderPath);
      })
      .catch(async (error: Error) => {
        const duration = Date.now() - startTime;
        // Determine user friendly error message
        let userMessage = '❌ An error occurred while downloading the media. Please try again.';
        if (error.message === 'PrivateAccount') {
          userMessage = '🔒 This Instagram post is from a private account. I cannot download private content.';
        } else if (error.message === 'ContentDeletedOrInvalid') {
          userMessage = '❌ The content has been deleted or the URL is invalid.';
        } else if (error.message === 'YtDlpNotInstalled') {
          userMessage = '⚠️ The server is missing the necessary media downloader dependencies (yt-dlp). Please make sure yt-dlp is installed and configured in your environment.';
        }

        // Update status message with error
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          userMessage
        ).catch(async () => {
          await ctx.reply(userMessage).catch(() => {});
        });

        // Log failure in DB
        await this.usersService.logDownload(userIdStr, validatedUrl, 'FAILED', duration, 0, error.message);
      });
    });
  }

  private async sendMedia(ctx: Context, files: any[]) {
    try {
      if (files.length === 1) {
        const file = files[0];
        const mediaSource = { source: createReadStream(file.filePath) };
        if (file.type === 'video') {
          await ctx.replyWithVideo(mediaSource);
        } else {
          await ctx.replyWithPhoto(mediaSource);
        }
      } else {
        // Send media group (carousel)
        const mediaGroup = files.map((file) => {
          return {
            type: file.type === 'video' ? 'video' : 'photo',
            media: { source: createReadStream(file.filePath) },
          };
        });

        await ctx.replyWithMediaGroup(mediaGroup as any);
      }
    } catch (err) {
      this.logger.error('Failed to send media files to user:', err);
      throw new Error('UploadFailed');
    }
  }
}
