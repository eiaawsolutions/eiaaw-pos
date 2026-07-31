import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ShiftsService } from './shifts.service';
import { AuthGuard, requireOutletScope } from '../common/auth.guard';

@Controller('shifts')
@UseGuards(AuthGuard)
export class ShiftsController {
  constructor(private shifts: ShiftsService) {}

  @Post('open')
  open(@Body() body: { outletId: string; registerId: string; openingFloat: number }, @Req() req: any) {
    // A till belongs to an outlet, so opening one at somebody else's is not a
    // thing a pinned user gets to do by naming it in the body.
    return this.shifts.open({
      ...body,
      outletId: requireOutletScope(req.user, body?.outletId),
      userId: req.user.sub,
    });
  }

  @Post('close')
  close(@Body() body: { shiftId: string; closingCount: number }, @Req() req: any) {
    return this.shifts.close(body.shiftId, body.closingCount, req.user.sub);
  }

  @Post('cash-movement')
  cashMovement(
    @Body() body: { shiftId: string; type: string; amount: number; reason?: string },
    @Req() req: any,
  ) {
    return this.shifts.cashMovement({ ...body, userId: req.user.sub });
  }

  @Get('current')
  current(@Query('registerId') registerId: string) {
    return this.shifts.current(registerId);
  }
}
