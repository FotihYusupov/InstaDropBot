import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const execFilePromise = promisify(execFile);

export interface DownloadedMedia {
  filePath: string;
  type: 'photo' | 'video' | 'document';
  filename: string;
  size: number;
}

@Injectable()
export class YtDlpService implements OnModuleInit {
  private readonly logger = new Logger(YtDlpService.name);
  private readonly downloadBaseDir: string;
  private readonly ytDlpPath: string;

  constructor(private configService: ConfigService) {
    this.downloadBaseDir = this.configService.get<string>('DOWNLOAD_DIR') || './temp_downloads';
    this.ytDlpPath = this.configService.get<string>('YT_DLP_PATH') || 'yt-dlp';
  }

  async onModuleInit() {
    try {
      const { stdout } = await execFilePromise(this.ytDlpPath, ['--version']);
      this.logger.log(`Using yt-dlp binary at "${this.ytDlpPath}" (version: ${stdout.trim()})`);
    } catch (err: any) {
      this.logger.error(`Failed to verify yt-dlp executable at "${this.ytDlpPath}": ${err.message}`);
    }
  }

  async downloadMedia(url: string): Promise<{ folderPath: string; files: DownloadedMedia[]; instagramAccount?: string }> {
    const requestId = randomUUID();
    const folderPath = path.resolve(this.downloadBaseDir, requestId);

    // Create the unique temporary directory
    await fs.mkdir(folderPath, { recursive: true });

    // Output template for yt-dlp: e.g. 01-title.ext
    const outputTemplate = path.join(folderPath, '%(autonumber)02d-%(title).50s.%(ext)s');

    this.logger.log(`Starting download for URL: ${url} to folder: ${folderPath}`);

    try {
      // yt-dlp arguments
      // --max-downloads 10: download max 10 files
      // --no-warnings: suppress warning messages
      const args = [
        '--no-warnings',
        '--max-downloads', '10',
        '--write-info-json',
        '--no-playlist',
        '-f', 'mp4/best',
        '-o', outputTemplate,
      ];

      // Handle cookies file if configured or if default cookies.txt exists in root
      const configCookies = this.configService.get<string>('YT_DLP_COOKIES_PATH');
      let cookiesFileToUse: string | null = null;

      if (configCookies) {
        const resolvedConfigCookies = path.resolve(configCookies);
        try {
          await fs.access(resolvedConfigCookies);
          cookiesFileToUse = resolvedConfigCookies;
        } catch {
          this.logger.warn(`Configured cookies file not found at: ${resolvedConfigCookies}`);
        }
      }

      if (!cookiesFileToUse) {
        // Fallback to checking default cookies.txt in the root of the project
        const defaultCookies = path.resolve('cookies.txt');
        try {
          await fs.access(defaultCookies);
          cookiesFileToUse = defaultCookies;
        } catch {
          // No cookies file found, continue without --cookies
        }
      }

      if (cookiesFileToUse) {
        this.logger.log(`Applying cookies file to download: ${cookiesFileToUse}`);
        args.push('--cookies', cookiesFileToUse);
      }

      // Add URL as last argument
      args.push(url);

      this.logger.debug(`Executing: ${this.ytDlpPath} ${args.join(' ')}`);

      // Run yt-dlp with a 2 minutes timeout
      await execFilePromise(this.ytDlpPath, args, { timeout: 120000 });

      // Read files in folderPath
      const dirContents = await fs.readdir(folderPath);
      const files: DownloadedMedia[] = [];
      let instagramAccount: string | undefined = undefined;

      for (const file of dirContents) {
        const filePath = path.join(folderPath, file);
        
        if (file.endsWith('.info.json')) {
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            instagramAccount = data.uploader || data.channel || data.uploader_id;
          } catch (err) {
            this.logger.warn(`Failed to parse info.json at ${filePath}: ${err.message}`);
          }
          continue; // Skip info.json from the media list
        }

        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          const ext = path.extname(file).toLowerCase();
          let type: 'photo' | 'video' | 'document' = 'document';

          if (['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext)) {
            type = 'photo';
          } else if (['.mp4', '.mov', '.mkv', '.3gp', '.avi', '.webm'].includes(ext)) {
            type = 'video';
          }

          files.push({
            filePath,
            type,
            filename: file,
            size: stat.size,
          });
        }
      }

      // Sort files by filename so carousel items remain in order (autonumber ensures this)
      files.sort((a, b) => a.filename.localeCompare(b.filename));

      if (files.length === 0) {
        throw new Error('No media files found after download.');
      }

      this.logger.log(`Successfully downloaded ${files.length} files for URL: ${url}`);
      return { folderPath, files, instagramAccount };

    } catch (error: any) {
      // Clean up the folder immediately if download failed
      await this.cleanupFolder(folderPath);

      const errorMessage = error.stderr || error.message || '';
      this.logger.error(`yt-dlp download failed for URL ${url}. Error: ${errorMessage}`);

      // Handle specific error cases
      if (error.code === 'ENOENT' || errorMessage.includes('ENOENT')) {
        throw new Error('YtDlpNotInstalled');
      } else if (
        errorMessage.includes('Private video') || 
        errorMessage.includes('login') || 
        errorMessage.includes('Sign in') || 
        errorMessage.includes('profile is private')
      ) {
        throw new Error('PrivateAccount');
      } else if (
        errorMessage.includes('404') || 
        errorMessage.includes('Not Found') || 
        errorMessage.includes('does not exist') || 
        errorMessage.includes('Unavailable')
      ) {
        throw new Error('ContentDeletedOrInvalid');
      } else {
        throw new Error(`DownloadFailed: ${error.message || 'unknown error'}`);
      }
    }
  }

  async cleanupFolder(folderPath: string): Promise<void> {
    try {
      await fs.rm(folderPath, { recursive: true, force: true });
      this.logger.log(`Cleaned up folder: ${folderPath}`);
    } catch (error) {
      this.logger.error(`Failed to clean up folder ${folderPath}:`, error);
    }
  }
}
