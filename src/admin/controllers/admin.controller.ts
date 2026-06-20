import { Controller, Get, Post, Body, Req, Res, UseGuards, Query, Param } from '@nestjs/common';
import * as express from 'express';
import { AdminService } from '../services/admin.service';
import { AdminGuard } from '../guards/admin.guard';
import { LoginDto } from '../dto/login.dto';
import { ConfigService } from '@nestjs/config';

// Extend Express Session type declaration local to the controller
declare module 'express-session' {
  interface SessionData {
    isAdmin?: boolean;
  }
}

@Controller('admin')
export class AdminController {
  constructor(
    private adminService: AdminService,
    private configService: ConfigService,
  ) {}

  @Get('login')
  getLogin(@Req() req: express.Request, @Res() res: express.Response) {
    if (req.session && req.session.isAdmin) {
      return res.redirect('/admin');
    }
    return res.render('login', { error: null });
  }

  @Post('login')
  postLogin(
    @Body() loginDto: LoginDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    const adminUser = this.configService.get<string>('ADMIN_USERNAME');
    const adminPass = this.configService.get<string>('ADMIN_PASSWORD');

    if (loginDto.username === adminUser && loginDto.password === adminPass) {
      req.session.isAdmin = true;
      return res.redirect('/admin');
    }

    return res.render('login', { error: 'Invalid username or password.' });
  }

  @Get('logout')
  logout(@Req() req: express.Request, @Res() res: express.Response) {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          this.logoutFallback(res);
        } else {
          res.redirect('/admin/login');
        }
      });
    } else {
      res.redirect('/admin/login');
    }
  }

  private logoutFallback(res: express.Response) {
    res.redirect('/admin/login');
  }

  @Get()
  @UseGuards(AdminGuard)
  async getDashboard(@Res() res: express.Response) {
    try {
      const kpis = await this.adminService.getDashboardKpis();
      const server = await this.adminService.getServerMonitoring();
      const charts = await this.adminService.getDashboardCharts();

      return res.render('dashboard', {
        kpis,
        server,
        charts,
        activePage: 'dashboard',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load dashboard: ${error.message}`);
    }
  }

  @Get('users')
  @UseGuards(AdminGuard)
  async getUsers(
    @Res() res: express.Response,
    @Query('page') page = 1,
    @Query('search') search?: string,
    @Query('sortBy') sortBy = 'createdAt',
    @Query('sortOrder') sortOrder: 'asc' | 'desc' = 'desc',
  ) {
    try {
      const limit = 10;
      const pageNum = Math.max(1, Number(page));
      const result = await this.adminService.getUsers(pageNum, limit, search, sortBy, sortOrder);

      return res.render('users', {
        ...result,
        search: search || '',
        sortBy,
        sortOrder,
        activePage: 'users',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load users: ${error.message}`);
    }
  }

  @Get('users/:telegramId')
  @UseGuards(AdminGuard)
  async getUserDetail(
    @Param('telegramId') telegramId: string,
    @Res() res: express.Response,
  ) {
    try {
      const result = await this.adminService.getUserDetail(telegramId);
      if (!result) {
        return res.redirect('/admin/users');
      }

      return res.render('user-detail', {
        ...result,
        activePage: 'users',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load user details: ${error.message}`);
    }
  }

  @Get('downloads')
  @UseGuards(AdminGuard)
  async getDownloads(
    @Res() res: express.Response,
    @Query('page') page = 1,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    try {
      const limit = 15;
      const pageNum = Math.max(1, Number(page));
      const result = await this.adminService.getDownloads(pageNum, limit, search, status, startDate, endDate);

      return res.render('downloads', {
        ...result,
        search: search || '',
        status: status || '',
        startDate: startDate || '',
        endDate: endDate || '',
        activePage: 'downloads',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load downloads list: ${error.message}`);
    }
  }

  @Get('stats')
  @UseGuards(AdminGuard)
  async getStats(@Res() res: express.Response) {
    try {
      const stats = await this.adminService.getAdvancedStats();
      return res.render('stats', {
        stats,
        activePage: 'stats',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load statistics: ${error.message}`);
    }
  }

  @Get('logs')
  @UseGuards(AdminGuard)
  async getLogs(
    @Res() res: express.Response,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ) {
    try {
      const logs = await this.adminService.getLogs(level, search);
      return res.render('logs', {
        logs,
        level: level || 'all',
        search: search || '',
        activePage: 'logs',
      });
    } catch (error) {
      return res.status(500).send(`Failed to load logs: ${error.message}`);
    }
  }

  @Get('logs/download')
  @UseGuards(AdminGuard)
  downloadLogs(@Res() res: express.Response) {
    try {
      const logPath = this.adminService.getCombinedLogPath();
      return res.download(logPath, 'combined.log');
    } catch (error) {
      return res.status(500).send(`Failed to download logs file: ${error.message}`);
    }
  }
}
