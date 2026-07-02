import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as https from 'https';

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
    this.downloadBaseDir =
      this.configService.get<string>('DOWNLOAD_DIR') || './temp_downloads';
    this.ytDlpPath = this.configService.get<string>('YT_DLP_PATH') || 'yt-dlp';
  }

  async onModuleInit() {
    try {
      const { stdout } = await execFilePromise(this.ytDlpPath, ['--version']);
      this.logger.log(
        `Using yt-dlp binary at "${this.ytDlpPath}" (version: ${stdout.trim()})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to verify yt-dlp executable at "${this.ytDlpPath}": ${err.message}`,
      );
    }
  }

  async downloadMedia(url: string): Promise<{
    folderPath: string;
    files: DownloadedMedia[];
    instagramAccount?: string;
    caption?: string;
  }> {
    const requestId = randomUUID();
    const folderPath = path.resolve(this.downloadBaseDir, requestId);

    // Create the unique temporary directory
    await fs.mkdir(folderPath, { recursive: true });

    // Output template for yt-dlp: e.g. 01-title.ext
    const outputTemplate = path.join(
      folderPath,
      '%(autonumber)02d-%(title).50s.%(ext)s',
    );

    this.logger.log(
      `Starting download for URL: ${url} to folder: ${folderPath}`,
    );

    // Handle cookies file if configured or if default cookies.txt exists in root
    const configCookies = this.configService.get<string>('YT_DLP_COOKIES_PATH');
    let cookiesFileToUse: string | null = null;

    if (configCookies) {
      const resolvedConfigCookies = path.resolve(configCookies);
      try {
        await fs.access(resolvedConfigCookies);
        cookiesFileToUse = resolvedConfigCookies;
      } catch {
        this.logger.warn(
          `Configured cookies file not found at: ${resolvedConfigCookies}`,
        );
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

    let useApiFallback = false;
    let ytDlpError: any = null;

    try {
      // yt-dlp arguments
      // --max-downloads 10: download max 10 files
      // --no-warnings: suppress warning messages
      const args = [
        '--no-warnings',
        '--max-downloads',
        '10',
        '--write-info-json',
        '-f',
        'mp4/best',
        '-o',
        outputTemplate,
      ];

      if (cookiesFileToUse) {
        this.logger.log(
          `Applying cookies file to download: ${cookiesFileToUse}`,
        );
        args.push('--cookies', cookiesFileToUse);
      }

      // Add URL as last argument
      args.push(url);

      this.logger.debug(`Executing: ${this.ytDlpPath} ${args.join(' ')}`);

      // Run yt-dlp with a 2 minutes timeout
      await execFilePromise(this.ytDlpPath, args, { timeout: 120000 });
    } catch (error: any) {
      ytDlpError = error;
      const errorMessage = error.stderr || error.message || '';
      this.logger.warn(
        `yt-dlp download failed for URL ${url}. Error: ${errorMessage}. Trying API fallback...`,
      );
      useApiFallback = true;
    }

    if (useApiFallback) {
      const apiSuccess = await this.downloadMediaViaApi(
        url,
        folderPath,
        cookiesFileToUse,
      );
      if (!apiSuccess) {
        // Clean up the folder immediately if download failed
        await this.cleanupFolder(folderPath);

        const errorMessage = ytDlpError.stderr || ytDlpError.message || '';
        // Handle specific error cases
        if (ytDlpError.code === 'ENOENT' || errorMessage.includes('ENOENT')) {
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
          throw new Error(
            `DownloadFailed: ${ytDlpError.message || 'unknown error'}`,
          );
        }
      }
    }

    try {
      // Read files in folderPath
      const dirContents = await fs.readdir(folderPath);
      const files: DownloadedMedia[] = [];
      let instagramAccount: string | undefined = undefined;
      let caption: string | undefined = undefined;

      for (const file of dirContents) {
        const filePath = path.join(folderPath, file);

        if (file.endsWith('.info.json')) {
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            instagramAccount =
              data.uploader || data.channel || data.uploader_id;
            if (!caption) {
              caption = data.description || data.title;
            }
          } catch (err: any) {
            this.logger.warn(
              `Failed to parse info.json at ${filePath}: ${err.message}`,
            );
          }
          continue; // Skip info.json from the media list
        }

        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          const ext = path.extname(file).toLowerCase();
          let type: 'photo' | 'video' | 'document' = 'document';

          if (['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext)) {
            type = 'photo';
          } else if (
            ['.mp4', '.mov', '.mkv', '.3gp', '.avi', '.webm'].includes(ext)
          ) {
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

      this.logger.log(
        `Successfully downloaded ${files.length} files for URL: ${url}`,
      );
      return { folderPath, files, instagramAccount, caption };
    } catch (error: any) {
      await this.cleanupFolder(folderPath);
      throw error;
    }
  }

  private async downloadMediaViaApi(
    url: string,
    folderPath: string,
    cookiesPath: string | null,
  ): Promise<boolean> {
    try {
      const shortcodeMatch = url.match(
        /(?:\/p\/|\/reel\/|\/tv\/|\/reels\/)([A-Za-z0-9-_]+)/,
      );
      if (!shortcodeMatch) {
        return false;
      }
      const shortcode = shortcodeMatch[1];
      const mediaId = this.shortcodeToMediaID(shortcode);
      const apiUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

      this.logger.log(
        `API Fallback: shortcode=${shortcode} mediaId=${mediaId}`,
      );

      let cookieHeader = '';
      if (cookiesPath) {
        try {
          const content = await fs.readFile(cookiesPath, 'utf8');
          const lines = content.split('\n');
          const cookiePairs: string[] = [];
          for (const line of lines) {
            if (!line.trim() || line.startsWith('#')) continue;
            const parts = line.split('\t');
            if (parts.length >= 7) {
              const domain = parts[0].trim();
              if (domain.includes('instagram.com')) {
                cookiePairs.push(`${parts[5].trim()}=${parts[6].trim()}`);
              }
            }
          }
          cookieHeader = cookiePairs.join('; ');
        } catch (err: any) {
          this.logger.warn(
            `Failed to read cookies in API fallback: ${err.message}`,
          );
        }
      }

      const headers: any = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
        'X-IG-App-ID': '936619743392459',
      };
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const rawData = await this.httpGet(apiUrl, headers);
      const parsed = JSON.parse(rawData);
      const media = parsed.items && parsed.items[0];
      if (!media) {
        throw new Error('No media item found in API response.');
      }

      const uploader = media.user?.username || media.owner?.username || '';
      const caption = media.caption?.text || '';

      const mediaToDownload: {
        url: string;
        ext: string;
        type: 'photo' | 'video';
      }[] = [];

      if (media.carousel_media) {
        media.carousel_media.forEach((item: any) => {
          if (item.media_type === 2 && item.video_versions) {
            mediaToDownload.push({
              url: item.video_versions[0].url,
              ext: 'mp4',
              type: 'video',
            });
          } else if (item.image_versions2) {
            mediaToDownload.push({
              url: item.image_versions2.candidates[0].url,
              ext: 'jpg',
              type: 'photo',
            });
          }
        });
      } else {
        if (media.media_type === 2 && media.video_versions) {
          mediaToDownload.push({
            url: media.video_versions[0].url,
            ext: 'mp4',
            type: 'video',
          });
        } else if (media.image_versions2) {
          mediaToDownload.push({
            url: media.image_versions2.candidates[0].url,
            ext: 'jpg',
            type: 'photo',
          });
        }
      }

      if (mediaToDownload.length === 0) {
        throw new Error('No downloadable images or videos found.');
      }

      await fs.mkdir(folderPath, { recursive: true });

      for (let i = 0; i < mediaToDownload.length; i++) {
        const item = mediaToDownload[i];
        const indexStr = String(i + 1).padStart(2, '0');
        const filename = `${indexStr}-media.${item.ext}`;
        const destPath = path.join(folderPath, filename);

        await this.downloadFile(item.url, destPath);
      }

      const infoJsonPath = path.join(folderPath, '00-metadata.info.json');
      const infoJsonContent = {
        uploader: uploader,
        description: caption,
      };
      await fs.writeFile(infoJsonPath, JSON.stringify(infoJsonContent), 'utf8');

      return true;
    } catch (err: any) {
      this.logger.error(`API fallback failed: ${err.message}`);
      return false;
    }
  }

  private shortcodeToMediaID(shortcode: string): string {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (let i = 0; i < shortcode.length; i++) {
      const char = shortcode[i];
      const index = BigInt(alphabet.indexOf(char));
      id = id * BigInt(64) + index;
    }
    return id.toString();
  }

  private httpGet(url: string, headers: any): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          let rawData = '';
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(
                new Error(`HTTP status code ${res.statusCode}: ${rawData}`),
              );
            } else {
              resolve(rawData);
            }
          });
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(destPath);
      https
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Failed to download file: status code ${res.statusCode}`,
              ),
            );
            return;
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          fs.unlink(destPath).catch(() => {});
          reject(err);
        });
    });
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
