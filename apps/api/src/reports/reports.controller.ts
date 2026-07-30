import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@Query('outletId') outletId?: string) {
    return this.reports.dashboard(outletId);
  }

  @Get('daily')
  @Roles('OWNER', 'MANAGER')
  daily(@Query('outletId') outletId: string, @Query('date') date: string) {
    return this.reports.daily(outletId, date ?? new Date().toISOString().slice(0, 10));
  }

  @Get('staff-sales')
  @Roles('OWNER', 'MANAGER')
  staffSales(@Query('date') date: string) {
    return this.reports.staffSales(date ?? new Date().toISOString().slice(0, 10));
  }
}
