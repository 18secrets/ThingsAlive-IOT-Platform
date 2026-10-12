import { Module } from '@nestjs/common';
import { SignalBindingModule } from '../signal-binding/signal-binding.module';
import { OnboardingStatusController } from './onboarding-status.controller';
import { OnboardingStatusService } from './onboarding-status.service';

/** Owns no table: every step is read from the module that owns the fact. */
@Module({
  imports: [SignalBindingModule],
  controllers: [OnboardingStatusController],
  providers: [OnboardingStatusService],
})
export class OnboardingStatusModule {}
