import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LoggerModule } from 'nestjs-pino';
import { TerminusModule } from '@nestjs/terminus';
import { loggerConfig } from './common/logging';
import { PrismaService } from './prisma/prisma.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { SyncController } from './sync/sync.controller';
import { HealthController } from './common/health.controller';
import { OnboardingController } from './ai/onboarding.controller';
import { OnboardingService } from './ai/onboarding.service';

@Module({
  imports: [
    LoggerModule.forRoot(loggerConfig()),
    TerminusModule,
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [
    AuthController,
    CatalogController,
    InventoryController,
    OrdersController,
    PaymentsController,
    CustomersController,
    ShiftsController,
    ReportsController,
    SyncController,
    HealthController,
    OnboardingController,
  ],
  providers: [
    PrismaService,
    AuthService,
    CatalogService,
    InventoryService,
    OrdersService,
    PaymentsService,
    CustomersService,
    ShiftsService,
    ReportsService,
    OnboardingService,
  ],
})
export class AppModule {}
