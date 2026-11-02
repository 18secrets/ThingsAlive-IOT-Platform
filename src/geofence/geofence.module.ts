import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeofenceVisit } from './entities/geofence-visit.entity';
import { GeofenceZone } from './entities/geofence-zone.entity';
import { FleetStatusService } from './fleet-status.service';
import { GeofenceTracker } from './geofence-tracker.service';
import { GeofenceController } from './geofence.controller';
import { GeofenceService } from './geofence.service';

/**
 * Geofencing (task QGEO2). Depends on nothing but the tables it reads, and exports the
 * service, so whatever uses zones later — visits, alerts, the assistant — imports this
 * rather than this importing them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeofenceZone, GeofenceVisit])],
  controllers: [GeofenceController],
  providers: [GeofenceService, GeofenceTracker, FleetStatusService],
  exports: [GeofenceService, GeofenceTracker, FleetStatusService],
})
export class GeofenceModule {}
