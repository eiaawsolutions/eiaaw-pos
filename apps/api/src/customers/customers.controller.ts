import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { AuthGuard } from '../common/auth.guard';

@Controller('customers')
@UseGuards(AuthGuard)
export class CustomersController {
  constructor(private customers: CustomersService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.customers.list(search);
  }

  @Post()
  create(@Body() body: { name: string; phone?: string; email?: string; pdpaConsent?: boolean }) {
    return this.customers.create(body);
  }

  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.customers.history(id);
  }
}
