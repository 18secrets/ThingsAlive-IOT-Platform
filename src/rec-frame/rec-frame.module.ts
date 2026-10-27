import { Module } from '@nestjs/common';
import { RecEngineModule } from '../rec-engine/rec-engine.module';
import { REC_FRAME_MODEL } from './frame-model';
import { frameModelFromEnv } from './gemini-frame-model';
import { RecFrameController } from './rec-frame.controller';
import { RecFrameService } from './rec-frame.service';

/**
 * The frame step of the recommendation engine (task QREC2): bundle to sentences.
 * The model renderer is Gemini when the assistant's Gemini is configured, and null
 * otherwise; either way it runs only when REC_FRAME_MODEL_ENABLED is true.
 */
@Module({
  imports: [RecEngineModule],
  controllers: [RecFrameController],
  providers: [RecFrameService, { provide: REC_FRAME_MODEL, useFactory: () => frameModelFromEnv(process.env) }],
  exports: [RecFrameService],
})
export class RecFrameModule {}
