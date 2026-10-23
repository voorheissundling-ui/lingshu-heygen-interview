/** Canonical public/application contracts for the 198 standard workspace. */

export const STARTER_198_PROFILE = 'starter_198' as const;
export const STARTER_198_PROFILE_VERSION = 'starter_198.v1' as const;

export const STARTER_AGENT_ROLES = ['orchestrator', 'content', 'traffic', 'sales'] as const;
export type StarterAgentRole = typeof STARTER_AGENT_ROLES[number];

/** Canonical approval node understood by the starter queue, decision service and package worker. */
export const STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY = 'starter_content_release_approval' as const;

export const STARTER_198_CAPABILITIES = [
  'workspace.read',
  'production_site.read',
  'orchestrator.command.submit',
  'orchestrator.decision.resolve',
  'workflow.standard.run',
  'workflow.run.pause',
  'workflow.run.resume',
  'workflow.run.cancel',
  'publishing.package.generate',
  'publishing.evidence.submit',
  'quotation.calculate',
  'agent.child.command',
  'production_site.write',
  'workflow.graph.edit',
  'workflow.task.control',
  'publishing.bulk_send',
  'publishing.paid_ads',
  'publishing.official_api',
  'studio.ai_video',
  'platform.internal_control',
] as const;
export type Starter198Capability = typeof STARTER_198_CAPABILITIES[number];

export const STARTER_198_COMMANDS = [
  'confirm_initial_setup',
  'confirm_quote_rule',
  'submit_quote_inquiry',
  'submit_orchestrator_input',
  'resolve_decision',
  'pause_run',
  'resume_run',
  'cancel_run',
  'generate_publication_package',
  'submit_publication_evidence',
  'submit_quote_send_evidence',
] as const;
export type Starter198Command = typeof STARTER_198_COMMANDS[number];

export interface Starter198QuoteRuleSetupInput {
  sku: string;
  currency: string;
  unitPrice: string;
  unitCost: string;
  moq: number;
  incoterm: 'EXW' | 'FOB' | 'CIF' | 'DDP';
  shippingFlatFee: string;
  taxRateBps: number;
  paymentTerm: string;
  leadTimeDays: number;
  validDays: number;
  minMarginBps: number;
  sourceReference: string;
}

export interface Starter198QuoteInquiryInput {
  sourceChannel: 'manual' | 'whatsapp' | 'email' | 'trade_show' | 'other';
  sourceReference: string;
  quantity: number;
  destinationCountry: string;
}

export type Starter198PresenterMode = 'brand_spokesperson' | 'product_expert' | 'none';

export interface Starter198PlannedAccount {
  platform: 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
  accountName: string;
  weeklyOutput: number;
}

/**
 * The user-confirmed operating limits for the first work cycle. These are
 * planning targets, not proof that a social account is connected and not
 * authorization to publish. Real publishing continues to use the separate
 * publishingTargets and approval/grant boundaries.
 */
export interface Starter198ConfirmedOperatingPlan {
  brandName: string;
  presenter: Starter198PresenterMode;
  plannedAccounts: Starter198PlannedAccount[];
  weeklyMasterCount: number;
  weeklyVariantCount: number;
  estimatedCostCny: { min: number; max: number };
  deliveryDays: number;
}

export interface Starter198InitialSetupInput {
  companyName: string;
  industry: string;
  primaryBusiness: string;
  focusProducts: string;
  targetMarkets: string;
  customerProfile: string;
  primaryPlatform: 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
  primaryLanguage: string;
  constraints: string[];
  /** Structured confirmation used by the planner. Legacy callers may omit it. */
  operatingPlan?: Starter198ConfirmedOperatingPlan;
}

export type Starter198OrgRole = 'owner' | 'admin' | 'operator' | 'customer_service';
export type StarterRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type StarterRunStatus = 'idle' | 'running' | 'waiting_user' | 'blocked' | 'error' | 'completed' | 'paused' | 'unknown';
export type StarterProductionSiteId = 'inspiration' | 'content' | 'traffic' | 'sales';

export interface Starter198ResourceLimits {
  workspaceCount: number;
  brandCount: number;
  memberCount: number;
  agentTeamCount: number;
  productCount: number;
  marketCount: number;
  buyerPersonaCount: number;
  languageCount: number;
  primaryPlatformCount: number;
  concurrentRunCount: number;
  contentArtifactCountPerCycle: number;
  contentRevisionCountPerCycle: number;
  publicationPackageCountPerContent: number;
  assistedSessionCount: number;
  inquiryAiCountPerCycle: number;
  quoteDraftCountPerCycle: number;
  highCostVideoCount: number;
  budgetCnyPerCycle: number;
  agentBudgetCny: Record<StarterAgentRole, number>;
}

export interface Starter198CapabilityDecision {
  allowed: boolean;
  reason:
    | 'allowed'
    | 'profile_denied'
    | 'entitlement_missing'
    | 'entitlement_disabled'
    | 'entitlement_expired'
    | 'resource_limit_unavailable';
}

export interface Starter198CapabilityManifest {
  schemaVersion: 'starter-198.capabilities.v1';
  productProfile: typeof STARTER_198_PROFILE;
  profileVersion: typeof STARTER_198_PROFILE_VERSION;
  entitlementSnapshotId: string;
  generatedAt: string;
  capabilities: Record<Starter198Capability, Starter198CapabilityDecision>;
  resourceLimits: Starter198ResourceLimits;
}

export interface Starter198ObjectRef {
  type: string;
  id: string;
  version?: string;
}

export interface AgentTaskEnvelopeV1 {
  schemaVersion: 'starter-198.agent-task.v1';
  tenantId: string;
  runId: string;
  taskId: string;
  correlationId: string;
  sourceAgent: StarterAgentRole;
  targetAgent: StarterAgentRole;
  goal: string;
  factSetVersion: string;
  policyVersion: string;
  entitlementSnapshotId: string;
  inputObjectRefs: Starter198ObjectRef[];
  expectedOutputSchema: string;
  riskLevel: StarterRiskLevel;
  budgetReservationId?: string;
  deadline: string;
  idempotencyKey: string;
}

export interface AgentTaskResultV1 {
  schemaVersion: 'starter-198.agent-result.v1';
  status: 'succeeded' | 'blocked' | 'failed' | 'cancelled';
  outputs: Starter198ObjectRef[];
  evidence: Starter198ObjectRef[];
  missingFacts: string[];
  risks: Array<{ level: StarterRiskLevel; code: string; summary: string }>;
  requiresDecision: boolean;
  suggestedNextAction: string | null;
  checkpoint: Record<string, unknown>;
}

export interface AgentHandoffV1 {
  schemaVersion: 'starter-198.agent-handoff.v1';
  tenantId: string;
  runId: string;
  taskId: string;
  handoffId: string;
  correlationId: string;
  sourceAgent: StarterAgentRole;
  targetAgent: 'orchestrator';
  result: AgentTaskResultV1;
  createdAt: string;
}

export interface StarterUsageLedgerEntryV1 {
  schemaVersion: 'starter-198.usage.v1';
  tenantId: string;
  runId: string;
  taskId: string;
  agentRole: StarterAgentRole;
  capability: Starter198Capability;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  estimatedCostCny: number | null;
  reservedCostDeltaCny: number | null;
  settledCostCny: number | null;
  costStatus: 'known' | 'unknown';
  outputCount: number;
  waitReason: string | null;
  anomalyCode: string | null;
  occurredAt: string;
}

export interface StarterWorkspaceAction {
  id: string;
  label: string;
  command: Starter198Command | null;
  kind: 'primary' | 'secondary' | 'danger' | 'download';
  href: string | null;
  disabledReason: string | null;
  expectedVersion: string | null;
}

export interface StarterTodayItem {
  id: string;
  what: string;
  ownerAgent: StarterAgentRole;
  why: string | null;
  status: string;
  output: string | null;
  next: string | null;
  evidence: string | null;
  updatedAt: string | null;
  actions: StarterWorkspaceAction[];
}

export interface StarterAgentUsage {
  role: StarterAgentRole;
  displayName: string;
  stage: string;
  status: StarterRunStatus;
  tokens: { input: number | null; output: number | null; cache: number | null; total: number | null };
  costCny: {
    estimated: number | null;
    reserved: number | null;
    settled: number | null;
    settlementStatus: 'settled' | 'pending' | 'unknown';
    updatedAt: string | null;
  };
  budgetCny: {
    total: number | null;
    used: number | null;
    reserved: number | null;
    remaining: number | null;
    projectedOverrun: boolean | null;
  };
  outputs: { completed: number | null; usable: number | null; awaitingDecision: number | null; summary: string | null };
  waits: { count: number; reasons: string[] };
  anomalies: string[];
  productionSite: StarterProductionSiteId | null;
}

export interface StarterWorkspaceV1 {
  productProfile: typeof STARTER_198_PROFILE;
  generatedAt: string;
  greeting: string | null;
  capabilityManifest: Starter198CapabilityManifest;
  run: { id: string | null; status: StarterRunStatus; cycleLabel: string | null; nextCheckpointAt: string | null };
  today: {
    completed: StarterTodayItem[];
    resultChanges: Array<{
      id: string;
      label: string;
      value: number | null;
      unit: string;
      delta: number | null;
      availability: 'available' | 'pending' | 'unavailable';
      note: string | null;
    }>;
    inProgress: StarterTodayItem[];
    nextSteps: StarterTodayItem[];
  };
  decisions: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    riskLevel: StarterRiskLevel | 'unknown';
    dueAt: string | null;
    recommendedOption: string | null;
    difference: string | null;
    effect: string | null;
    evidence: string | null;
    subjectVersion: string | null;
    actions: StarterWorkspaceAction[];
  }>;
  results: {
    stages: Array<{ id: string; label: string; value: number | null; availability: 'available' | 'pending' | 'unavailable'; source: string | null; note: string | null }>;
    artifacts: Array<{ id: string; title: string; kind: string; status: string; agentRole: StarterAgentRole; createdAt: string | null; evidence: string | null; actions: StarterWorkspaceAction[] }>;
  };
  agents: StarterAgentUsage[];
  productionSites: Array<{
    id: StarterProductionSiteId;
    title: string;
    agentRole: StarterAgentRole;
    summary: string;
    status: StarterRunStatus;
    updatedAt: string | null;
    sections: Array<{
      id: string;
      label: string;
      status: string;
      count: number | null;
      items: Array<{ id: string; title: string; summary: string | null; status: string; updatedAt: string | null; evidence: string | null }>;
    }>;
  }>;
  controls: StarterWorkspaceAction[];
}

export interface StarterWorkspaceCommandInput {
  command: Starter198Command | string;
  idempotencyKey: string;
  targetId?: string;
  expectedVersion?: string;
  payload?: Record<string, unknown>;
}

export interface StarterWorkspaceCommandResult {
  accepted: boolean;
  commandId: string | null;
  message: string | null;
  workspace?: StarterWorkspaceV1;
}
