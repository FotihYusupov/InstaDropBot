import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface QueueItem {
  id: string;
  task: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

@Injectable()
export class DownloadQueueService {
  private readonly logger = new Logger(DownloadQueueService.name);
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private readonly maxConcurrency: number;

  constructor(private configService: ConfigService) {
    this.maxConcurrency =
      this.configService.get<number>('MAX_CONCURRENT_DOWNLOADS') || 2;
  }

  async add<T>(id: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id, task, resolve, reject });
      this.logger.log(
        `Task ${id} added to download queue. Queue size: ${this.queue.length}`,
      );
      this.processQueue();
    });
  }

  private processQueue() {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    this.logger.log(
      `Processing task ${item.id} from queue. Active: ${this.activeCount}, Queue size: ${this.queue.length}`,
    );

    item
      .task()
      .then((res) => {
        item.resolve(res);
      })
      .catch((err) => {
        item.reject(err);
      })
      .finally(() => {
        this.activeCount--;
        this.logger.log(
          `Finished task ${item.id}. Active: ${this.activeCount}`,
        );
        this.processQueue();
      });
  }

  getQueueSize(): number {
    return this.queue.length + this.activeCount;
  }
}
