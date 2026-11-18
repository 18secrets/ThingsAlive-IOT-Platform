import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DtcSyncService } from './dtc-sync.service';

export const DEFAULT_DTC_TICK_SECONDS = 60; // Check every 60 seconds for active packets

@Injectable()
export class DtcSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DtcSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly sync: DtcSyncService) {}

  onModuleInit(): void {
    if (`${process.env.DTC_SYNC_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      this.logger.log('DTC_SYNC_ENABLED is not true; background DTC sync scheduler is dormant.');
      return;
    }

    const tickSeconds = Math.max(10, Number(process.env.DTC_SYNC_TICK_SECONDS ?? DEFAULT_DTC_TICK_SECONDS));
    this.timer = setInterval(() => void this.tick(), tickSeconds * 1000);
    this.timer.unref?.();

    // No daily copy of 1.0's dtc_master any more (VehicleCodesOwned1765600000000): vehicle
    // codes are made in 2.0's library, and a copy would write over what was edited there.
    // `syncMaster` stays for a deliberate one-off run; nothing schedules it.

    this.logger.log(`DTC telemetry pull scheduler running every ${tickSeconds}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.sync.runSync(now);
      if (result.packetsIngested > 0) {
        this.logger.log(`DTC sync: Ingested ${result.packetsIngested} packets across ${result.devicesPolled} devices.`);
      }
    } catch (err: any) {
      this.logger.error(`DTC sync cycle failed: ${err.message}`, err.stack);
    } finally {
      this.running = false;
    }
  }

  async syncMaster(): Promise<void> {
    try {
      await this.sync.syncMasterCatalog();
    } catch (err: any) {
      this.logger.error(`DTC master catalog sync failed: ${err.message}`);
    }
  }
}
