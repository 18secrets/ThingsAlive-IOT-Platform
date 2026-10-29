import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeofenceZone } from './entities/geofence-zone.entity';
import { GeofenceController } from './geofence.controller';
import { GeofenceService } from './geofence.service';

/**
 * Geofencing (task QGEO2). Depends on nothing but the tables it reads, and exports the
 * service, so whatever uses zones later — visits, alerts, the assistant — imports this
 * rather than this importing them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeofenceZone])],
  controllers: [GeofenceController],
  providers: [GeofenceService],
  exports: [GeofenceService],
})
export class GeofenceModule {}
