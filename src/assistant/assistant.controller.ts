import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
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
  constructor(private readonly assistant: AssistantService) {}

  @Post('chat')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Answer the last question from this account\'s own data. Read-only; nothing is stored but the day\'s spend' })
  chat(@CurrentScope() scope: RequestScope, @Body() body: ChatDto) {
    return this.assistant.chat(scope, body.messages);
  }
}
