import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AssistantService, ChatMessage } from '../assistant/assistant.service';
import { SCOPE_RESOLVER, ScopeResolver } from '../auth/scope-resolver';
import { RequestScope } from '../auth/types/request-scope';
import { runTenantSpanning, withTenantId } from '../scope/tenant-session';
import { VaniConversationTurn } from './vani.entities';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_QUESTION_CHARS = 500;
/** Earlier turns sent with a question, so "and its fuel?" still means the same machine. */
export const HISTORY_TURNS = 6;
/**
 * Questions answered at once by one server, unless VANI_ASK_MAX_IN_FLIGHT says otherwise.
 * Each holds a database connection for as long as its answer takes (the turn lock), and
 * the pool has ten; four leaves the rest of the API room to work during a burst.
 */
export const DEFAULT_MAX_IN_FLIGHT = 4;
/**
 * Assistant tools that do not yet narrow to a person's assigned machines, withheld from
 * a caller whose access is limited to some of them. `list_equipment` reads
 * `EquipmentService.list`, which filters by account only; withheld until that honours
 * the caller's equipment scope (fix/equipment-list-scope), then this list empties.
 */
export const UNSCOPED_TOOLS: readonly string[] = ['list_equipment'];

export type RefusalReason =
  | 'unknown_caller' | 'caller_not_active' | 'unknown_machine' | 'not_your_machine'
  | 'budget_exhausted' | 'assistant_unavailable' | 'incomplete' | 'busy';

/**
 * What Vani says when it cannot answer. Each one says why, in words a customer can act
 * on, and none of them hints at what the answer would have been.
 */
export const REFUSALS: Record<RefusalReason, string> = {
  unknown_caller: 'I don\'t recognise this phone number on the account, so I can\'t look up machine details for you.',
  caller_not_active: 'Your access to this account isn\'t active, so I can\'t look up machine details for you.',
  unknown_machine: 'I can\'t find that machine on this account.',
  not_your_machine: 'That machine isn\'t one you have access to, so I can\'t tell you about it.',
  budget_exhausted: 'I can\'t look anything else up today. Please try again tomorrow, or check the Things Alive app.',
  assistant_unavailable: 'I can\'t look that up just now. Please try again in a few minutes.',
  incomplete: 'I couldn\'t work that out in time. Could you ask something narrower?',
  busy: 'I\'m answering a lot of questions right now. Please ask me again in a moment.',
};

export interface AskAnswer {
  conversation_id: string;
  status: 'answered' | 'refused';
  answer: string;
  reason?: RefusalReason;
  /** The machine this turn was about, as Vani knows it, so a follow-up can say "it". */
  machine?: { machine_id: string; name: string };
}

interface AskBody {
  account_id: string;
  conversation_id: string;
  caller_phone: string;
  question: string;
  machine_id: string | null;
  event_id: string | null;
  /** Optional until Vani sends it; without one, a retried question is answered again. */
  turn_id: string | null;
}

interface Focus {
  sourceSystem: string;
  externalId: string;
  machineId: string;
  spokenName: string;
  alertEventId: string | null;
}

/**
 * The one analysis tool Vani has (plan Phase 6, decided 4 Nov 2026): Vani asks the
 * platform a question on a caller's behalf and receives only the answer.
 *
 * Vani never reaches platform data or tools. The question is answered here, by the
 * assistant the console already uses (`AssistantService`), running as the person on
 * the phone: their account, their role, their sites and machines, resolved by the same
 * `ScopeResolver` that resolves a signed-in user — so a suspended user, an unaccepted
 * invitation or a machine outside their assignment is refused here exactly as it is in
 * the app. The figures come from the assistant's read tools, which are the platform's
 * own rules and calculations; the model only words the result.
 *
 * Every turn is recorded (`vani_conversation_turn`): who asked, about which machine,
 * which lookups the answer rested on, and the words spoken — including refusals.
 *
 * Off unless VANI_ASK_ENABLED=true. It changes the guide's "Vani speaks only from the
 * packet" contract, and stays off until Deepak has agreed to that.
 */
@Injectable()
export class VaniAskService {
  private readonly logger = new Logger(VaniAskService.name);
  private inFlight = 0;

  constructor(
    private readonly ds: DataSource,
    @Inject(SCOPE_RESOLVER) private readonly resolver: ScopeResolver,
    private readonly assistant: AssistantService,
  ) {}

  async ask(raw: unknown, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<AskAnswer> {
    if (`${env.VANI_ASK_ENABLED ?? ''}`.toLowerCase() !== 'true') {
      throw new ServiceUnavailableException('The Vani analysis tool is not enabled: VANI_ASK_ENABLED is not true.');
    }
    const body = parse(raw);

    // Over the limit, the caller is told at once rather than queued behind a burst,
    // since every queued question holds a connection and a caller is waiting in silence.
    // Not recorded: a "busy" stored under a turn id would be replayed to the retry that
    // comes once there is room.
    const limit = maxInFlight(env);
    if (this.inFlight >= limit) {
      this.logger.warn(`Vani ask refused as busy: ${this.inFlight} of ${limit} already being answered.`);
      return { conversation_id: body.conversation_id, status: 'refused', answer: REFUSALS.busy, reason: 'busy' };
    }
    this.inFlight += 1;
    try {
      return await this.admitted(body, now);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async admitted(body: AskBody, now: Date): Promise<AskAnswer> {
    // Vani names an account, not a tenant; the link is what turns one into the other.
    const [link]: { tenant_id: string }[] = await runTenantSpanning(this.ds, 'vani ask account', (m) => m.query(
      `SELECT "tenant_id" FROM "vani_account_link" WHERE "vani_account_id" = $1 AND "enabled"`, [body.account_id]));
    if (!link) throw new NotFoundException(`No enabled account "${body.account_id}".`);
    const tenantId = link.tenant_id;

    if (!body.turn_id) return this.answer(tenantId, body, now, null);

    // Vani retries a question it got no answer to, and the likeliest reason is that the
    // first one is still being worked out: a model round can take seconds. Checking for
    // a stored turn is not enough, because the first has not stored one yet. So the
    // retry waits on a lock the first holds until its turn is committed, then reads it
    // and says the same words — one model run, one row, one answer. The lock is held for
    // as long as the answer takes, on one connection per question in flight.
    return withTenantId(this.ds, tenantId, async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`vani-ask|${tenantId}|${body.conversation_id}|${body.turn_id}`]);
      const prior = await this.replay(m, tenantId, body);
      if (prior) return prior;
      return this.answer(tenantId, body, now, m);
    });
  }

  /** The turn already given for this turn id, as it was said; null when there is none. */
  private async replay(m: EntityManager, tenantId: string, body: AskBody): Promise<AskAnswer | null> {
    const [row]: {
      caller_phone: string; question: string; answer: string; status: 'answered' | 'refused'; reason: string | null;
      machine_id: string | null; spoken_name: string | null;
    }[] = await m.query(
      `SELECT t."caller_phone", t."question", t."answer", t."status", t."reason", l."machine_id", l."spoken_name"
         FROM "vani_conversation_turn" t
         LEFT JOIN "vani_machine_link" l
           ON l."tenant_id" = t."tenant_id" AND l."source_system" = t."source_system" AND l."external_id" = t."external_id"
        WHERE t."tenant_id" = $1 AND t."conversation_id" = $2 AND t."turn_id" = $3`,
      [tenantId, body.conversation_id, body.turn_id]);
    if (!row) return null;
    // A turn id names one question. Reused for another, it is a bug on Vani's side, and
    // answering the old question to the new one would be worse than saying so.
    if (row.question !== body.question || row.caller_phone !== body.caller_phone) {
      throw new ConflictException(`turn_id "${body.turn_id}" was already used for a different question in this conversation.`);
    }
    return {
      conversation_id: body.conversation_id, status: row.status, answer: row.answer,
      ...(row.reason ? { reason: row.reason as RefusalReason } : {}),
      ...(row.machine_id && row.spoken_name ? { machine: { machine_id: row.machine_id, name: row.spoken_name } } : {}),
    };
  }

  /** `m` is the locked transaction the turn is written in, when there is one. */
  private async answer(tenantId: string, body: AskBody, now: Date, m: EntityManager | null): Promise<AskAnswer> {
    const turn = (t: Partial<VaniConversationTurn>, answer: AskAnswer): Promise<AskAnswer> =>
      this.record(tenantId, body, t, answer, m);
    const refuse = (reason: RefusalReason, t: Partial<VaniConversationTurn> = {}, focus?: Focus | null) =>
      turn(t, {
        conversation_id: body.conversation_id, status: 'refused', answer: REFUSALS[reason], reason,
        ...(focus ? { machine: { machine_id: focus.machineId, name: focus.spokenName } } : {}),
      });

    // ---- who is calling
    const caller = await this.caller(tenantId, body.caller_phone);
    if (!caller) return refuse('unknown_caller');
    let scope: RequestScope;
    try {
      const identity = await this.resolver.resolve(tenantId, caller.id);
      if (!identity) return refuse('unknown_caller');
      scope = {
        tenantId, userId: caller.id, isPlatformRole: false, roles: identity.roles,
        capabilities: identity.capabilities, plantIds: identity.plantIds, equipmentIds: identity.equipmentIds,
      };
    } catch (err) {
      // Suspended, invitation not accepted, role gone: the resolver's refusals, as spoken ones.
      if (err instanceof HttpException && err.getStatus() === HttpStatus.UNAUTHORIZED) {
        return refuse('caller_not_active', { userId: caller.id });
      }
      throw err;
    }

    // ---- which machine
    const resolved = await this.focus(tenantId, body, caller.id);
    if (resolved === 'unknown') return refuse('unknown_machine', { userId: caller.id });
    const focus = resolved;
    const about = focus
      ? { sourceSystem: focus.sourceSystem, externalId: focus.externalId, alertEventId: focus.alertEventId }
      : {};
    if (focus && scope.equipmentIds !== undefined && !scope.equipmentIds.includes(focus.externalId)) {
      return refuse('not_your_machine', { userId: caller.id, ...about });
    }

    // ---- the analysis, as that person
    const history = await this.history(tenantId, body.conversation_id, body.caller_phone);
    const framing = [
      `[Phone call. The caller is ${caller.full_name}.`,
      focus ? `They are asking about the machine called "${focus.spokenName}" (code ${focus.externalId}).` : '',
      'Answer in one or two short sentences that will be read aloud: no lists, no symbols, no codes or ids.]',
    ].filter(Boolean).join(' ');
    const messages: ChatMessage[] = [...history, { role: 'user', text: `${framing}\n${body.question}` }];

    let reply;
    try {
      // A caller limited to some machines is not offered a tool that would list the rest.
      const withhold = scope.equipmentIds !== undefined ? UNSCOPED_TOOLS : [];
      reply = await this.assistant.chat(scope, messages, now, { withhold });
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const reason: RefusalReason = err.getStatus() === HttpStatus.TOO_MANY_REQUESTS ? 'budget_exhausted' : 'assistant_unavailable';
      this.logger.warn(`Vani ask for ${tenantId} not answered (${reason}): ${err.message}`);
      return refuse(reason, { userId: caller.id, ...about }, focus);
    }
    if (!reply.complete) {
      return refuse('incomplete', { userId: caller.id, toolsUsed: reply.toolsUsed, tokens: reply.tokens, ...about }, focus);
    }

    return turn(
      { userId: caller.id, toolsUsed: reply.toolsUsed, tokens: reply.tokens, ...about },
      {
        conversation_id: body.conversation_id, status: 'answered', answer: spoken(reply.reply),
        ...(focus ? { machine: { machine_id: focus.machineId, name: focus.spokenName } } : {}),
      },
    );
  }

  /**
   * The person a number belongs to, in this account. Numbers are unique across the
   * platform, so this is one person or nobody. Stored numbers may lack the "+", so
   * both spellings of the caller's E.164 number are tried; a number stored without its
   * country code does not match, and is not guessed at.
   */
  private async caller(tenantId: string, phone: string): Promise<{ id: string; full_name: string } | null> {
    const bare = phone.replace(/^\+/, '');
    const rows: { id: string; full_name: string }[] = await withTenantId(this.ds, tenantId, (m) => m.query(
      `SELECT "id", "full_name" FROM "app_user" WHERE "tenant_id" = $1 AND "phone" IN ($2, $3) LIMIT 2`,
      [tenantId, `+${bare}`, bare]));
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * The machine this turn is about, in order of how sure we can be: the alert the call
   * was placed for; the machine Vani names; a linked machine named in the question;
   * the machine the conversation was already about. Null when there is none — the
   * assistant can still answer about the caller's machines in general.
   */
  private focus(tenantId: string, body: AskBody, userId: string): Promise<Focus | null | 'unknown'> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const linked: { source_system: string; external_id: string; machine_id: string; spoken_name: string }[] = await m.query(
        `SELECT "source_system", "external_id", "machine_id", "spoken_name" FROM "vani_machine_link" WHERE "tenant_id" = $1`,
        [tenantId]);
      const asFocus = (l: (typeof linked)[number], alertEventId: string | null = null): Focus => ({
        sourceSystem: l.source_system, externalId: l.external_id, machineId: l.machine_id,
        spokenName: l.spoken_name, alertEventId,
      });

      if (body.event_id) {
        const [call]: { machine_id: string }[] = await m.query(
          `SELECT "machine_id" FROM "vani_call" WHERE "tenant_id" = $1 AND "alert_event_id" = $2`, [tenantId, body.event_id]);
        const l = call && linked.find((x) => x.machine_id === call.machine_id);
        return l ? asFocus(l, body.event_id) : 'unknown';
      }
      if (body.machine_id) {
        const l = linked.find((x) => x.machine_id === body.machine_id);
        return l ? asFocus(l) : 'unknown';
      }
      const named = namedIn(body.question, linked);
      if (named) return asFocus(named);
      return this.previousFocus(m, tenantId, body, userId, linked, asFocus);
    });
  }

  private async previousFocus(
    m: EntityManager, tenantId: string, body: AskBody, userId: string,
    linked: { source_system: string; external_id: string; machine_id: string; spoken_name: string }[],
    asFocus: (l: (typeof linked)[number], alertEventId?: string | null) => Focus,
  ): Promise<Focus | null> {
    const [last]: { source_system: string; external_id: string; alert_event_id: string | null }[] = await m.query(
      `SELECT "source_system", "external_id", "alert_event_id" FROM "vani_conversation_turn"
        WHERE "tenant_id" = $1 AND "conversation_id" = $2 AND "caller_phone" = $3 AND "user_id" = $4
          AND "external_id" IS NOT NULL
        ORDER BY "created_at" DESC LIMIT 1`,
      [tenantId, body.conversation_id, body.caller_phone, userId]);
    const l = last && linked.find((x) => x.source_system === last.source_system && x.external_id === last.external_id);
    return l ? asFocus(l, last.alert_event_id) : null;
  }

  /** This caller's earlier turns in this conversation, oldest first — answered ones only. */
  private async history(tenantId: string, conversationId: string, phone: string): Promise<ChatMessage[]> {
    const rows: { question: string; answer: string }[] = await withTenantId(this.ds, tenantId, (m) => m.query(
      `SELECT "question", "answer" FROM "vani_conversation_turn"
        WHERE "tenant_id" = $1 AND "conversation_id" = $2 AND "caller_phone" = $3 AND "status" = 'answered'
        ORDER BY "created_at" DESC LIMIT $4`,
      [tenantId, conversationId, phone, HISTORY_TURNS]));
    return rows.reverse().flatMap((r) => [
      { role: 'user' as const, text: r.question },
      { role: 'assistant' as const, text: r.answer },
    ]);
  }

  private async record(
    tenantId: string, body: AskBody, t: Partial<VaniConversationTurn>, answer: AskAnswer, locked: EntityManager | null,
  ): Promise<AskAnswer> {
    const write = (m: EntityManager) => m.getRepository(VaniConversationTurn).insert({
      tenantId, conversationId: body.conversation_id, turnId: body.turn_id, callerPhone: body.caller_phone,
      userId: t.userId ?? null, sourceSystem: t.sourceSystem ?? null, externalId: t.externalId ?? null,
      alertEventId: t.alertEventId ?? null, question: body.question, answer: answer.answer,
      status: answer.status, reason: answer.reason ?? null, toolsUsed: t.toolsUsed ?? [], tokens: t.tokens ?? 0,
    });
    await (locked ? write(locked) : withTenantId(this.ds, tenantId, write));
    return answer;
  }
}

/**
 * The linked machine a question names, by its spoken name, Vani id or our code — the
 * longest match, so "DG-01" inside "Diesel Generator DG-01" does not pick another
 * machine. Two different machines named equally well is no focus at all: the assistant
 * can ask which one, which is better than choosing.
 */
export function namedIn<T extends { external_id: string; machine_id: string; spoken_name: string }>(
  question: string, linked: T[],
): T | null {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  let best: { l: T; len: number } | null = null;
  let tie = false;
  for (const l of linked) {
    for (const name of [l.spoken_name, l.machine_id, l.external_id]) {
      const n = norm(name);
      if (n.trim().length < 3 || !q.includes(n)) continue;
      if (!best || n.length > best.len) { best = { l, len: n.length }; tie = false; }
      else if (n.length === best.len && best.l !== l) tie = true;
    }
  }
  return best && !tie ? best.l : null;
}

/** VANI_ASK_MAX_IN_FLIGHT when it is a whole number of at least one, else the default. */
export function maxInFlight(env: NodeJS.ProcessEnv): number {
  const raw = `${env.VANI_ASK_MAX_IN_FLIGHT ?? ''}`.trim();
  if (!raw) return DEFAULT_MAX_IN_FLIGHT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`VANI_ASK_MAX_IN_FLIGHT must be a whole number of at least 1, not "${raw}".`);
  return n;
}

/** Whatever the model wrote, as one plain spoken line: no markdown, bullets or line breaks. */
export function spoken(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Checked by hand, as the callback is: an extra field from Vani must not cost the answer. */
function parse(raw: unknown): AskBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Expected a JSON object.');
  const b = raw as Record<string, unknown>;
  const problems: string[] = [];
  const text = (k: string, required: boolean, max = 200): string | null => {
    const v = b[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (required) problems.push(`${k} is required`);
      return null;
    }
    if (typeof v !== 'string') { problems.push(`${k} must be a string`); return null; }
    if (v.length > max) { problems.push(`${k} is longer than ${max} characters`); return null; }
    return v.trim();
  };
  const accountId = text('account_id', true);
  const conversationId = text('conversation_id', true, 128);
  const turnId = text('turn_id', false, 128);
  const phone = text('caller_phone', true, 20);
  if (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) problems.push('caller_phone must be E.164, like +12012031340');
  const question = text('question', true, MAX_QUESTION_CHARS);
  const machineId = text('machine_id', false);
  const eventId = text('event_id', false, 36);
  if (eventId && !UUID.test(eventId)) problems.push('event_id is not one of ours');
  if (problems.length) throw new BadRequestException(problems.join('; '));
  return {
    account_id: accountId!, conversation_id: conversationId!, caller_phone: phone!, question: question!,
    machine_id: machineId, event_id: eventId, turn_id: turnId,
  };
}
