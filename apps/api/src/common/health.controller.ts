import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness and readiness are deliberately different endpoints.
 *
 * The previous single endpoint returned {ok:true} unconditionally, which is
 * worse than having none: an instance that had lost its database still
 * reported healthy, so the load balancer kept sending sales to a process that
 * could not record them.
 *
 *   /api/health/live   is the process running? Restart it if not.
 *   /api/health        can it actually serve? Take it out of rotation if not.
 */
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private indicator: HealthIndicatorService,
    private prisma: PrismaService,
  ) {}

  /** Readiness — checked by the load balancer and the container healthcheck. */
  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([() => this.database()]);
  }

  /**
   * Liveness — intentionally checks nothing external. A database outage must
   * not cause the orchestrator to restart every replica, which turns a
   * recoverable dependency failure into a full outage.
   */
  @Get('live')
  live() {
    return { status: 'ok', service: 'eiaaw-pos-api', uptime: Math.round(process.uptime()) };
  }

  private async database() {
    const key = 'database';
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.indicator.check(key).up({ responseTimeMs: Date.now() - startedAt });
    } catch (error) {
      return this.indicator.check(key).down({
        responseTimeMs: Date.now() - startedAt,
        // The message only; a driver error can carry the connection string.
        message: error instanceof Error ? error.message : 'unreachable',
      });
    }
  }
}
