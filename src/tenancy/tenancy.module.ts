import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { Tenant } from './entities/tenant.entity';
import { TenancyController } from './tenancy.controller';
import { ProvisioningService } from './services/provisioning.service';

@Module({
  // For PasswordService, which mints the first administrator's invitation. Identity
  // does not import this module back: the dependency runs one way, from the thing
  // that creates accounts to the thing that creates credentials.
  imports: [TypeOrmModule.forFeature([Tenant]), IdentityModule],
  controllers: [TenancyController],
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class TenancyModule {}
