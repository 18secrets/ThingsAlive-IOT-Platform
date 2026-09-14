import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceInventory } from './entities/device-inventory.entity';
import { DeviceInventoryEvent } from './entities/device-inventory-event.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './services/inventory.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceInventory, DeviceInventoryEvent])],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
