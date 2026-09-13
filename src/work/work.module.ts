import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkOrderEvent } from './entities/work-order-event.entity';
import { WorkOrder, WorkOrderCounter } from './entities/work-order.entity';
import { WorkOrderService } from './services/work-order.service';
import { WorkOrderController } from './work.controller';

@Module({
  imports: [TypeOrmModule.forFeature([WorkOrder, WorkOrderCounter, WorkOrderEvent])],
  controllers: [WorkOrderController],
  providers: [WorkOrderService],
  exports: [WorkOrderService],
})
export class WorkModule {}
