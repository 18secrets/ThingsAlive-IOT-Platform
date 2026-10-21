import { Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { RecFrameService } from './rec-frame.service';

const SHAPE = 'Responds { answer, provenance }. `answer` is a GroundedAnswerV1 (docs/ai/contracts/grounded-answer.v1.schema.json); '
  + 'its context_id is the evidence bundle id, because nothing produces an EquipmentContextV1 and the bundle is the context '
  + 'the answer was grounded in. citations is always [] until reference documents are searchable. `provenance` names the '
  + 'renderer (template or model), its version, the model id and version when a model wrote it, and the bundle id.';

/**
 * The recommendation frame over HTTP (task QREC2 §6).
 *
 * The same gate as the bundle it frames: `prediction.read`, the same machine narrowing,
 * and another tenant's bundle id is a 404, not a 403. Rendering is a POST and the page
 * never renders on read (question 9): the frame is a stored, citable row.
 */
@ApiTags('Recommendation evidence')
@Controller()
export class RecFrameController {
  constructor(private readonly frames: RecFrameService) {}

  @Post('rec-evidence/:bundleId/frame')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Frame an evidence bundle in sentences. Idempotent: one stored frame per bundle per template version', description: SHAPE })
  @ApiResponse({ status: 201, description: 'A frame was rendered and stored by this request' })
  @ApiResponse({ status: 200, description: 'The frame already existed' })
  async render(
    @CurrentScope() scope: RequestScope,
    @Param('bundleId', ParseUUIDPipe) bundleId: string,
    @Res({ passthrough: true }) res: { status: (code: number) => unknown },
  ) {
    const { created, ...served } = await this.frames.render(scope, bundleId);
    res.status(created ? 201 : 200);
    return served;
  }

  @Get('rec-evidence/:bundleId/frame')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'The served frame for an evidence bundle; 404 when none has been rendered', description: SHAPE })
  read(@CurrentScope() scope: RequestScope, @Param('bundleId', ParseUUIDPipe) bundleId: string) {
    return this.frames.read(scope, bundleId);
  }
}
