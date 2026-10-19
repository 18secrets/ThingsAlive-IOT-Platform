import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ProposalStatus } from './assistant-proposal.entity';
import { AssistantProposalService } from './assistant-proposal.service';
import { AssistantService, ChatMessage } from './assistant.service';

export class ChatMessageDto implements ChatMessage {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString() @IsNotEmpty() @MaxLength(2000)
  text: string;
}

export class ChatDto {
  // The browser holds the conversation; this bounds what it may send back. Twenty
  // turns is a long chat, and every turn is paid for again on each request.
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}

/**
 * The Ask AI widget's backend (task QCHAT1).
 *
 * `catalog.read`, the capability that opens the machine list: anyone who can see
 * machines may ask about them. What the answer can draw on is narrowed per tool, to
 * the capability of the screen that tool reads (`AssistantTools`).
 */
@ApiTags('Assistant')
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly proposals: AssistantProposalService,
  ) {}

  @Post('chat')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Answer the last question from this account\'s own data. Read-only; nothing is stored but the day\'s spend' })
  chat(@CurrentScope() scope: RequestScope, @Body() body: ChatDto) {
    return this.assistant.chat(scope, body.messages);
  }

  /**
   * `equipment.write`, the capability of the onboarding progress page this chat sits
   * on. Fitting loggers is narrowed further, per proposal, to `device.claim`.
   */
  @Post('onboarding/chat')
  @HttpCode(200)
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Onboarding help: reads progress, sites, machines and loggers, and proposes changes. Changes nothing itself' })
  onboarding(@CurrentScope() scope: RequestScope, @Body() body: ChatDto) {
    return this.assistant.onboarding(scope, body.messages);
  }

  @Get('proposals')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'This account\'s assistant proposals, newest first (50)' })
  listProposals(@CurrentScope() scope: RequestScope, @Query('status') status?: ProposalStatus) {
    return this.proposals.list(scope, status);
  }

  @Post('proposals/:id/confirm')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Do what was proposed, as you, through the ordinary service. Idempotent: returns the decided proposal' })
  confirm(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.confirm(scope, id);
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Decline a proposal. Idempotent: a decided one is returned as it is' })
  reject(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.reject(scope, id);
  }
}
