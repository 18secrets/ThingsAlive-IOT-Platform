import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { SignalState } from '../entities/signal-state.entity';

export interface StateEntry { state: string; code: number }

/** The vocabulary for some signals, as the compiler takes it: signal → state → code. */
export type SignalStateVocabulary = Map<string, Map<string, number>>;

/** Read by publish (task QCAT1 §4), in whatever transaction or session the caller holds. */
export async function loadSignalStates(m: EntityManager, roles: readonly string[]): Promise<SignalStateVocabulary> {
  const out: SignalStateVocabulary = new Map();
  if (!roles.length) return out;
  const rows = await m.getRepository(SignalState).find({ where: { measurementRole: In([...roles]) } });
  for (const r of rows) {
    const states = out.get(r.measurementRole) ?? new Map<string, number>();
    states.set(r.state, r.code);
    out.set(r.measurementRole, states);
  }
  return out;
}

/**
 * The categorical-signal vocabulary (task QCAT1). A role's states are replaced as a
 * whole: editing one state at a time invites a moment where two states share a code,
 * which the database refuses anyway — replacing the set says what is meant.
 */
@Injectable()
export class SignalStateService {
  private readonly logger = new Logger(SignalStateService.name);

  constructor(private readonly ds: DataSource) {}

  list(role?: string): Promise<SignalState[]> {
    return this.ds.getRepository(SignalState).find({
      where: role ? { measurementRole: role } : {},
      order: { measurementRole: 'ASC', code: 'ASC' },
    });
  }

  async replace(scope: RequestScope, role: string, states: StateEntry[]): Promise<SignalState[]> {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      throw new BadRequestException(`"${role}" is not a measurement role name.`);
    }
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(SignalState);
      await repo.delete({ measurementRole: role });
      if (states.length) {
        await repo.insert(states.map((s) => ({ measurementRole: role, state: s.state, code: s.code, updatedBy: scope.userId })))
          .catch(mapError);
      }
      this.logger.log(`${scope.userId} set ${states.length} state(s) for "${role}".`);
      return repo.find({ where: { measurementRole: role }, order: { code: 'ASC' } });
    });
  }
}

/** The database's refusals, said in the API's terms. */
function mapError(error: unknown): never {
  if (error instanceof QueryFailedError) {
    const code = (error as QueryFailedError & { code?: string }).code;
    if (code === '23505') throw new BadRequestException('Each state and each code may appear once per signal.');
    if (code === '23514') {
      throw new BadRequestException('A state is lower_snake_case starting with a letter; a code is a whole number ≥ 0.');
    }
  }
  throw error;
}
