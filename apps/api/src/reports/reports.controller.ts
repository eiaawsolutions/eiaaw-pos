import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AuthGuard, Roles, requireOutletScope, resolveOutletScope } from '../common/auth.guard';

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private reports: ReportsService) {}

  // Takings are the most sensitive read in the system. Each of these resolves
  // the outlet through the caller's own scope; passing another outlet's id used
  // to be enough to see its day.
  @Get('dashboard')
  dashboard(@Query('outletId') outletId: string, @Req() req: any) {
    // Unscoped users may omit the outlet and see the whole business, which is
    // what an owner opens the dashboard for.
    return this.reports.dashboard(resolveOutletScope(req.user, outletId));
  }

  @Get('daily')
  @Roles('OWNER', 'MANAGER')
  daily(@Query('outletId') outletId: string, @Query('date') date: string, @Req() req: any) {
    return this.reports.daily(
      requireOutletScope(req.user, outletId),
      date ?? new Date().toISOString().slice(0, 10),
    );
  }

  @Get('staff-sales')
  @Roles('OWNER', 'MANAGER')
  staffSales(@Query('date') date: string, @Req() req: any) {
    return this.reports.staffSales(
      date ?? new Date().toISOString().slice(0, 10),
      resolveOutletScope(req.user, undefined),
    );
  }
}
