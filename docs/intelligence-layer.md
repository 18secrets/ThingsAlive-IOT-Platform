# The intelligence layer — the last phase, on purpose

*Recorded 13 September 2026, at Things Alive's request, so it is not rediscovered as a
surprise. Nothing in this document is built. It is here to stop the rest of the
platform being shaped in a way that makes it hard to build later.*

## What it is

Things Alive: *"we have a formula option to identify the equipment status if it's not
coming, and many other calculations and status we will work through the physical ML
module, which will be the intelligence layer based on the raw data."*

Two things, and they are different sizes.

**Formulas — derived values.** A value the platform needs that the machine does not
report, computed from ones it does. Equipment running status is the example that
prompted this: `engine_running_status` arrives as a signal today, and where it does
not, it can be inferred — from ignition, from load, from fuel rate, from a
combination. The same applies to anything else a customer's fleet does not instrument
directly.

**The physical ML module — the intelligence layer.** Calculations and statuses derived
from the raw data by a model rather than by arithmetic. This is the end state of what
the tiered scoring design already anticipates: Tier 1 is a z-score against a baseline,
and everything beyond it is this.

## Why it is last, and why that is right

It is last because it is the only part that cannot be built early. Every layer under
it is what it consumes: the telemetry has to arrive, be resolved to a tenant, be
attached to a machine, be bounded by a shift, and be explainable, before a model has
anything trustworthy to learn from. A model built on a pipeline that is still moving
learns the pipeline.

## What must stay true so it is buildable when its turn comes

These are commitments the platform has already made and should keep, not new work.

**The raw data survives.** `telemetry_reading` keeps every reading with both clocks —
the logger's and the platform's — and its dedupe key is `(imei, signal,
source_timestamp)`. A model that learns from this needs the readings as they were, not
a summary somebody decided was sufficient. Nothing should start discarding or
pre-aggregating telemetry without deciding this question first.

**Derived is distinguishable from measured.** Today a reading arrives from a device. A
derived value does not. The moment both are stored in the same table with no way to
tell them apart, every later question — what did the machine say, what did we infer,
which of those was wrong — becomes unanswerable. When formulas arrive, a derived value
needs its own provenance, the same way `prediction.model_ref` names which scorer
produced an answer and `equipment_profile.origin` names whether a machine was mirrored
or created here.

**A model is a version, not a deployment.** `prediction.model_ref` already exists for
this reason: two Tier 2 models disagreeing about the same asset is a question somebody
will ask, and it is unanswerable without knowing which produced which answer. The
registry task (P3-01) is the shape of it.

**Confidence is never inferred from severity.** The scorer already distinguishes full,
partial and none, and a prediction of confidence `none` is not "fine" — it is "nothing
was said". A model that cannot express uncertainty will be believed when it should not
be, and the platform already refuses to raise work from an unscored prediction for
exactly that reason.

**Windows are honest about what was in them.** A shift where the machine never ran is
recorded as such and not scored, and a window whose readings arrived late is scored
again. Training on windows that the runtime knows were thin or idle would teach a
model that idle machines are normal-looking, which is the failure mode it exists to
catch.

## What this document is not

It is not a design. The questions that decide the shape of it — what is predicted, over
what horizon, trained on whose data, and what a wrong answer costs — are open, and
guessing at them now would be the same mistake as building it now.

## Tracked as

`P4-01` in the build plan, with the standing commitments above as the reason the
earlier phases were built the way they were.
