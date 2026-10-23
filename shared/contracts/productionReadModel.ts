/**
 * Provider-neutral production projection shared by task detail, Studio,
 * digital employees and the assistant. It is intentionally read-only: every
 * command remains subject to the canonical server mutation and authority gate.
 */

export const PRODUCTION_READ_MODEL_SCHEMA = 'production-read-model.v1' as const;

export const PRODUCTION_ALLOWED_COMMANDS = [
  'open_project',
  'open_shot',
  'select_material',
  'upload_product_asset',
  'select_presenter',
  'confirm_facts',
  'confirm_rights',
  'confirm_budget',
  'connect_account',
  'confirm_production_choice',
  'generate',
  'retry',
  'use_fallback',
  'request_shoot',
  'review_output',
  'approve_output',
] as const;
export type ProductionAllowedCommand = typeof PRODUCTION_ALLOWED_COMMANDS[number];

export type ProductionRouteKind =
  | 'material_edit'
  | 'digital_human'
  | 'motion_graphics'
  | 'aigc_visual'
  | 'product_composite'
  | 'product_scene'
  | 'user_capture'
  | 'unknown';

export type ProductionReadStatus =
  | 'planning'
  | 'needs_input'
  | 'ready'
  | 'running'
  | 'rendering'
  | 'quality_review'
  | 'review_ready'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'blocked';

export type ProductionPipelinePhase = 'planning' | 'input' | 'production' | 'render' | 'qa' | 'review';
export type ProductionPipelinePhaseStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'not_applicable';

export type ProductionIdentityLevel =
  | 'not_required'
  | 'exact_source'
  | 'locked_reference'
  | 'qa_gated'
  | 'generic_only'
  | 'unverified';

export interface ProductionIdentityGuarantee {
  overall: ProductionIdentityLevel;
  product: ProductionIdentityLevel;
  presenter: ProductionIdentityLevel;
  requiresQa: boolean;
  basis: string[];
}

export type ProductionInputKind =
  | 'material'
  | 'product_asset'
  | 'presenter_asset'
  | 'reference_media'
  | 'fact_confirmation'
  | 'rights_confirmation'
  | 'account_authorization'
  | 'production_choice'
  | 'budget_confirmation'
  | 'shooting_media'
  | 'quality_review'
  | 'other';

export type ProductionInputStatus = 'provided' | 'missing' | 'pending_confirmation' | 'not_applicable';

export interface ProductionInputRequirement {
  id: string;
  kind: ProductionInputKind;
  label: string;
  required: boolean;
  status: ProductionInputStatus;
  reason: string | null;
  source: 'canonical_task' | 'execution_plan' | 'studio_project' | 'production_receipt';
}

export interface ProductionInputSummary {
  required: string[];
  missing: string[];
  items: ProductionInputRequirement[];
}

export type ProductionCostStatus = 'free' | 'estimated' | 'partially_settled' | 'settled' | 'unknown';

export interface ProductionCostSummaryV1 {
  currency: 'CNY';
  expectedCny: number | null;
  upperBoundCny: number | null;
  actualCny: number | null;
  unsettledCny: number | null;
  status: ProductionCostStatus;
  reusable: boolean;
  basis: 'execution_plan' | 'provider_receipt' | 'mixed' | 'unavailable';
}

export interface ProductionBlocker {
  code: string;
  message: string;
  recoverable: boolean;
  inputId: string | null;
}

export interface ProductionRouteRef {
  kind: ProductionRouteKind;
  sourceStrategy: string | null;
  label: string;
  executable: boolean;
  reason: string | null;
}

export interface ProductionShotRoute {
  selected: ProductionRouteRef | null;
  recommended: ProductionRouteRef;
  fallbacks: ProductionRouteRef[];
}

export interface ProductionShotReadModelV1 {
  shotId: string;
  slotId: string | null;
  order: number;
  title: string;
  route: ProductionShotRoute;
  status: ProductionReadStatus;
  executable: boolean;
  identityGuarantee: ProductionIdentityGuarantee;
  inputs: ProductionInputSummary;
  cost: ProductionCostSummaryV1;
  blockers: ProductionBlocker[];
  allowedCommands: ProductionAllowedCommand[];
}

export interface ProductionReadModelV1 {
  schemaVersion: typeof PRODUCTION_READ_MODEL_SCHEMA;
  authority: 'canonical_task';
  project: {
    kind: string;
    id: string;
    version: string;
    title: string;
    taskStatus: string;
    runId: string | null;
    studioProjectId: string | null;
    studioProjectVersion: string | null;
    studioProjectStatus: string | null;
    studioProjectConflict: boolean;
  };
  aggregate: {
    stage: ProductionPipelinePhase;
    status: ProductionReadStatus;
    executable: boolean;
    identityGuarantee: ProductionIdentityGuarantee;
    inputs: ProductionInputSummary;
    cost: ProductionCostSummaryV1;
    blockers: ProductionBlocker[];
    counts: {
      total: number;
      ready: number;
      running: number;
      needsInput: number;
      blocked: number;
      review: number;
      completed: number;
    };
    phases: Array<{ phase: ProductionPipelinePhase; status: ProductionPipelinePhaseStatus }>;
    allowedCommands: ProductionAllowedCommand[];
  };
  shots: ProductionShotReadModelV1[];
  updatedAt: string;
}
