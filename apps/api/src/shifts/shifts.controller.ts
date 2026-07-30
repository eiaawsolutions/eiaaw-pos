import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ShiftsService } from './shifts.service';
import { AuthGuard } from '../common/auth.guard';

@Controller('shifts')
@UseGuards(AuthGuard)
export class ShiftsController {
  constructor(private shifts: ShiftsService) {}

  @Post('open')
  open(@Body() body: { outletId: string; registerId: string; openingFloat: number }, @Req() req: any) {
    return this.shifts.open({ ...body, userId: req.user.sub });
  }

  @Post('close')
  close(@Body() body: { shiftId: string; closingCount: number }, @Req() req: any) {
    return this.shifts.close(body.shiftId, body.closingCount, req.user.sub);
  }

  @Post('cash-movement')
  cashMovement(@Body() body: { shiftId: string; type: string; amount: number; reason?: string }, @Req() req: any) {
    return this.shifts.cashMovement({ ...body, userId: req.user.sub });
  }

  @Get('current')
  current(@Query('registerId') registerId: string) {
    return this.shifts.current(registerId);
  }
}
