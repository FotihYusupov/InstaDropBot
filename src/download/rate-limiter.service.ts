import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RateLimiterService {
  private requests = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(private configService: ConfigService) {
    this.limit = this.configService.get<number>('RATE_LIMIT_LIMIT') || 5;
    this.windowMs = this.configService.get<number>('RATE_LIMIT_WINDOW_MS') || 60000;
  }

  isRateLimited(userId: string): { limited: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    let userRequests = this.requests.get(userId) || [];
    
    // Filter out requests that are older than the sliding window
    userRequests = userRequests.filter((timestamp) => now - timestamp < this.windowMs);
    
    if (userRequests.length >= this.limit) {
      const oldestActive = userRequests[0];
      const msLeft = (oldestActive + this.windowMs) - now;
      return {
        limited: true,
        retryAfterSeconds: Math.ceil(msLeft / 1000),
      };
    }
    
    userRequests.push(now);
    this.requests.set(userId, userRequests);
    return { limited: false, retryAfterSeconds: 0 };
  }
}
