import { Module } from '@nestjs/common';
import { FleetImportController } from './fleet-import.controller';
import { FleetImportService } from './fleet-import.service';

@Module({
  controllers: [FleetImportController],
  providers: [FleetImportService],
})
export class FleetImportModule {}
