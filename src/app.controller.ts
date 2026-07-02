import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller()
export class AppController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get('health')
  getHealth() {
    const isDbConnected = this.connection.readyState === 1;

    if (!isDbConnected) {
      throw new HttpException(
        {
          status: 'ERROR',
          database: 'DISCONNECTED',
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      status: 'OK',
      database: 'CONNECTED',
      timestamp: new Date().toISOString(),
    };
  }
}
