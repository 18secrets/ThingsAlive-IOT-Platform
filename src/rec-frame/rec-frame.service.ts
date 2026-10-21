import { Inject, Injectable, InternalServerErrorException, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { RecEngineService } from '../rec-engine/rec-engine.service';
import { withTenantSession } from '../scope/tenant-session';
import { critic } from './critic';
import { FrameModel, REC_FRAME_MODEL } from './frame-model';
import { BundleView, bundleView, frameId, GroundedAnswer } from './grounded-answer';
import { renderTemplateFrame } from './render';
import { RecFrame } from './rec-frame.entity';
import { TEMPLATE_VERSION } from './templates';

export interface ServedFrame {
  answer: GroundedAnswer;
  /** Beside the answer, not inside it: GroundedAnswerV1 is closed (§6). */
  provenance: { renderer: 'template' | 'model'; rendererVersion: string; modelId: string | null; modelVersion: string | null; bundleId: string };
}

/** The model path's renderer_version: the seam's, since the model id and version are their own columns. */
const MODEL_RENDERER_VERSION = 'rec-frame-model@1';

/**
 * Frames an evidence bundle in sentences (task QREC2).
 *
 * The template renderer always runs, and its frame is always stored: it is what is
 * served whenever the model is off, absent, or refused. The model renderer runs only
 * when REC_FRAME_MODEL_ENABLED is true *and* a model is bound, at most once per bundle
 * per model version, and its frame is served only if the critic passed it.
 */
@Injectable()
export class RecFrameService implements OnModuleInit {
  private readonly logger = new Logger(RecFrameService.name);
  /** Read once, at construction: a flag that changes mid-process is two configurations in one log. */
  readonly modelEnabled = `${process.env.REC_FRAME_MODEL_ENABLED ?? ''}`.toLowerCase() === 'true';

  constructor(
    private readonly ds: DataSource,
    private readonly engine: RecEngineService,
    @Optional() @Inject(REC_FRAME_MODEL) private readonly model: FrameModel | null = null,
  ) {}

  onModuleInit(): void {
    if (this.modelEnabled && !this.model) {
      this.logger.warn(
        'REC_FRAME_MODEL_ENABLED is true but no frame model is configured, so every frame is the '
        + 'template frame. This is expected until a model adapter exists (QSPIKE1b).',
      );
    }
  }

  /** Off, or on with nothing bound: the model is never called, not called and ignored. */
  private get activeModel(): FrameModel | null {
    return this.modelEnabled ? this.model : null;
  }

  async render(scope: RequestScope, bundleId: string): Promise<ServedFrame & { created: boolean }> {
    // byId is the bundle's own gate: another tenant's id, or a machine outside scope, is a 404.
    const bundle = bundleView(await this.engine.byId(scope, bundleId));
    const templateFrame = renderTemplateFrame(bundle);
    const failed = critic(templateFrame, bundle);
    // A template the critic refuses is a bug in a template, never a frame served with a hole in it.
    if (failed.length) {
      throw new InternalServerErrorException(`The template frame failed the critic: ${failed.join(', ')}.`);
    }

    return withTenantSession(this.ds, scope, async (m) => {
      const model = this.activeModel;
      if (model) {
        // One model attempt per bundle per model version, however many requests race for it.
        // An advisory lock rather than a row lock: the bundle is append-only and the role
        // holds no UPDATE on it, which FOR UPDATE requires.
        await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rec_frame:${bundle.id}`]);
      }
      let created = await this.insert(m, scope.tenantId, bundle.id, {
        id: templateFrame.answer_id, renderer: 'template', rendererVersion: TEMPLATE_VERSION,
        modelId: null, modelVersion: null, validation: 'passed', refusedChecks: [], answer: templateFrame,
      });
      if (model && !(await this.modelRow(m, bundle.id, model))) {
        created = (await this.attemptModel(m, scope.tenantId, bundle, templateFrame, model)) || created;
      }
      const served = await this.served(m, bundle.id);
      return { ...served!, created };
    });
  }

  async read(scope: RequestScope, bundleId: string): Promise<ServedFrame> {
    await this.engine.byId(scope, bundleId);
    const served = await withTenantSession(this.ds, scope, (m) => this.served(m, bundleId));
    if (!served) throw new NotFoundException('No frame has been rendered for this evidence bundle.');
    return served;
  }

  // ------------------------------------------------------------------------ internals

  private async attemptModel(
    m: EntityManager, tenantId: string, bundle: BundleView, templateFrame: GroundedAnswer, model: FrameModel,
  ): Promise<boolean> {
    const id = frameId(`${bundle.id}|model|${model.id}|${model.version}`);
    let refused: string[];
    let answer: GroundedAnswer | null = null;
    try {
      const raw = await model.frame({ bundle, templateFrame: structuredClone(templateFrame) });
      // Identity is the server's, not the model's to echo back.
      const candidate = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as object), answer_id: id, context_id: templateFrame.context_id, as_of: templateFrame.as_of }
        : raw;
      refused = critic(candidate, bundle, templateFrame);
      if (!refused.length) answer = candidate as GroundedAnswer;
    } catch (err) {
      this.logger.warn(`Frame model ${model.id}@${model.version} failed on bundle ${bundle.id}: ${(err as Error).message}`);
      refused = ['model_error'];
    }
    // Question 6: any failed check discards the whole frame; its refusal is kept, its prose is not.
    return this.insert(m, tenantId, bundle.id, {
      id, renderer: 'model', rendererVersion: MODEL_RENDERER_VERSION, modelId: model.id, modelVersion: model.version,
      validation: answer ? 'passed' : 'refused', refusedChecks: refused, answer,
    });
  }

  private async insert(
    m: EntityManager, tenantId: string, bundleId: string,
    r: Pick<RecFrame, 'id' | 'renderer' | 'rendererVersion' | 'modelId' | 'modelVersion' | 'validation' | 'refusedChecks'> & { answer: GroundedAnswer | null },
  ): Promise<boolean> {
    const rows: unknown[] = await m.query(
      `INSERT INTO "rec_frame" ("id", "tenant_id", "bundle_id", "renderer", "renderer_version", "model_id", "model_version",
         "validation", "refused_checks", "answer")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb)
       ON CONFLICT DO NOTHING RETURNING "id"`,
      [r.id, tenantId, bundleId, r.renderer, r.rendererVersion, r.modelId, r.modelVersion, r.validation,
        r.refusedChecks, r.answer === null ? null : JSON.stringify(r.answer)],
    );
    return rows.length > 0;
  }

  private modelRow(m: EntityManager, bundleId: string, model: FrameModel): Promise<RecFrame | null> {
    return m.getRepository(RecFrame).findOne({
      where: { bundleId, renderer: 'model', rendererVersion: MODEL_RENDERER_VERSION, modelId: model.id, modelVersion: model.version },
    });
  }

  /** The passed model frame when the model is on and has one; otherwise this template version's frame. */
  private async served(m: EntityManager, bundleId: string): Promise<ServedFrame | null> {
    const model = this.activeModel;
    const modelFrame = model ? await this.modelRow(m, bundleId, model) : null;
    const row = modelFrame?.validation === 'passed'
      ? modelFrame
      : await m.getRepository(RecFrame).findOne({
        where: { bundleId, renderer: 'template', rendererVersion: TEMPLATE_VERSION, modelId: IsNull() },
      });
    if (!row) return null;
    return {
      answer: row.answer as unknown as GroundedAnswer,
      provenance: {
        renderer: row.renderer, rendererVersion: row.rendererVersion, modelId: row.modelId, modelVersion: row.modelVersion,
        bundleId,
      },
    };
  }
}
