import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';
import {
  Download,
  DownloadDocument,
} from '../../users/schemas/download.schema';
import { DownloadQueueService } from '../../download/download-queue.service';
import { BotService } from '../../bot/bot.service';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private lastCpuTicks = { idle: 0, total: 0 };

  private broadcastStatus = {
    active: false,
    totalUsers: 0,
    processedUsers: 0,
    successCount: 0,
    failedCount: 0,
    startedAt: null as Date | null,
    finishedAt: null as Date | null,
    message: '',
    parseMode: 'none' as 'Markdown' | 'HTML' | 'none',
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Download.name) private downloadModel: Model<DownloadDocument>,
    private downloadQueueService: DownloadQueueService,
    private botService: BotService,
    @InjectConnection() private readonly connection: Connection,
  ) {
    this.getCpuUsagePercent(); // Warm up ticks
  }

  // ==========================================
  // DASHBOARD KPIS & STATS
  // ==========================================

  async getDashboardKpis() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalDownloads,
      downloadsToday,
      downloadsThisWeek,
      downloadsThisMonth,
      successfulDownloads,
      failedDownloads,
      activeUsersToday,
      activeUsersThisWeek,
      avgProcessingTimeResult,
    ] = await Promise.all([
      this.userModel.countDocuments().exec(),
      this.downloadModel.countDocuments().exec(),
      this.downloadModel.countDocuments({ createdAt: { $gte: today } }).exec(),
      this.downloadModel
        .countDocuments({ createdAt: { $gte: startOfWeek } })
        .exec(),
      this.downloadModel
        .countDocuments({ createdAt: { $gte: startOfMonth } })
        .exec(),
      this.downloadModel.countDocuments({ status: 'COMPLETED' }).exec(),
      this.downloadModel.countDocuments({ status: 'FAILED' }).exec(),
      this.userModel.countDocuments({ lastActivityAt: { $gte: today } }).exec(),
      this.userModel
        .countDocuments({ lastActivityAt: { $gte: startOfWeek } })
        .exec(),
      this.downloadModel
        .aggregate([
          {
            $match: {
              status: 'COMPLETED',
              duration: { $exists: true, $ne: null },
            },
          },
          { $group: { _id: null, avg: { $avg: '$duration' } } },
        ])
        .exec(),
    ]);

    const queueSize = this.downloadQueueService.getQueueSize();
    const avgDurationMs = avgProcessingTimeResult[0]?.avg || 0;
    const avgDurationSeconds = Math.round(avgDurationMs / 100) / 10;

    return {
      totalUsers,
      totalDownloads,
      downloadsToday,
      downloadsThisWeek,
      downloadsThisMonth,
      successfulDownloads,
      failedDownloads,
      activeUsersToday,
      activeUsersThisWeek,
      queueSize,
      avgDownloadProcessingTime: `${avgDurationSeconds}s`,
    };
  }

  async getDashboardCharts() {
    const { downloadsTrend, usersTrend } = await this.getDailyTrends(30);
    const downloads30 = this.fillMissingDates(downloadsTrend, 30, {
      count: 0,
      completed: 0,
      failed: 0,
    });
    const users30 = this.fillMissingDates(usersTrend, 30, { count: 0 });

    const [completedTotal, failedTotal] = await Promise.all([
      this.downloadModel.countDocuments({ status: 'COMPLETED' }).exec(),
      this.downloadModel.countDocuments({ status: 'FAILED' }).exec(),
    ]);

    return {
      downloads30,
      users30,
      pieData: {
        completed: completedTotal,
        failed: failedTotal,
      },
    };
  }

  private async getDailyTrends(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    startDate.setHours(0, 0, 0, 0);

    const downloadsTrend = await this.downloadModel
      .aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
            },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();

    const usersTrend = await this.userModel
      .aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();

    return { downloadsTrend, usersTrend };
  }

  private fillMissingDates(data: any[], daysCount = 30, defaultValue: any) {
    const result = [];
    const map = new Map(data.map((item) => [item._id, item]));

    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      if (map.has(dateStr)) {
        result.push(map.get(dateStr));
      } else {
        result.push({ _id: dateStr, ...defaultValue });
      }
    }
    return result;
  }

  // ==========================================
  // USERS PAGE LOGIC
  // ==========================================

  async getUsers(
    page: number,
    limit: number,
    search?: string,
    sortBy = 'createdAt',
    sortOrder: 'asc' | 'desc' = 'desc',
  ) {
    const skip = (page - 1) * limit;
    const matchStage: any = {};

    if (search) {
      matchStage.$or = [
        { telegramId: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
      ];
    }

    const sortFieldMap: Record<string, string> = {
      createdAt: 'createdAt',
      lastActivityAt: 'lastActivityAt',
      telegramId: 'telegramId',
      totalDownloads: 'totalDownloads',
    };

    const dbSortField = sortFieldMap[sortBy] || 'createdAt';
    const dbSortOrder = sortOrder === 'asc' ? 1 : -1;

    // Use aggregation to fetch paginated users combined with their download counts
    const aggregationPipeline: any[] = [
      { $match: matchStage },
      {
        $lookup: {
          from: 'downloads',
          localField: '_id',
          foreignField: 'userId',
          as: 'downloads',
        },
      },
      {
        $addFields: {
          totalDownloads: { $size: '$downloads' },
          successCount: {
            $size: {
              $filter: {
                input: '$downloads',
                as: 'd',
                cond: { $eq: ['$$d.status', 'COMPLETED'] },
              },
            },
          },
          failedCount: {
            $size: {
              $filter: {
                input: '$downloads',
                as: 'd',
                cond: { $eq: ['$$d.status', 'FAILED'] },
              },
            },
          },
        },
      },
      { $project: { downloads: 0 } }, // Reduce payload
      { $sort: { [dbSortField]: dbSortOrder } },
      { $skip: skip },
      { $limit: limit },
    ];

    const [users, totalCount] = await Promise.all([
      this.userModel.aggregate(aggregationPipeline).exec(),
      this.userModel.countDocuments(matchStage).exec(),
    ]);

    return {
      users,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page,
    };
  }

  // ==========================================
  // USER DETAIL PAGE LOGIC
  // ==========================================

  async getUserDetail(telegramId: string) {
    const user = await this.userModel.findOne({ telegramId }).exec();
    if (!user) {
      return null;
    }

    const [downloads, topAccounts, statsResult] = await Promise.all([
      // Last 50 downloads
      this.downloadModel
        .find({ userId: user._id as any })
        .sort({ createdAt: -1 })
        .limit(50)
        .exec(),
      // Top 5 most downloaded accounts
      this.downloadModel
        .aggregate([
          {
            $match: {
              userId: user._id,
              instagramAccount: { $exists: true, $ne: null },
            },
          },
          { $group: { _id: '$instagramAccount', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ])
        .exec(),
      // Download aggregates
      this.downloadModel
        .aggregate([
          { $match: { userId: user._id } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              success: {
                $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
              },
              failed: {
                $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] },
              },
              avgDuration: { $avg: '$duration' },
            },
          },
        ])
        .exec(),
    ]);

    const stats = statsResult[0] || {
      total: 0,
      success: 0,
      failed: 0,
      avgDuration: 0,
    };
    const successRate =
      stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;

    return {
      user,
      downloads,
      topAccounts,
      stats: {
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        successRate,
        avgDurationSeconds: stats.avgDuration
          ? Math.round(stats.avgDuration / 100) / 10
          : 0,
      },
    };
  }

  // ==========================================
  // DOWNLOADS PAGE LOGIC
  // ==========================================

  async getDownloads(
    page: number,
    limit: number,
    search?: string,
    status?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const skip = (page - 1) * limit;
    const query: any = {};

    if (status) {
      query.status = status;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Extend to end of the day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    let userMatchIds: Types.ObjectId[] = [];
    if (search) {
      // Find matching users first
      const users = await this.userModel
        .find({
          $or: [
            { telegramId: { $regex: search, $options: 'i' } },
            { username: { $regex: search, $options: 'i' } },
            { firstName: { $regex: search, $options: 'i' } },
            { lastName: { $regex: search, $options: 'i' } },
          ],
        })
        .select('_id')
        .exec();

      userMatchIds = users.map((u) => u._id as Types.ObjectId);

      query.$or = [
        { url: { $regex: search, $options: 'i' } },
        { instagramAccount: { $regex: search, $options: 'i' } },
      ];

      if (userMatchIds.length > 0) {
        query.$or.push({ userId: { $in: userMatchIds } });
      }
    }

    const [downloads, totalCount] = await Promise.all([
      this.downloadModel
        .find(query)
        .populate('userId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.downloadModel.countDocuments(query).exec(),
    ]);

    return {
      downloads,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page,
    };
  }

  // ==========================================
  // STATISTICS PAGE LOGIC
  // ==========================================

  async getAdvancedStats() {
    const [
      topUsers,
      topInstagramAccounts,
      topUrls,
      avgFileSizeResult,
      avgDurationResult,
      downloadsByHourTrend,
      downloadsByWeekdayTrend,
    ] = await Promise.all([
      // Top 20 users
      this.downloadModel
        .aggregate([
          {
            $group: {
              _id: '$userId',
              count: { $sum: 1 },
              successCount: {
                $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
              },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 20 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'user',
            },
          },
          { $unwind: '$user' },
        ])
        .exec(),
      // Top downloaded Instagram accounts
      this.downloadModel
        .aggregate([
          { $match: { instagramAccount: { $exists: true, $ne: null } } },
          { $group: { _id: '$instagramAccount', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ])
        .exec(),
      // Top downloaded URLs
      this.downloadModel
        .aggregate([
          { $group: { _id: '$url', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ])
        .exec(),
      // Average file size (completed)
      this.downloadModel
        .aggregate([
          {
            $match: {
              status: 'COMPLETED',
              fileSize: { $exists: true, $ne: null },
            },
          },
          { $group: { _id: null, avgSize: { $avg: '$fileSize' } } },
        ])
        .exec(),
      // Average duration (completed)
      this.downloadModel
        .aggregate([
          {
            $match: {
              status: 'COMPLETED',
              duration: { $exists: true, $ne: null },
            },
          },
          { $group: { _id: null, avgDuration: { $avg: '$duration' } } },
        ])
        .exec(),
      // Downloads by hour (distribution 0-23)
      this.downloadModel
        .aggregate([
          {
            $project: {
              hour: {
                $hour: { date: '$createdAt', timezone: 'Asia/Tashkent' },
              }, // Use local timezone if preferred
            },
          },
          { $group: { _id: '$hour', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      // Downloads by weekday (distribution 1-7, 1=Sunday)
      this.downloadModel
        .aggregate([
          {
            $project: {
              day: {
                $dayOfWeek: { date: '$createdAt', timezone: 'Asia/Tashkent' },
              },
            },
          },
          { $group: { _id: '$day', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
    ]);

    const avgFileSize = avgFileSizeResult[0]?.avgSize || 0;
    const avgDuration = avgDurationResult[0]?.avgDuration || 0;

    // Format distributions to have full hours and weekdays filled
    const hours = Array.from({ length: 24 }, (_, i) => {
      const match = downloadsByHourTrend.find((h) => h._id === i);
      return { hour: i, count: match ? match.count : 0 };
    });

    const weekdaysNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    const weekdays = Array.from({ length: 7 }, (_, i) => {
      const match = downloadsByWeekdayTrend.find((w) => w._id === i + 1);
      return { day: weekdaysNames[i], count: match ? match.count : 0 };
    });

    return {
      topUsers,
      topInstagramAccounts,
      topUrls,
      avgFileSizeFormatted: this.formatBytes(avgFileSize),
      avgProcessingTimeSeconds: Math.round(avgDuration / 100) / 10,
      hours,
      weekdays,
    };
  }

  // ==========================================
  // SERVER MONITORING LOGIC
  // ==========================================

  async getServerMonitoring() {
    const uptimeSeconds = os.uptime();
    const processUptimeSeconds = process.uptime();

    // RAM calculation
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramUsagePercent = Math.round((usedMem / totalMem) * 100);

    // Node memory usage
    const memUsage = process.memoryUsage();
    const nodeHeapUsed = memUsage.heapUsed;
    const nodeRss = memUsage.rss;

    // CPU calculation
    const cpuUsagePercent = this.getCpuUsagePercent();

    // Disk usage (Node 18.15.0+)
    let diskStats = {
      total: '0 GB',
      free: '0 GB',
      used: '0 GB',
      usagePercent: 0,
    };
    try {
      const disk = await fs.promises.statfs('.');
      const totalDisk = disk.blocks * disk.bsize;
      const freeDisk = disk.bfree * disk.bsize;
      const usedDisk = totalDisk - freeDisk;
      const diskUsagePercent = Math.round((usedDisk / totalDisk) * 100);
      diskStats = {
        total: this.formatBytes(totalDisk),
        free: this.formatBytes(freeDisk),
        used: this.formatBytes(usedDisk),
        usagePercent: diskUsagePercent,
      };
    } catch (e) {
      this.logger.warn(`Failed to read disk stats: ${e.message}`);
    }

    return {
      cpuUsage: `${cpuUsagePercent}%`,
      ramUsagePercent,
      ramFormatted: {
        total: this.formatBytes(totalMem),
        used: this.formatBytes(usedMem),
        free: this.formatBytes(freeMem),
      },
      nodeHeapUsed: this.formatBytes(nodeHeapUsed),
      nodeRss: this.formatBytes(nodeRss),
      disk: diskStats,
      systemUptime: this.formatUptime(uptimeSeconds),
      processUptime: this.formatUptime(processUptimeSeconds),
      nodeVersion: process.version,
      mongoStatus:
        this.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
      osType: `${os.type()} ${os.arch()}`,
    };
  }

  private getCpuUsagePercent(): number {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type as keyof typeof cpu.times];
      }
      idle += cpu.times.idle;
    }

    const diffIdle = idle - this.lastCpuTicks.idle;
    const diffTotal = total - this.lastCpuTicks.total;
    this.lastCpuTicks = { idle, total };

    if (diffTotal === 0) return 0;
    return Math.round((1 - diffIdle / diffTotal) * 100);
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  private formatBytes(bytes: number, decimals = 2): string {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // ==========================================
  // LOGS LOGIC
  // ==========================================

  async getLogs(level?: string, search?: string, limit = 500): Promise<any[]> {
    const combinedLogPath = path.resolve('logs/combined.log');
    if (!fs.existsSync(combinedLogPath)) {
      return [];
    }

    const fileStream = fs.createReadStream(combinedLogPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const parsedLogs: any[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // Filter by Level
        if (
          level &&
          level.toLowerCase() !== 'all' &&
          parsed.level !== level.toLowerCase()
        ) {
          continue;
        }
        // Filter by Search Query
        if (search) {
          const query = search.toLowerCase();
          const message = (parsed.message || '').toLowerCase();
          const context = (parsed.context || '').toLowerCase();
          if (!message.includes(query) && !context.includes(query)) {
            continue;
          }
        }
        parsedLogs.push(parsed);
      } catch (err) {
        // If not JSON, parse as a raw log line
        if (!level || level.toLowerCase() === 'all') {
          const query = (search || '').toLowerCase();
          if (!query || line.toLowerCase().includes(query)) {
            parsedLogs.push({
              timestamp: new Date().toISOString(),
              level: line.toLowerCase().includes('error') ? 'error' : 'info',
              message: line,
              context: 'RawLog',
            });
          }
        }
      }
    }

    // Return descending (newest logs first) and slice by limit
    return parsedLogs.reverse().slice(0, limit);
  }

  getCombinedLogPath(): string {
    return path.resolve('logs/combined.log');
  }

  getBroadcastStatus() {
    return this.broadcastStatus;
  }

  async startBroadcast(
    message: string,
    parseMode: 'Markdown' | 'HTML' | 'none',
  ): Promise<void> {
    if (this.broadcastStatus.active) {
      throw new Error('A broadcast is already in progress.');
    }

    this.broadcastStatus = {
      active: true,
      totalUsers: 0,
      processedUsers: 0,
      successCount: 0,
      failedCount: 0,
      startedAt: new Date(),
      finishedAt: null,
      message,
      parseMode,
    };

    // Run in background asynchronously
    this.runBroadcastInBackground(message, parseMode).catch((err) => {
      this.logger.error('Error in background broadcast:', err);
      this.broadcastStatus.active = false;
      this.broadcastStatus.finishedAt = new Date();
    });
  }

  private async runBroadcastInBackground(
    message: string,
    parseMode: 'Markdown' | 'HTML' | 'none',
  ): Promise<void> {
    const users = await this.userModel.find({}, 'telegramId').exec();
    this.broadcastStatus.totalUsers = users.length;

    const mode = parseMode === 'none' ? undefined : parseMode;

    for (const user of users) {
      if (!this.broadcastStatus.active) {
        break;
      }

      try {
        await this.botService.sendMessage(user.telegramId, message, mode);
        this.broadcastStatus.successCount++;
      } catch (err: any) {
        this.logger.warn(
          `Failed to send broadcast message to ${user.telegramId}: ${err.message}`,
        );
        this.broadcastStatus.failedCount++;
      }

      this.broadcastStatus.processedUsers++;

      // Wait 35ms between messages to stay safe within Telegram's limit (30 messages/sec)
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    this.broadcastStatus.active = false;
    this.broadcastStatus.finishedAt = new Date();
    this.logger.log(
      `Broadcast completed. Success: ${this.broadcastStatus.successCount}, Failed: ${this.broadcastStatus.failedCount}, Total: ${this.broadcastStatus.totalUsers}`,
    );
  }
}
