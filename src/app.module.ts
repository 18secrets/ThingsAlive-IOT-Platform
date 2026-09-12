import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth/guards/auth.guard';
import { ErrorEnvelopeFilter } from './common/filters/error-envelope.filter';
import { validateEnv } from './config/env.validation';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JwtModule.register({ global: true }),
  ],
  controllers: [HealthController, MeController],
  providers: [
    // Authenticated by default. Opting out is per-route and carries a reason.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule {}
