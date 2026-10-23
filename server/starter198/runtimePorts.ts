import type {
  AgentTaskEnvelopeV1,
  AgentTaskResultV1,
  Starter198InitialSetupInput,
  Starter198OrgRole,
  Starter198QuoteInquiryInput,
  Starter198QuoteRuleSetupInput,
} from '../../shared/contracts/starter198.js';

/**
 * Explicit production integration points. There are deliberately no default
 * implementations: an unavailable worker or quote engine must be reported,
 * never simulated by a successful command response.
 */
export interface Starter198OrchestratorQueuePort {
  enqueue(input: {
    tenantId: string;
    userId: string;
    commandId: string;
    input: string;
    idempotencyKey: string;
    workflowScope?: 'starter_standard' | 'social_content';
    subject?: {
      type: 'social_content_task';
      id: string;
      /** Task version presented when the durable start command was admitted. */
      admissionVersion: string;
      /** Task version after the pre-start projection has been reconciled. */
      version: string;
      sourceRefs: Array<{ id: string; version?: string }>;
      packageSelection: Array<{ kind: string; packageKey: string; version: string }>;
      conversionObjective: boolean;
    };
  }): Promise<Starter198OrchestratorQueueResult>;
}

/** Deliberately separate from the ordinary queue port: a prepared image
 * revision cannot enter the canonical start/production runner by cast or
 * structural subtyping. Only its dedicated scheduler accepts this variant. */
export interface Starter198SocialAssetRevisionQueueInput {
  tenantId:string;userId:string;commandId:string;input:string;idempotencyKey:string;
  workflowScope:'social_content';
  subject:{type:'social_product_asset_revision';id:string;sourceRunId:string;
    preparedVersion:string;revisedPlanHash:string;lineageHash:string;
    freezeOperationId:string;freezeIdempotencyKey:string};
}

export interface Starter198OrchestratorQueueResult {
  queueItemId: string;
  runId?: string;
  /** Older injected queues may omit these; the built-in durable queue never does. */
  disposition?: 'queued' | 'attached_to_run' | 'awaiting_initial_confirmation' | 'requires_manual_production';
  missingFacts?: string[];
  /** Business destination for a scoped workflow that needs a professional workspace. */
  nextDestination?: 'smartAssets';
  reasonCode?: string;
}

export interface Starter198InitialSetupPort {
  configure(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    setup: Starter198InitialSetupInput;
  }): Promise<{ configVersion: number; factsVersion: string; repeated: boolean }>;
}

export interface Starter198QuoteAgentPort {
  calculate(input: {
    envelope: AgentTaskEnvelopeV1;
    facts: Record<string, unknown>;
  }): Promise<AgentTaskResultV1>;
}

export interface Starter198ApprovalDecisionPort {
  decide(input: {
    tenantId: string;
    userId: string;
    approvalId: string;
    expectedSubjectVersion: string;
    decision: 'approved' | 'rejected';
    note: string;
  }): Promise<{ state: 'decided' | 'already_decided'; decision: string }>;
}

export class Starter198RuntimePortError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'Starter198RuntimePortError';
  }
}

export interface Starter198QuoteDecisionPort {
  decide(input: {
    tenantId: string;
    userId: string;
    role: 'owner' | 'admin';
    draftId: string;
    expectedInputHash: string;
    decision: 'approved' | 'rejected';
    note: string;
    idempotencyKey: string;
  }): Promise<{ artifactId: string | null; artifactPending: boolean }>;
}

export interface Starter198QuoteEvidencePort {
  record(input: {
    tenantId: string;
    userId: string;
    role: Starter198OrgRole;
    draftId: string;
    expectedInputHash: string;
    channel: string;
    providerReference: string;
    idempotencyKey: string;
  }): Promise<{ evidenceId: string; status: 'submitted_unverified' }>;
}

export interface Starter198QuoteSelfServicePort {
  confirmRule(input: {
    tenantId: string;
    userId: string;
    role: 'owner' | 'admin';
    setup: Starter198QuoteRuleSetupInput;
    idempotencyKey: string;
  }): Promise<{ ruleSetKey: string; ruleSetVersion: string; sku: string; created: boolean }>;
  submitInquiry(input: {
    tenantId: string;
    userId: string;
    role: 'owner' | 'admin' | 'customer_service';
    inquiry: Starter198QuoteInquiryInput;
    idempotencyKey: string;
  }): Promise<{
    inquiryId: string;
    inquiryVersion: string;
    draftId: string;
    status: string;
    total: { currency: string; decimal: string } | null;
    repeated: boolean;
  }>;
}

export interface Starter198RuntimePorts {
  initialSetup?: Starter198InitialSetupPort;
  orchestratorQueue?: Starter198OrchestratorQueuePort;
  quotation?: Starter198QuoteAgentPort;
  approvalDecision?: Starter198ApprovalDecisionPort;
  quoteDecision?: Starter198QuoteDecisionPort;
  quoteEvidence?: Starter198QuoteEvidencePort;
  quoteSelfService?: Starter198QuoteSelfServicePort;
}
