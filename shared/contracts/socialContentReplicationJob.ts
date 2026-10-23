/** Frozen factor and job contracts for evidence-backed social replication. */

import type {
  SocialAccountPlaybookRef,
  SocialReplicationReferenceChain,
  SocialReplicationReferenceMode,
  SocialVersionedObjectRef,
} from './socialContentReplication.js';

export const SOCIAL_REPLICATION_FACTOR_CATEGORIES = [
  'hook',
  'composition',
  'lighting',
  'environment',
  'object_state',
  'interaction',
  'camera',
  'rhythm',
  'audio',
  'caption',
  'identity',
] as const;
export type SocialReplicationFactorCategory = typeof SOCIAL_REPLICATION_FACTOR_CATEGORIES[number];

export const SOCIAL_REPLICATION_FACTOR_POLICIES = [
  'lock',
  'equivalent',
  'bounded',
  'replace_identity',
  'prohibit_reuse',
  'free',
] as const;
export type SocialReplicationFactorPolicy = typeof SOCIAL_REPLICATION_FACTOR_POLICIES[number];
export type SocialReplicationFactorImportance = 'critical' | 'high' | 'medium' | 'low';
export type SocialReplicationCausalRole = 'retention' | 'understanding' | 'proof' | 'trust' | 'emotion' | 'conversion';
export type SocialReplicationCausalStatus = 'creative_hypothesis' | 'observed_correlation' | 'repeated_association' | 'experimental_support';

export interface SocialReplicationFactorEvidence {
  evidenceId: string;
  level: 'source_observation' | 'account_relative_performance' | 'repeated_format' | 'timepoint_behavior' | 'owned_account_experiment';
  sourceRef: string;
  description: string;
  confidence: number;
  supports: Array<'presence' | 'causal_role' | 'policy'>;
  capturedAtSeconds: number | null;
}

/** Machine-readable target; `description` is display-only and never the gate. */
export interface SocialReplicationFactorTarget {
  metric: string;
  value: string | number | boolean | string[];
  unit: string | null;
  regionRef: string | null;
  stateKey: string | null;
}

export interface SocialReplicationFactorTolerance {
  metric: string;
  minimum: number | null;
  maximum: number | null;
  allowedValues: string[];
  maximumDeviation: number | null;
  unit: string | null;
  humanReviewWhen: string[];
}

export interface SocialReplicationFactorValidator {
  validatorId: string;
  kind: 'timeline_alignment' | 'vision_state' | 'spatial_relation' | 'composition' | 'lighting' | 'motion' | 'audio' | 'ocr' | 'identity' | 'rights_fingerprint' | 'human_review';
  detector: string;
  blocking: boolean;
  threshold: number | null;
  evidenceOutput: Array<'reference_frame' | 'output_frame' | 'measurement' | 'match_region' | 'audio_segment' | 'review_note'>;
  fallbackToHuman: boolean;
}

/** One frozen, independently verifiable Director-owned replication factor. */
export interface SocialReplicationFactorSpec {
  factorId: string;
  version: string;
  beatId: string;
  referenceShotId: string | null;
  category: SocialReplicationFactorCategory;
  description: string;
  causalRole: SocialReplicationCausalRole;
  causalStatus: SocialReplicationCausalStatus;
  policy: SocialReplicationFactorPolicy;
  target: SocialReplicationFactorTarget;
  tolerance: SocialReplicationFactorTolerance;
  importance: SocialReplicationFactorImportance;
  observationConfidence: number;
  causalConfidence: number;
  evidenceRefs: SocialReplicationFactorEvidence[];
  validator: SocialReplicationFactorValidator;
  status: 'draft' | 'frozen' | 'superseded';
  frozenAt: string | null;
  decisionOwner: 'director_agent';
}
/** Product-language alias used by the PRD and API documentation. */
export type ReplicationFactorSpec = SocialReplicationFactorSpec;

export interface SocialReplicationReferenceAssignment {
  assignmentId: string;
  inspirationId: string;
  analysisId: string;
  analysisVersion: string;
  role: 'primary_structure' | 'proof_reference' | 'visual_rhythm' | 'cta_reference';
  primary: boolean;
  purpose: string;
  chain: SocialReplicationReferenceChain;
}

export interface SocialReplicationJobContext {
  verifiedPrimaryReference?: {recordId:string;sourceVersion:string;sourceSha256:string;analysisRunId:string;runtimeAnalysisId:string;runtimeAnalysisVersion:string;sourceAnalysisId:string;sourceAnalysisVersion:string};
  verifiedAccountPlaybook?: {recordHash:string;audience:string[];pillars:string[];recurringFormats:string[];conversionRoute:import('./socialProgram.js').AccountPlaybook['conversionRoute'];evidenceRules:string[];visualRules:string[];languageRules:string[];presenterRules:string[];fixedFactors:string[];experimentFactors:string[]};
  programRef?: SocialVersionedObjectRef | null;
  targetAccountRef?: SocialVersionedObjectRef | null;
  accountPlaybookRef?: SocialAccountPlaybookRef | null;
  benchmarkAccountSnapshotRef?: SocialVersionedObjectRef | null;
  referenceContentAnalysisRef?: SocialVersionedObjectRef | null;
  referenceMode?: SocialReplicationReferenceMode;
  primaryReferenceAnalysisId?: string | null;
  primaryExperimentVariable?: string | null;
}

/** Single source of truth shared by the legacy Studio entry and the new Agent chain. */
export interface SocialReplicationJob {
  replicationJobId: string;
  version: string;
  contentTaskId: string;
  status: 'draft' | 'reference_ready' | 'factor_ready' | 'director_ready' | 'producing' | 'evaluating' | 'creative_review' | 'completed' | 'blocked';
  referenceMode: SocialReplicationReferenceMode;
  target: {
    programRef: SocialVersionedObjectRef | null;
    accountRef: SocialVersionedObjectRef | null;
    accountPlaybookRef: SocialAccountPlaybookRef | null;
    productRef: string | null;
  };
  businessContextRef: SocialVersionedObjectRef;
  referenceAssignments: SocialReplicationReferenceAssignment[];
  primaryReferenceAnalysisId: string | null;
  referenceChain: SocialReplicationReferenceChain;
  factorSpecVersion: string;
  factorSpecs: SocialReplicationFactorSpec[];
  primaryExperimentVariable: string | null;
  frozenAt: string | null;
  inputRefs: SocialVersionedObjectRef[];
  createdBy: 'director_agent';
  createdAt: string;
}
/** Product-language alias used by the PRD and API documentation. */
export type ReplicationJob = SocialReplicationJob;

