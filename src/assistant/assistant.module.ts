import { Logger, Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { DeviceHealthModule } from '../device-health/device-health.module';
import { EquipmentModule } from '../equipment/equipment.module';
import { IncidentModule } from '../incident/incident.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OnboardingStatusModule } from '../onboarding/onboarding-status.module';
import { PageModule } from '../page/page.module';
import { WorkModule } from '../work/work.module';
import { ASSISTANT_MODEL, GeminiModel, geminiConfigFrom } from './assistant-model';
import { AssistantProposalService } from './assistant-proposal.service';
import { AssistantTools } from './assistant-tools';
import { AssistantController } from './assistant.controller';
import { ASSISTANT_DAILY_LIMIT, AssistantService, DEFAULT_DAILY_TOKEN_LIMIT } from './assistant.service';

@Module({
  imports: [
    EquipmentModule, AlertModule, DeviceHealthModule, IncidentModule, WorkModule, PageModule, InventoryModule,
    OnboardingStatusModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantTools,
    AssistantService,
    AssistantProposalService,
    {
      provide: ASSISTANT_MODEL,
      // Unconfigured is a state, not a boot failure: every other screen works without
      // the assistant, and the chat answers 503 assistant_not_configured until it is set.
      useFactory: () => {
        const config = geminiConfigFrom(process.env);
        const logger = new Logger('Assistant');
        if (!config) {
          logger.warn('ASSISTANT_MODEL plus either ASSISTANT_VERTEX_PROJECT/LOCATION or ASSISTANT_GEMINI_API_KEY unset; chat is off.');
          return null;
        }
        logger.log(`Assistant on ${config.model} via ${config.mode === 'vertex' ? 'Vertex AI' : 'a Gemini API key'}.`);
        return new GeminiModel(config);
      },
    },
    {
      provide: ASSISTANT_DAILY_LIMIT,
      useFactory: () => {
        const raw = process.env.ASSISTANT_DAILY_TOKEN_LIMIT?.trim();
        const n = raw ? Number(raw) : DEFAULT_DAILY_TOKEN_LIMIT;
        return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_TOKEN_LIMIT;
      },
    },
  ],
})
export class AssistantModule {}
