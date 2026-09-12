import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './auth/guards/auth.guard';
import { CapabilityGuard } from './auth/guards/capability.guard';
import { ErrorEnvelopeFilter } from './common/filters/error-envelope.filter';
import { validateEnv } from './config/env.validation';
import { dataSourceOptions } from './database/data-source';
import { HealthController } from './health/health.controller';
import { MeController } from './me/me.controller';
import { ProjectionModule } from './projection/projection.module';
import { CatalogModule } from './catalog/catalog.module';
import { ClientCatalogModule } from './client-catalog/client-catalog.module';
import { PredictionModule } from './prediction/prediction.module';
import { ActivationModule } from './activation/activation.module';
import { ScopeModule } from './scope/scope.module';
import { PlatformReadInterceptor } from './audit/platform-read.interceptor';
import { FieldPolicyInterceptor } from './common/interceptors/field-policy.interceptor';

export interface AppOptions {
  /** Defaults to "whenever DB_HOST is configured". */
  database?: boolean;
}

@Module({})
export class AppModule {
  /**
   * A dynamic module rather than a decorator that reads process.env.
   *
   * The first version of this file decided whether to import TypeORM inside the
   * @Module decorator, which is evaluated when the file is imported — so the module
   * graph depended on whether env was set before or after the import. The HTTP tests
   * cleared DB_HOST in beforeAll, by which point the decision was already made, and
   * the suite hung for five seconds connecting to a database that did not exist.
   *
   * The env is still the default; it is just read at a point the caller controls.
   */
  static register(options: AppOptions = {}): DynamicModule {
    const withDatabase = options.database ?? Boolean(process.env.DB_HOST);

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        JwtModule.register({ global: true }),
        ...(withDatabase
          ? [
              TypeOrmModule.forRoot({
                ...dataSourceOptions(),
                // Fail immediately and say why. The default retry loop turns a wrong
                // host into a silent hang, which is the least useful way to learn
                // that a connection string is wrong.
                retryAttempts: 0,
              }),
              ScopeModule,
              ProjectionModule,
              CatalogModule,
              ClientCatalogModule,
              ActivationModule,
              PredictionModule,
            ]
          : []),
      ],
      controllers: [HealthController, MeController],
      providers: [
        // Authenticated by default. Opting out is per-route and carries a reason.
        { provide: APP_GUARD, useClass: AuthGuard },
        // Runs after the auth guard, so a scope exists by the time it looks. Global
        // rather than per-controller: a route that declares @Requires must be
        // enforced whether or not somebody remembered to attach the guard to its
        // controller.
        { provide: APP_GUARD, useClass: CapabilityGuard },
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
        // Redaction happens on the way out, once, for every route that declares a
        // policy — not in each handler, where forgetting is silent.
        { provide: APP_INTERCEPTOR, useClass: FieldPolicyInterceptor },
        // Needs the audit table, so it exists only where there is a database. A
        // database-less boot is tests and `--help`; neither reads customer data.
        ...(withDatabase
          ? [{ provide: APP_INTERCEPTOR, useClass: PlatformReadInterceptor }]
          : []),
      ],
    };
  }
}
