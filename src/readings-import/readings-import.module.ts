import { Module } from '@nestjs/common';
import { ReadingsImportController } from './readings-import.controller';
import { ReadingsImportService } from './readings-import.service';

/** Historical readings uploaded per machine as CSV (task QIMPORT-READINGS). */
@Module({
  controllers: [ReadingsImportController],
  providers: [ReadingsImportService],
})
export class ReadingsImportModule {}
