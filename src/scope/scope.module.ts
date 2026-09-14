import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PlatformAccessLog } from '../audit/platform-access-log.entity';
import { PlatformReadInterceptor } from '../audit/platform-read.interceptor';
import { ScopedRepository } from './scoped-repository';
import { ScopedEntityMeta, TenantOwnedEntity } from './tenant-owned';

/** Injection token for a scoped repository over one entity. */
export const scopedToken = (target: EntityTarget<any>): string =>
  `SCOPED_REPOSITORY_${typeof target === 'function' ? target.name : String(target)}`;

/**
 * Registers the safe repository for a tenant-owned entity.
 *
 * A feature module asks for this instead of `TypeOrmModule.forFeature`, and therefore
 * never holds a raw repository it could query unscoped. The meta argument names the
 * columns a scope may narrow on; omitting it means tenant isolation only.
 */
export function provideScoped<T extends ObjectLiteral & TenantOwnedEntity>(
  target: EntityTarget<T>,
  meta: ScopedEntityMeta<T> = {},
): Provider {
  return {
    provide: scopedToken(target),
    inject: [DataSource, AuditService],
    useFactory: (ds: DataSource, audit: AuditService) =>
      new ScopedRepository<T>(ds, target, meta, audit),
  };
}

/** Companion to `provideScoped` at the injection site. */
export const InjectScoped = (target: EntityTarget<any>) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Inject } = require('@nestjs/common');
  return Inject(scopedToken(target));
};

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlatformAccessLog])],
  providers: [AuditService, PlatformReadInterceptor],
  exports: [AuditService, PlatformReadInterceptor],
})
export class ScopeModule {
  static forRoot(): DynamicModule {
    return { module: ScopeModule };
  }
}
