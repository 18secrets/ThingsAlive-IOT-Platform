import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VaniCallScheduler } from './vani-call.scheduler';
import { VaniCallSender } from './vani-call-sender';
import { VaniClient } from './vani-client';
import { VaniOutcomeService } from './vani-outcome.service';
import { VaniSnapshotPusher } from './vani-snapshot';
import { VaniController } from './vani.controller';

/**
 * Phoning customers about alerts through Vani. The request is queued by the alert
 * service itself (`queueVaniCalls`); this module sends it, keeps Vani's picture of each
 * account current, and receives what happened on each call.
 */
@Module({
  controllers: [VaniController],
  providers: [
    VaniOutcomeService,
    { provide: VaniClient, useFactory: () => new VaniClient() },
    {
      provide: VaniCallSender,
      useFactory: (ds: DataSource, client: VaniClient) => new VaniCallSender(ds, client),
      inject: [DataSource, VaniClient],
    },
    {
      provide: VaniSnapshotPusher,
      useFactory: (ds: DataSource, client: VaniClient) => new VaniSnapshotPusher(ds, client),
      inject: [DataSource, VaniClient],
    },
    VaniCallScheduler,
  ],
})
export class VaniModule {}
