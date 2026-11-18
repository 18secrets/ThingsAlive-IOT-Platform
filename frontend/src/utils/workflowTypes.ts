// Alert workflows' graph (QWF1), on their own so the prompt reader (workflowParser.ts) can
// be tested from the backend's suite without compiling the whole API client. lib/api.ts
// re-exports them; import them from there as before.

export type WorkflowNodeType =
  | "ReadSignal" | "Threshold" | "FreshnessGate" | "PredictionSeverity" | "FuelLoss" | "ChainOrigin"
  | "AllOf" | "AnyOf" | "Notify";

export interface WorkflowSpecNode {
  id: string;
  type: WorkflowNodeType;
  params?: Record<string, string | number | boolean | null>;
}

export interface WorkflowScope {
  appliesTo: "account" | "plant" | "equipment" | "equipment-class";
  plantId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  equipmentClassSlug?: string | null;
}

export interface WorkflowSpec {
  kind: "alert";
  scope: WorkflowScope;
  nodes: WorkflowSpecNode[];
  edges: { from: string; to: string }[];
}

export type WorkflowVersionStatus = "draft" | "published" | "superseded" | "retired";
