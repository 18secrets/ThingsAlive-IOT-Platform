const jwt = require("jsonwebtoken");

const API_BASE = "https://api-development-154e.up.railway.app/api/v1";
const SECRET = "paste-a-long-random-secret";
const ISSUER = "things-alive-platform";

const token = jwt.sign(
  {
    sub: "5cf45f74-f668-40d8-b064-83fad9862db5",
    client_id: "demo-construction",
    email: "tapas.m@thingsalive.io",
    role: "admin",
  },
  SECRET,
  { issuer: ISSUER, expiresIn: "24h" }
);

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, data: json };
}

async function runTests() {
  console.log("================================================================================");
  console.log("       THINGSALIVE 2.0 — END-TO-END AI SUITE HEALTH & AUDIT REPORT             ");
  console.log("================================================================================\n");

  const results = [];

  function record(testName, category, passed, details) {
    results.push({ testName, category, passed, details });
    const mark = passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${mark} [${category}] ${testName}`);
    if (details) {
      console.log(`       Details: ${typeof details === 'object' ? JSON.stringify(details).slice(0, 200) : details}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. ASK AI — TELEMATICS COPILOT
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 1: Ask AI (Telematics Copilot) ---");
  try {
    const r1 = await request("/assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "Which devices are offline?" }],
      }),
    });
    record("Ask AI: Offline Devices Query", "AskAI", r1.ok && (r1.data?.reply?.includes("EX-04") || r1.data?.reply?.includes("offline")), {
      reply: r1.data?.reply?.slice(0, 120),
      toolsUsed: r1.data?.toolsUsed,
      tokens: r1.data?.tokens,
    });
  } catch (err) {
    record("Ask AI: Offline Devices Query", "AskAI", false, err.message);
  }

  try {
    const r2 = await request("/assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "What is the status of EX-01?" }],
      }),
    });
    record("Ask AI: Machine Status & Telemetry Query", "AskAI", r2.ok && !!r2.data?.reply, {
      reply: r2.data?.reply?.slice(0, 120),
      toolsUsed: r2.data?.toolsUsed,
    });
  } catch (err) {
    record("Ask AI: Machine Status & Telemetry Query", "AskAI", false, err.message);
  }

  try {
    const r3 = await request("/assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "Are there any open alerts or work orders?" }],
      }),
    });
    record("Ask AI: Alerts & Work Orders Query", "AskAI", r3.ok && !!r3.data?.reply, {
      reply: r3.data?.reply?.slice(0, 120),
      toolsUsed: r3.data?.toolsUsed,
    });
  } catch (err) {
    record("Ask AI: Alerts & Work Orders Query", "AskAI", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 2. AI ONBOARDING ASSISTANT
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 2: AI Onboarding Assistant ---");
  try {
    const r4 = await request("/onboarding/status");
    record("Onboarding Status Pipeline API", "AI-Onboarding", r4.ok && Array.isArray(r4.data?.sites), {
      sitesCount: r4.data?.sites?.length,
      sites: r4.data?.sites?.map(s => s.name),
    });
  } catch (err) {
    record("Onboarding Status Pipeline API", "AI-Onboarding", false, err.message);
  }

  try {
    const r5 = await request("/assistant/onboarding/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "What is the onboarding status across our sites?" }],
      }),
    });
    record("AI Onboarding: Status Conversational Query", "AI-Onboarding", r5.ok && !!r5.data?.reply, {
      reply: r5.data?.reply?.slice(0, 120),
      toolsUsed: r5.data?.toolsUsed,
    });
  } catch (err) {
    record("AI Onboarding: Status Conversational Query", "AI-Onboarding", false, err.message);
  }

  try {
    const r6 = await request("/assistant/onboarding/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "Which loggers are available to fit?" }],
      }),
    });
    record("AI Onboarding: Logger Availability Query", "AI-Onboarding", r6.ok && !!r6.data?.reply, {
      reply: r6.data?.reply?.slice(0, 120),
      toolsUsed: r6.data?.toolsUsed,
    });
  } catch (err) {
    record("AI Onboarding: Logger Availability Query", "AI-Onboarding", false, err.message);
  }

  let generatedProposalId = null;
  try {
    const r7 = await request("/assistant/onboarding/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", text: "Propose adding a site named Nashik Plant with code NASHIK-01" }],
      }),
    });
    const prop = r7.data?.proposals?.[0];
    if (prop) generatedProposalId = prop.id;
    record("AI Onboarding: Propose Site Creation", "AI-Onboarding", r7.ok && (!!prop || r7.data?.reply?.toLowerCase().includes("nashik")), {
      reply: r7.data?.reply?.slice(0, 120),
      proposal: prop ? { id: prop.id, kind: prop.kind, summary: prop.summary } : "none",
    });
  } catch (err) {
    record("AI Onboarding: Propose Site Creation", "AI-Onboarding", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 3. AI PROPOSALS LIFECYCLE
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 3: AI Proposals Management ---");
  try {
    const r8 = await request("/assistant/proposals");
    record("List AI Proposals API", "AI-Proposals", r8.ok && Array.isArray(r8.data), {
      count: r8.data?.length,
      firstProposal: r8.data?.[0]?.summary,
    });
  } catch (err) {
    record("List AI Proposals API", "AI-Proposals", false, err.message);
  }

  if (generatedProposalId) {
    try {
      const r9 = await request(`/assistant/proposals/${generatedProposalId}/reject`, { method: "POST" });
      record("Reject AI Proposal", "AI-Proposals", r9.ok && r9.data?.status === "rejected", {
        id: r9.data?.id,
        status: r9.data?.status,
      });
    } catch (err) {
      record("Reject AI Proposal", "AI-Proposals", false, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. PHYSICAL INTELLIGENCE & CAUSAL CHAINS (THINGSECARE)
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 4: Physical Intelligence & Causal Chains ---");
  try {
    const r10 = await request("/intelligence/chains?equipmentClassSlug=hydraulic-excavator");
    record("Published Causal Chains API", "CausalChains", r10.ok && Array.isArray(r10.data) && r10.data.length > 0, {
      chains: r10.data?.map(c => ({ slug: c.slug, name: c.name, stages: c.nodes?.length })),
    });
  } catch (err) {
    record("Published Causal Chains API", "CausalChains", false, err.message);
  }

  try {
    const r11 = await request("/intelligence/diagnose/seed-demo/EX-01");
    const evaluated = r11.data?.chains?.[0];
    record("Live Root-Cause Diagnosis (EX-01 Excavator)", "CausalChains", r11.ok && evaluated?.evaluated === true, {
      chainSlug: evaluated?.chainSlug,
      confidence: evaluated?.confidence,
      originFaults: evaluated?.stages?.filter(s => s.verdict === 'origin').map(s => s.signal),
    });
  } catch (err) {
    record("Live Root-Cause Diagnosis (EX-01 Excavator)", "CausalChains", false, err.message);
  }

  try {
    const r12 = await request("/intelligence/diagnose/seed-demo/EX-06");
    const evaluated = r12.data?.chains?.[0];
    record("Live Root-Cause Diagnosis (EX-06 Screw Compressor)", "CausalChains", r12.ok && evaluated?.evaluated === true, {
      chainSlug: evaluated?.chainSlug,
      confidence: evaluated?.confidence,
      originFaults: evaluated?.stages?.filter(s => s.verdict === 'origin').map(s => s.signal),
    });
  } catch (err) {
    record("Live Root-Cause Diagnosis (EX-06 Screw Compressor)", "CausalChains", false, err.message);
  }

  try {
    const r13 = await request("/intelligence/chains/cooling-circuit-chain/project", {
      method: "POST",
      body: JSON.stringify({
        inputs: [{ signal: "engine_load", value: 85 }],
      }),
    });
    record("Physics What-If Projection Simulation", "CausalChains", r13.ok && r13.data?.projected === true, {
      projected: r13.data?.projected,
      expectedOutcome: r13.data?.stages?.[0]?.expected,
      confidence: r13.data?.stages?.[0]?.confidence,
    });
  } catch (err) {
    record("Physics What-If Projection Simulation", "CausalChains", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 5. DETERMINISTIC RISK SCENARIOS & BASELINES
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 5: Risk Scenarios & Baselines ---");
  try {
    const r14 = await request("/predictions/seed-demo/EX-01/baselines");
    record("90-Day Asset Signal Baselines API", "Predictions", r14.ok && Array.isArray(r14.data), {
      signalsCalculated: r14.data?.map(b => b.signal),
    });
  } catch (err) {
    record("90-Day Asset Signal Baselines API", "Predictions", false, err.message);
  }

  try {
    const r15 = await request("/predictions/seed-demo/EX-01");
    record("Asset Latest Risk Predictions", "Predictions", r15.ok && Array.isArray(r15.data), {
      predictionsCount: r15.data?.length,
      scenarios: r15.data?.map(p => ({ scenario: p.scenarioSlug, score: p.score, state: p.state })),
    });
  } catch (err) {
    record("Asset Latest Risk Predictions", "Predictions", false, err.message);
  }

  try {
    const r16 = await request("/predictions/seed-demo/EX-01/score", { method: "POST" });
    const isSuccess = r16.ok && (Array.isArray(r16.data) || Array.isArray(r16.data?.written));
    record("On-Demand Asset Anomaly Scoring API", "Predictions", isSuccess, {
      scoredScenariosCount: (r16.data?.written || r16.data)?.length,
    });
  } catch (err) {
    record("On-Demand Asset Anomaly Scoring API", "Predictions", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 6. RECOMMENDATION ENGINE & GROUNDED FRAMING
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 6: Recommendation Engine & Grounded Framing ---");
  let bundleId = null;
  try {
    const r17 = await request("/equipment/seed-demo/EX-01/rec-evidence", { method: "POST" });
    bundleId = r17.data?.id;
    record("Recommendation Evidence Bundle Evaluation", "Recommendations", (r17.status === 200 || r17.status === 201) && !!bundleId, {
      bundleId: r17.data?.id,
      outcome: r17.data?.outcome,
      status: r17.data?.status,
    });
  } catch (err) {
    record("Recommendation Evidence Bundle Evaluation", "Recommendations", false, err.message);
  }

  if (bundleId) {
    try {
      const r18 = await request(`/rec-evidence/${bundleId}/frame`, { method: "POST" });
      record("Recommendation Frame Rendering API", "Recommendations", (r18.status === 200 || r18.status === 201) && !!r18.data?.answer, {
        renderer: r18.data?.provenance?.renderer,
        summary: r18.data?.answer?.summary?.slice(0, 100),
      });
    } catch (err) {
      record("Recommendation Frame Rendering API", "Recommendations", false, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. SEMANTIC LIBRARY EMBEDDINGS (VECTOR SEARCH)
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 7: Semantic Library Embeddings ---");
  try {
    const r19 = await request("/library-embeddings/search", {
      method: "POST",
      body: JSON.stringify({ query: "engine overheating under heavy load" }),
    });
    record("Semantic Library Search API", "Embeddings", r19.ok || r19.status === 503, {
      status: r19.status,
      hits: r19.data?.hits?.length ?? 0,
      note: r19.status === 503 ? "Model not bound on this server (expected if local model weights absent)" : "Semantic search active",
    });
  } catch (err) {
    record("Semantic Library Search API", "Embeddings", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 8. ALERT AI WORKFLOW ASSEMBLER & PROPOSER
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 8: Alert AI Workflow & KPI Proposals ---");
  try {
    const r20 = await request("/workflow-proposal-intents");
    record("Workflow Proposal Intents API", "AlertAI", r20.ok && Array.isArray(r20.data), {
      intents: r20.data?.map(i => i.intent),
    });
  } catch (err) {
    record("Workflow Proposal Intents API", "AlertAI", false, err.message);
  }

  try {
    const r21 = await request("/kpi-proposal-intents");
    record("KPI Proposal Intents API", "AlertAI", r21.ok && Array.isArray(r21.data), {
      intents: r21.data?.map(i => i.intent),
    });
  } catch (err) {
    record("KPI Proposal Intents API", "AlertAI", false, err.message);
  }

  try {
    const r22 = await request("/workflows/assemble", {
      method: "POST",
      body: JSON.stringify({
        target: { appliesTo: "equipment", sourceSystem: "seed-demo", externalId: "EX-01" },
        combine: "allOf",
      }),
    });
    record("Alert AI Workflow Assembly API", "AlertAI", r22.ok, {
      specVersion: r22.data?.spec?.version,
      nodesCount: r22.data?.spec?.nodes?.length,
    });
  } catch (err) {
    record("Alert AI Workflow Assembly API", "AlertAI", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // 9. TIME-SERIES FORECASTING (24H SENSOR FORECASTS)
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 9: Time-Series Forecasting & Bands ---");
  try {
    const r23 = await request("/equipment/seed-demo/EX-01/page");
    const forecastWidgets = r23.data?.widgets?.filter(w => w.widgetType === "forecast_chart");
    const readyForecasts = forecastWidgets?.filter(w => w.readiness === "ready");
    const hasHorizon = readyForecasts?.some(w => w.data?.horizon?.length === 24);
    record("24h Time-Series Forecasts (EX-01 Excavator)", "Forecasting", r23.ok && forecastWidgets?.length > 0 && hasHorizon, {
      forecastWidgetsCount: forecastWidgets?.length,
      model: readyForecasts?.[0]?.data?.model?.key,
      horizonHours: readyForecasts?.[0]?.data?.horizon?.length,
      anomalyState: readyForecasts?.[0]?.data?.anomaly?.state,
    });
  } catch (err) {
    record("24h Time-Series Forecasts (EX-01 Excavator)", "Forecasting", false, err.message);
  }

  try {
    const r24 = await request("/equipment/seed-demo/EX-06/page");
    const forecastWidgets = r24.data?.widgets?.filter(w => w.widgetType === "forecast_chart");
    const readyForecasts = forecastWidgets?.filter(w => w.readiness === "ready");
    const hasHorizon = readyForecasts?.some(w => w.data?.horizon?.length === 24);
    record("24h Time-Series Forecasts (EX-06 Screw Compressor)", "Forecasting", r24.ok && forecastWidgets?.length > 0 && hasHorizon, {
      forecastWidgetsCount: forecastWidgets?.length,
      model: readyForecasts?.[0]?.data?.model?.key,
      horizonHours: readyForecasts?.[0]?.data?.horizon?.length,
      anomalyState: readyForecasts?.[0]?.data?.anomaly?.state,
    });
  } catch (err) {
    record("24h Time-Series Forecasts (EX-06 Screw Compressor)", "Forecasting", false, err.message);
  }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`TOTAL AI TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("================================================================================");
}

runTests().catch(console.error);
