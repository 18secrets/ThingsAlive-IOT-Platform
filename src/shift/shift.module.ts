import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentShift } from './entities/equipment-shift.entity';
import { ShiftService } from './services/shift.service';
import { ShiftController } from './shift.controller';

@Module({
  imports: [TypeOrmModule.forFeature([EquipmentShift])],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService],
})
export class ShiftModule {}
