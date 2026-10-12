import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShieldEvidenceRecord } from './shield-evidence-record.entity';
import { ShieldController } from './shield.controller';
import { ShieldService } from './shield.service';

@Module({
  imports: [TypeOrmModule.forFeature([ShieldEvidenceRecord])],
  controllers: [ShieldController],
  providers: [ShieldService],
})
export class ShieldModule {}
