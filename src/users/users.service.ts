import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { Download, DownloadDocument } from './schemas/download.schema';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Download.name) private downloadModel: Model<DownloadDocument>,
  ) {}

  async findOrCreateUser(
    telegramId: string,
    username?: string,
    firstName?: string,
    lastName?: string,
  ): Promise<UserDocument> {
    try {
      let user = await this.userModel.findOne({ telegramId }).exec();
      const now = new Date();
      if (!user) {
        user = new this.userModel({
          telegramId,
          username,
          firstName,
          lastName,
          lastActivityAt: now,
        });
        await user.save();
        this.logger.log(
          `Created new user: ${telegramId} (${username || 'no-username'})`,
        );
      } else {
        let changed = false;
        if (username && user.username !== username) {
          user.username = username;
          changed = true;
        }
        if (firstName && user.firstName !== firstName) {
          user.firstName = firstName;
          changed = true;
        }
        if (lastName && user.lastName !== lastName) {
          user.lastName = lastName;
          changed = true;
        }
        user.lastActivityAt = now;
        await user.save();
        if (changed) {
          this.logger.log(
            `Updated profile for user ${telegramId}: username=${username}, first=${firstName}, last=${lastName}`,
          );
        }
      }
      return user;
    } catch (error) {
      this.logger.error(`Error in findOrCreateUser for ${telegramId}:`, error);
      throw error;
    }
  }

  async logDownload(
    telegramId: string,
    url: string,
    status: string,
    duration?: number,
    fileSize?: number,
    errorMessage?: string,
    instagramAccount?: string,
  ): Promise<DownloadDocument> {
    try {
      const user = await this.findOrCreateUser(telegramId);
      const download = new this.downloadModel({
        userId: user._id,
        url,
        status,
        duration,
        fileSize,
        errorMessage,
        instagramAccount,
      });
      await download.save();
      this.logger.log(
        `Logged download for user ${telegramId}: URL=${url}, Status=${status}`,
      );
      return download;
    } catch (error) {
      this.logger.error(
        `Error logging download for user ${telegramId}:`,
        error,
      );
      throw error;
    }
  }

  async getStats(): Promise<{
    totalUsers: number;
    totalDownloads: number;
    completedDownloads: number;
    failedDownloads: number;
  }> {
    try {
      const totalUsers = await this.userModel.countDocuments().exec();
      const totalDownloads = await this.downloadModel.countDocuments().exec();
      const completedDownloads = await this.downloadModel
        .countDocuments({ status: 'COMPLETED' })
        .exec();
      const failedDownloads = await this.downloadModel
        .countDocuments({ status: 'FAILED' })
        .exec();
      return {
        totalUsers,
        totalDownloads,
        completedDownloads,
        failedDownloads,
      };
    } catch (error) {
      this.logger.error('Error fetching statistics:', error);
      throw error;
    }
  }
}
