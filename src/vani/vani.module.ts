import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VaniCallScheduler } from './vani-call.scheduler';
import { VaniCallSender } from './vani-call-sender';
import { VaniClient } from './vani-client';

/**
 * Phoning customers about alerts through Vani. The request is queued by the alert
 * service itself (`queueVaniCalls`); this module sends it.
 */
@Module({
  providers: [
    { provide: VaniClient, useFactory: () => new VaniClient() },
    {
      provide: VaniCallSender,
      useFactory: (ds: DataSource, client: VaniClient) => new VaniCallSender(ds, client),
      inject: [DataSource, VaniClient],
    },
    VaniCallScheduler,
  ],
})
export class VaniModule {}
