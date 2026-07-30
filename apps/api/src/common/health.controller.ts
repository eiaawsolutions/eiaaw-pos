import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true, service: 'eiaaw-pos-api', ts: new Date().toISOString() };
  }
}
