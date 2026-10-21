import { Module } from '@nestjs/common';
import { RecEngineModule } from '../rec-engine/rec-engine.module';
import { REC_FRAME_MODEL } from './frame-model';
import { RecFrameController } from './rec-frame.controller';
import { RecFrameService } from './rec-frame.service';

/**
 * The frame step of the recommendation engine (task QREC2): bundle to sentences.
 * The model renderer is bound to null — the seam exists, the client does not (question 8).
 */
@Module({
  imports: [RecEngineModule],
  controllers: [RecFrameController],
  providers: [RecFrameService, { provide: REC_FRAME_MODEL, useValue: null }],
  exports: [RecFrameService],
})
export class RecFrameModule {}
