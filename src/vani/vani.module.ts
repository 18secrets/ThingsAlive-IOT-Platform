import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertModule } from '../alert/alert.module';
import { AssistantModule } from '../assistant/assistant.module';
import { IdentityModule } from '../identity/identity.module';
import { WorkModule } from '../work/work.module';
import { VaniAskService } from './vani-ask.service';
import { VaniBreaker } from './vani-breaker';
import { VaniCallScheduler } from './vani-call.scheduler';
import { VaniCallSender } from './vani-call-sender';
import { VaniClient } from './vani-client';
import { VaniDecisionService } from './vani-decision';
import { VaniOutcomeService } from './vani-outcome.service';
import { VaniSnapshotPusher } from './vani-snapshot';
import { VaniController } from './vani.controller';

/**
 * Phoning customers about alerts through Vani. The request is queued by the alert
 * service itself (`queueVaniCalls`); this module sends it, keeps Vani's picture of each
 * account current, and receives what happened on each call.
 */
@Module({
  imports: [AssistantModule, IdentityModule, AlertModule, WorkModule],
  controllers: [VaniController],
  providers: [
    VaniOutcomeService,
    VaniDecisionService,
    VaniAskService,
    { provide: VaniClient, useFactory: () => new VaniClient() },
    // One breaker for both: they reach the same Vani.
    { provide: VaniBreaker, useFactory: () => new VaniBreaker() },
    {
      provide: VaniCallSender,
      useFactory: (ds: DataSource, client: VaniClient, breaker: VaniBreaker) => new VaniCallSender(ds, client, breaker),
      inject: [DataSource, VaniClient, VaniBreaker],
    },
    {
      provide: VaniSnapshotPusher,
      useFactory: (ds: DataSource, client: VaniClient, breaker: VaniBreaker) => new VaniSnapshotPusher(ds, client, breaker),
      inject: [DataSource, VaniClient, VaniBreaker],
    },
    VaniCallScheduler,
  ],
})
export class VaniModule {}
