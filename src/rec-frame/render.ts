import { BundleView, frameId, GroundedAnswer } from './grounded-answer';
import { template, TEMPLATE_VERSION, TemplateKey } from './templates';

/** What a next step reports as needed to act on it — reported, never granting (the contract's words). */
const STEP_CAPABILITY = 'action.work';

export function templateFrameId(bundleId: string): string {
  return frameId(`${bundleId}|template|${TEMPLATE_VERSION}`);
}

/**
 * The deterministic renderer (task QREC2 §1–§3, D36): bundle in, GroundedAnswerV1 out,
 * nothing looked up and nothing generated. Pure, so the same bundle always renders
 * byte-identically — which is what makes one stored row per bundle per template version
 * honest.
 */
export function renderTemplateFrame(b: BundleView): GroundedAnswer {
  const cls = b.classSlug ?? 'unclassified';
  const ptr = (path: string) => `rec_evidence_bundle:${b.id}#${path}`;
  const modeName = new Map(b.attribute.modes.map((m) => [m.failureModeCode, m.name]));
  const nameOf = (code: string) => modeName.get(code) ?? code;
  const active = b.attribute.modes.filter((m) => m.status === 'active');
  const alertRefsFor = (signals: string[]) => b.detect.entries
    .filter((e) => signals.includes(e.signal))
    .flatMap((e) => e.sources.filter((s) => s.kind === 'alert' && s.ref).map((s) => s.ref!));

  // -- Selection (§2, D22): the first candidate in QREC1's order not already in hand.
  // The steps are the selected one, then the rest of its failure mode's (question 2: one
  // mode, not every action for every possible cause), then anything ranked above it —
  // which, by the rule that picked it, is already in hand, and is said to be.
  const selectedAt = Math.max(0, b.candidates.findIndex((c) => !c.inHand));
  const selected = b.candidates[selectedAt] ?? null;
  const steps = selected
    ? [selected,
      ...b.candidates.filter((c, i) => i > selectedAt && c.failureModeCode === selected.failureModeCode),
      ...b.candidates.slice(0, selectedAt)]
    : [];
  const next_steps = steps.map((c) => ({
    // Verbatim: the library's wording is what a technician was trained on (check 5).
    aim: c.action,
    expected_outcome: c.inHand
      ? template('gap.in_hand')({ mode: nameOf(c.failureModeCode) })
      : template('gap.expected_outcome')({ mode: nameOf(c.failureModeCode) }),
    required_capability: STEP_CAPABILITY,
    simulation_available: false,
  }));

  // -- Observations ---------------------------------------------------------------
  const observations: GroundedAnswer['observations'] = [];
  b.detect.entries.forEach((e, i) => {
    if (e.state === 'normal') return;
    const alerts = e.sources.filter((s) => s.kind === 'alert' && s.ref);
    if (e.state === 'anomalous') {
      observations.push({
        claim: template('detect.anomalous')({ signal: e.signal, triggers: [...new Set(alerts.map((s) => s.trigger ?? 'alert'))] }),
        evidence_refs: alerts.map((s) => s.ref!),
      });
      return;
    }
    let claim: string;
    if (e.state === 'baseline_not_established') claim = template('detect.baseline_not_established')({ signal: e.signal });
    else if (e.reason === 'stale' && e.lastReadingAt) claim = template('detect.not_observed.stale')({ signal: e.signal, lastReadingAt: e.lastReadingAt });
    else if (e.reason === 'stale' || e.reason === 'no_readings') claim = template('detect.not_observed.no_readings')({ signal: e.signal });
    else claim = template(`detect.not_observed.${e.reason}` as TemplateKey)({ signal: e.signal } as never);
    observations.push({ claim, evidence_refs: [ptr(`/detect/entries/${i}`), ...alerts.map((s) => s.ref!)] });
  });
  for (const u of b.attribute.unattributed) {
    observations.push({ claim: template('attribute.unattributed')({ signal: u.signal, cls }), evidence_refs: u.refs });
  }

  const sources = b.precedent.coverage.sources;
  const noHistory = Object.values(sources).every((s) => s.rows === 0);
  if (noHistory) {
    observations.push({ claim: template('precedent.no_history')(), evidence_refs: [ptr('/precedent/coverage')] });
  } else {
    // Precedent for every mode the frame talks about: the active ones and those it cannot rule out.
    const talkedAbout = new Set(b.attribute.modes.filter((m) => m.status !== 'clear').map((m) => m.failureModeCode));
    b.precedent.modes.forEach((p, i) => {
      if (!talkedAbout.has(p.failureModeCode)) return;
      if (p.state === 'found') {
        observations.push({
          claim: template('precedent.found')({
            mode: nameOf(p.failureModeCode), alerts: p.alertEvents.length, orders: p.workOrders.length,
            hours: p.workOrders.map((w) => w.observedHours).filter((h): h is number => h !== null),
          }),
          evidence_refs: [
            ...p.alertEvents.map((x) => `alert_event:${x.id}`), ...p.workOrders.map((x) => `work_order:${x.id}`),
            ...p.serviceRecords.map((x) => `equipment_service_record:${x.id}`),
          ],
        });
      } else if (p.state === 'none_found' && b.precedent.coverage.period.from) {
        observations.push({
          claim: template('precedent.none_found')({ mode: nameOf(p.failureModeCode), since: b.precedent.coverage.period.from }),
          evidence_refs: [ptr(`/precedent/modes/${i}`)],
        });
      }
    });
  }

  const limitations: string[] = [];
  const costBlocked = new Set<string>();
  b.cost.lines.forEach((l, i) => {
    const step = steps.find((c) => c.recommendationId === l.recommendationId);
    if (!step || l.line !== 'labour') return;
    const r = l.result;
    if (r.status === 'ready' && r.value !== null && r.unit && step.estimatedHours !== null) {
      observations.push({
        claim: template('cost.ready')({
          action: step.action, hours: step.estimatedHours, value: r.value, currency: r.unit,
          scope: (r.parameter_set_version ?? '').split(':')[0],
        }),
        evidence_refs: [ptr(`/cost/lines/${i}`), `client_equipment_class_recommendation:${step.recommendationId}`],
      });
    } else if (r.reasons.includes('validation_required')) {
      costBlocked.add(template('cost.validation_required')({ action: step.action }));
    } else if (r.reasons.includes('parameters_required')) {
      costBlocked.add(template('cost.parameters_required')({ missing: b.cost.missingParameters }));
    }
  });

  // -- Hypotheses: consistent with, never caused by --------------------------------
  const hypotheses = active.map((m) => ({
    claim: template('attribute.active')({ mode: m.name, cls, signals: m.matchedSignals }),
    evidence_refs: alertRefsFor(m.matchedSignals),
    limitations: [
      ...(m.unobservedSignals.length ? [template('gap.unobserved')({ signals: m.unobservedSignals })] : []),
      template('limitation.attribution_is_lookup')(),
    ],
  }));

  // -- Limitations: every gap QREC1 recorded --------------------------------------
  for (const m of b.attribute.modes.filter((x) => x.status === 'unknown' && x.unobservedSignals.length)) {
    limitations.push(template('attribute.unknown')({ mode: m.name, signals: m.unobservedSignals }));
  }
  for (const code of b.gap.noLibraryRecommendation) {
    limitations.push(template('gap.no_library_recommendation')({ mode: nameOf(code), cls }));
  }
  if (b.detect.unattributableAlerts.length) {
    limitations.push(template('limitation.unattributable_alert')({ count: b.detect.unattributableAlerts.length }));
  }
  if (b.detect.coverage.sources?.residual === 'not_available') limitations.push(template('limitation.no_forecast_model')());
  limitations.push(...costBlocked);
  if (steps.length) limitations.push(template('cost.pending')());
  limitations.push(template('limitation.no_reference_documents')());

  // -- Summary and status (§1.1) ---------------------------------------------------
  let summary: string;
  let status: GroundedAnswer['status'];
  if (b.status === 'not_configured') {
    status = 'needs_input';
    summary = b.reason === 'unclassified' ? template('summary.unclassified')()
      : b.reason === 'class_not_in_account' ? template('summary.class_not_in_account')({ cls })
        : template('summary.no_library_content')({ cls });
  } else if (b.status === 'blocked') {
    status = 'insufficient_evidence';
    summary = template('summary.insufficient_coverage')({ expected: b.detect.coverage.expected.length });
  } else if (b.outcome === 'attributed') {
    const top = active[0];
    status = active.every((m) => m.unobservedSignals.length === 0) ? 'answered' : 'partial';
    summary = template('summary.attributed')({
      mode: top.name, signals: top.matchedSignals, also: active.slice(1).map((m) => m.name),
      stepsFor: selected ? nameOf(selected.failureModeCode) : null,
    });
    if (!b.candidates.some((c) => c.failureModeCode === top.failureModeCode)) {
      summary += ` ${template('gap.no_library_recommendation')({ mode: top.name, cls })}`;
    }
  } else if (b.outcome === 'unattributed') {
    status = 'partial';
    summary = template('summary.unattributed')({ signals: b.attribute.unattributed.map((u) => u.signal), cls });
  } else if (b.outcome === 'inconclusive') {
    status = 'partial';
    const unseen = [...new Set(b.attribute.modes.filter((m) => m.status === 'unknown').flatMap((m) => m.unobservedSignals))].sort();
    summary = template('summary.inconclusive')({ signals: unseen });
  } else {
    status = 'answered';
    summary = template('summary.nothing_detected')({
      observed: b.detect.coverage.observed.length, expected: b.detect.coverage.expected.length,
    });
  }

  const missing_inputs = [
    ...b.cost.missingParameters,
    ...b.detect.entries.filter((e) => e.reason === 'unbound').map((e) => `signal_binding:${e.signal}`),
  ];

  return {
    answer_id: templateFrameId(b.id),
    // Question 1: the bundle is the context this answer was grounded in; nothing produces an EquipmentContextV1.
    context_id: b.id,
    status,
    summary,
    observations,
    hypotheses,
    next_steps,
    // §7: citations need QEMB1 and a knowledge corpus; until then there is nothing to cite.
    citations: [],
    missing_inputs,
    as_of: b.asOf,
    limitations,
  };
}
