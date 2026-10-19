import { Logger, Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { DeviceHealthModule } from '../device-health/device-health.module';
import { EquipmentModule } from '../equipment/equipment.module';
import { IncidentModule } from '../incident/incident.module';
import { PageModule } from '../page/page.module';
import { WorkModule } from '../work/work.module';
import { ASSISTANT_MODEL, VertexGeminiModel, vertexConfigFrom } from './assistant-model';
import { AssistantTools } from './assistant-tools';
import { AssistantController } from './assistant.controller';
import { ASSISTANT_DAILY_LIMIT, AssistantService, DEFAULT_DAILY_TOKEN_LIMIT } from './assistant.service';

@Module({
  imports: [EquipmentModule, AlertModule, DeviceHealthModule, IncidentModule, WorkModule, PageModule],
  controllers: [AssistantController],
  providers: [
    AssistantTools,
    AssistantService,
    {
      provide: ASSISTANT_MODEL,
      // Unconfigured is a state, not a boot failure: every other screen works without
      // the assistant, and the chat answers 503 assistant_not_configured until it is set.
      useFactory: () => {
        const config = vertexConfigFrom(process.env);
        if (!config) {
          new Logger('Assistant').warn('ASSISTANT_VERTEX_PROJECT, ASSISTANT_VERTEX_LOCATION or ASSISTANT_MODEL unset; chat is off.');
          return null;
        }
        return new VertexGeminiModel(config);
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
