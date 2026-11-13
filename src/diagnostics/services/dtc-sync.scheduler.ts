import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DtcSyncService } from './dtc-sync.service';

export const DEFAULT_DTC_TICK_SECONDS = 60; // Check every 60 seconds for active packets
export const DEFAULT_MASTER_SYNC_SECONDS = 86_400; // Daily master catalog mirror

@Injectable()
export class DtcSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DtcSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private masterTimer: NodeJS.Timeout | null = null;
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

    // Daily master catalog sync
    this.masterTimer = setInterval(() => void this.syncMaster(), DEFAULT_MASTER_SYNC_SECONDS * 1000);
    this.masterTimer.unref?.();

    this.logger.log(`DTC telemetry pull scheduler running every ${tickSeconds}s.`);
    // Initial master sync
    void this.syncMaster();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.timer = null;
    this.masterTimer = null;
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
