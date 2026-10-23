import type {
  SocialContentExecutionPlan,
  SocialDirectorBrief,
  SocialDirectorBriefScene,
  SocialExecutionPlanReview,
  SocialProductionResult,
  SocialReferenceVideoAnalysis,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export const SOCIAL_PRODUCTION_HANDOFF_SCHEMA = 'social-content-production-handoff.v3';
export const SOCIAL_PRODUCTION_RECEIPT_SCHEMA = 'social-content-production-receipt.v3';

export type SocialProductionGate = 'G4' | 'G5' | 'G6';
export type SocialProductionReceiptStatus = 'passed' | 'failed' | 'review_required';

const REQUIRED_GATE_CHECKS: Record<SocialProductionGate, readonly string[]> = {
  G4: ['format', 'duration', 'audio_visual_sync', 'caption', 'linked_assets', 'render', 'sensitive_data'],
  G5: ['hook', 'evidence_order', 'account_tone', 'cta', 'truth_boundary', 'variant_difference'],
  G6: ['account', 'platform_format', 'conversion_route', 'sales_owner', 'weekly_authorization'],
};

export interface SocialShotTrace {
  sceneId: string;
  order: number;
  directorBriefRef: { id: string; version: string };
  sourceAnalysisRef: {
    analysisId: string;
    version: string;
    referenceSourceId: string;
    referenceShotId: string;
    startSeconds: number;
    endSeconds: number;
  } | null;
  execution: {
    idempotencyKey: string;
    selectedSourceStrategy: string;
    candidateIds: string[];
  };
  immutableIntentHash: string;
}

export interface SocialVariantDifference {
  variantId: string;
  baselineVariantId: string | null;
  changedSceneIds: string[];
  dimensions: Array<'hook' | 'visual' | 'voiceover' | 'caption' | 'pace' | 'cta' | 'platform' | 'cover' | 'copy' | 'render_hash'>;
  hypothesis: string;
  unchangedConstraints: string[];
  surfaceHashes: {
    firstThreeSeconds: { baseline: string | null; current: string };
    caption: { baseline: string | null; current: string };
    cover: { baseline: string | null; current: string };
    cta: { baseline: string | null; current: string };
    copy: { baseline: string | null; current: string };
    render: { baseline: string | null; current: string };
  };
}

export interface SocialProductionHandoff {
  schemaVersion: typeof SOCIAL_PRODUCTION_HANDOFF_SCHEMA;
  handoffId: string;
  version: string;
  taskId: string;
  status: 'locked';
  sourceAnalysis: {
    analysisId: string;
    version: string;
    referenceSourceId: string;
    coverageHash: string;
  };
  directorBrief: SocialDirectorBrief;
  executionPlan: SocialContentExecutionPlan;
  executionPlanReview: SocialExecutionPlanReview;
  compositionBoundary: {
    directorOwned: ['creative_intent', 'narrative', 'shot_intent', 'timing', 'truth_boundary', 'acceptance_criteria'];
    contentAgentOwned: ['candidate_selection', 'provider_execution', 'retry', 'composition', 'technical_delivery'];
    contentAgentMayNot: ['rewrite_brief', 'change_truth_boundary', 'change_source_lineage', 'self_approve_g5', 'self_approve_g6'];
  };
  shotTraces: SocialShotTrace[];
  variantDifference: SocialVariantDifference;
  createdAt: string;
  createdBy: 'director_agent';
  recordHash: string;
}

export interface SocialProductionReceipt {
  schemaVersion: typeof SOCIAL_PRODUCTION_RECEIPT_SCHEMA;
  receiptId: string;
  handoffId: string;
  handoffVersion: string;
  gate: SocialProductionGate;
  sceneId: string | null;
  attempt: number;
  status: SocialProductionReceiptStatus;
  artifactRefs: string[];
  evidenceRefs: string[];
  checks: Array<{ code: string; passed: boolean; message: string }>;
  shotTraceHash: string | null;
  productionResultRef: { id: string; version: string; recordHash: string };
  evidenceKind: 'technical_detection' | 'human_technical_review' | 'human_director_review' | 'director_expression_review' | 'business_publication_preflight';
  actor: 'content_agent' | 'human_reviewer' | 'human_director_reviewer' | 'director_agent' | 'business_agent' | 'rules_engine';
  createdAt: string;
  recordHash: string;
}

function fail(code: string): never {
  throw new SocialContentWorkflowError(code, 409);
}

function id(value: unknown): string {
  const parsed = socialText(value);
  if (!parsed || parsed.length > 200 || /[\u0000-\u001f]/.test(parsed)) fail('social_production_handoff_identity_invalid');
  return parsed;
}

function exactScene(brief: SocialDirectorBrief, sceneId: string): SocialDirectorBriefScene {
  const matches = brief.scenes.filter(scene => scene.sceneId === sceneId);
  if (matches.length !== 1) fail('social_production_handoff_scene_lineage_invalid');
  return matches[0]!;
}

function assertUnique(values: string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

function assertReceiptIntegrity(receipt: SocialProductionReceipt, handoff?: SocialProductionHandoff): void {
  const { recordHash, ...payload } = receipt;
  if (receipt.schemaVersion !== SOCIAL_PRODUCTION_RECEIPT_SCHEMA || socialRequestHash(payload) !== recordHash) {
    fail('social_production_receipt_storage_integrity_violation');
  }
  if (!handoff) return;
  if (receipt.handoffId !== handoff.handoffId || receipt.handoffVersion !== handoff.version) {
    fail('social_production_receipt_handoff_mismatch');
  }
  const trace = receipt.sceneId ? handoff.shotTraces.find(item => item.sceneId === receipt.sceneId) : null;
  if ((trace ? socialRequestHash(trace) : null) !== receipt.shotTraceHash) {
    fail('social_production_receipt_trace_mismatch');
  }
}

function handoffPayload(value: Omit<SocialProductionHandoff, 'recordHash'>): Omit<SocialProductionHandoff, 'recordHash'> {
  return value;
}

function receiptPayload(value: Omit<SocialProductionReceipt, 'recordHash'>): Omit<SocialProductionReceipt, 'recordHash'> {
  return value;
}

export function buildSocialProductionHandoff(input: {
  taskId: string;
  version: string;
  sourceAnalysis: SocialReferenceVideoAnalysis;
  directorBrief: SocialDirectorBrief;
  executionPlan: SocialContentExecutionPlan;
  executionPlanReview: SocialExecutionPlanReview;
  variantDifference: SocialVariantDifference;
  now?: Date;
}): SocialProductionHandoff {
  const { sourceAnalysis, directorBrief, executionPlan, executionPlanReview } = input;
  const taskId = id(input.taskId);
  const version = id(input.version);
  const sourceAnalysisVersion = socialText(sourceAnalysis.version);
  if (!sourceAnalysisVersion) fail('social_production_handoff_source_analysis_version_required');
  if (sourceAnalysis.status !== 'ready' || sourceAnalysis.coverage?.fullTimelineCovered !== true) {
    fail('social_production_handoff_source_analysis_not_ready');
  }
  if (directorBrief.status !== 'ready'
    || directorBrief.referenceAnalysis?.analysisId !== sourceAnalysis.analysisId
    || directorBrief.referenceAnalysis.version !== sourceAnalysisVersion
    || socialRequestHash({
      fullDurationSeconds: directorBrief.referenceAnalysis.fullDurationSeconds,
      precisionIntervals: directorBrief.referenceAnalysis.precisionIntervals,
      gaps: directorBrief.referenceAnalysis.gaps,
      overallConfidence: directorBrief.referenceAnalysis.overallConfidence,
    }) !== socialRequestHash({
      fullDurationSeconds: sourceAnalysis.coverage.fullDurationSeconds,
      precisionIntervals: sourceAnalysis.coverage.precisionIntervals,
      gaps: sourceAnalysis.coverage.gaps,
      overallConfidence: sourceAnalysis.coverage.overallConfidence,
    })) {
    fail('social_production_handoff_director_brief_lineage_invalid');
  }
  if (executionPlan.status !== 'approved'
    || executionPlan.directorBriefId !== directorBrief.directorBriefId
    || executionPlan.directorBriefVersion !== directorBrief.version) {
    fail('social_production_handoff_execution_plan_lineage_invalid');
  }
  if (!executionPlanReview.approved
    || executionPlanReview.createdBy !== 'director_agent'
    || executionPlanReview.executionPlanId !== executionPlan.executionPlanId
    || executionPlanReview.executionPlanVersion !== executionPlan.version
    || executionPlanReview.directorBriefId !== directorBrief.directorBriefId
    || executionPlanReview.directorBriefVersion !== directorBrief.version
    || executionPlanReview.sceneResults.length !== directorBrief.scenes.length
    || executionPlanReview.sceneResults.some(result => !result.approved)) {
    fail('social_production_handoff_execution_review_invalid');
  }
  if (!directorBrief.source.weeklyPackageId || !directorBrief.accountRefs.length
    || !directorBrief.factSourceRefs.length || !directorBrief.callToAction) {
    fail('social_production_handoff_g3_incomplete');
  }
  if (!directorBrief.scenes.length || !executionPlan.scenes.length) fail('social_production_handoff_scene_count_mismatch');
  assertUnique(sourceAnalysis.shots.map(shot => shot.shotId), 'social_production_handoff_source_shot_duplicate');
  assertUnique(directorBrief.scenes.map(scene => scene.sceneId), 'social_production_handoff_scene_lineage_invalid');
  assertUnique(directorBrief.scenes.map(scene => String(scene.order)), 'social_production_handoff_scene_order_invalid');
  assertUnique(executionPlan.scenes.map(scene => scene.sceneId), 'social_production_handoff_execution_scene_duplicate');
  assertUnique(executionPlan.scenes.map(scene => scene.idempotencyKey), 'social_production_handoff_idempotency_key_duplicate');
  const variantSceneIds = input.variantDifference.changedSceneIds;
  const variant = input.variantDifference;
  const surfaces = Object.values(variant.surfaceHashes);
  const isDerivedVariant = Boolean(variant.baselineVariantId);
  if (!id(variant.variantId) || !socialText(variant.hypothesis)
    || variant.baselineVariantId === variant.variantId
    || variant.unchangedConstraints.length === 0
    || variantSceneIds.some(sceneId => !directorBrief.scenes.some(scene => scene.sceneId === sceneId))
    || surfaces.some(surface => !id(surface.current))
    || (isDerivedVariant && (variant.dimensions.length === 0 || variantSceneIds.length === 0
      || surfaces.some(surface => !surface.baseline)
      || surfaces.every(surface => surface.baseline === surface.current)))
    || (!isDerivedVariant && (variant.dimensions.length > 0 || variantSceneIds.length > 0
      || surfaces.some(surface => surface.baseline !== null)))) {
    fail('social_production_handoff_variant_difference_required');
  }
  assertUnique(variantSceneIds, 'social_production_handoff_variant_difference_invalid');
  assertUnique(input.variantDifference.dimensions, 'social_production_handoff_variant_difference_invalid');
  const shotTraces = executionPlan.scenes.map(scene => {
    const briefScene = exactScene(directorBrief, scene.sceneId);
    const referenceShot = briefScene.referenceShotId
      ? sourceAnalysis.shots.find(shot => shot.shotId === briefScene.referenceShotId) : null;
    if (briefScene.referenceShotId && !referenceShot) fail('social_production_handoff_source_shot_missing');
    const candidateIds = [...new Set(scene.recommendedCandidateIds)];
    if (!candidateIds.length || candidateIds.some(candidateId => !scene.candidates.some(item => item.candidateId === candidateId))) {
      fail('social_production_handoff_candidate_lineage_invalid');
    }
    const intent = {
      sceneId: briefScene.sceneId,
      purpose: briefScene.purpose,
      targetVisual: briefScene.targetVisual,
      requiredEvidence: briefScene.requiredEvidence,
      action: briefScene.action,
      shotLanguage: briefScene.shotLanguage,
      referenceMaterial: briefScene.referenceMaterial ?? null,
      productionRouting: briefScene.productionRouting ?? null,
      spaceAndContinuity: briefScene.spaceAndContinuity,
      audioLayers: briefScene.audioLayers,
      duration: briefScene.duration,
      truthBoundary: briefScene.truthBoundary,
      allowedVariation: briefScene.allowedVariation,
      acceptanceCriteria: briefScene.acceptanceCriteria,
      replicationFactors: briefScene.replicationFactors ?? [],
    };
    return {
      sceneId: scene.sceneId,
      order: briefScene.order,
      directorBriefRef: { id: directorBrief.directorBriefId, version: directorBrief.version },
      sourceAnalysisRef: referenceShot ? {
        analysisId: sourceAnalysis.analysisId,
        version: sourceAnalysisVersion,
        referenceSourceId: sourceAnalysis.referenceSourceId,
        referenceShotId: referenceShot.shotId,
        startSeconds: referenceShot.startSeconds,
        endSeconds: referenceShot.endSeconds,
      } : null,
      execution: {
        idempotencyKey: id(scene.idempotencyKey),
        selectedSourceStrategy: scene.selectedSourceStrategy,
        candidateIds,
      },
      immutableIntentHash: socialRequestHash(intent),
    } satisfies SocialShotTrace;
  }).sort((left, right) => left.order - right.order);
  if (shotTraces.length !== directorBrief.scenes.length) fail('social_production_handoff_scene_count_mismatch');
  const createdAt = (input.now ?? new Date()).toISOString();
  const identity = { taskId, version, directorBriefId: directorBrief.directorBriefId };
  const payload: Omit<SocialProductionHandoff, 'recordHash'> = {
    schemaVersion: SOCIAL_PRODUCTION_HANDOFF_SCHEMA,
    handoffId: `production_handoff_${socialRequestHash(identity).slice(0, 24)}`,
    version,
    taskId,
    status: 'locked',
    sourceAnalysis: {
      analysisId: sourceAnalysis.analysisId,
      version: sourceAnalysisVersion,
      referenceSourceId: sourceAnalysis.referenceSourceId,
      coverageHash: socialRequestHash(sourceAnalysis.coverage),
    },
    directorBrief: structuredClone(directorBrief),
    executionPlan: structuredClone(executionPlan),
    executionPlanReview: structuredClone(executionPlanReview),
    compositionBoundary: {
      directorOwned: ['creative_intent', 'narrative', 'shot_intent', 'timing', 'truth_boundary', 'acceptance_criteria'],
      contentAgentOwned: ['candidate_selection', 'provider_execution', 'retry', 'composition', 'technical_delivery'],
      contentAgentMayNot: ['rewrite_brief', 'change_truth_boundary', 'change_source_lineage', 'self_approve_g5', 'self_approve_g6'],
    },
    shotTraces,
    variantDifference: structuredClone(input.variantDifference),
    createdAt,
    createdBy: 'director_agent',
  };
  return { ...payload, recordHash: socialRequestHash(handoffPayload(payload)) };
}

export function buildSocialProductionReceipt(input: {
  handoff: SocialProductionHandoff;
  productionResult: SocialProductionResult;
  gate: SocialProductionGate;
  sceneId?: string | null;
  attempt: number;
  status: SocialProductionReceiptStatus;
  artifactRefs?: string[];
  evidenceRefs: string[];
  checks: Array<{ code: string; passed: boolean; message: string }>;
  actor: SocialProductionReceipt['actor'];
  now?: Date;
}): SocialProductionReceipt {
  const result = input.productionResult;
  if (result.executionPlanId !== input.handoff.executionPlan.executionPlanId
    || result.executionPlanVersion !== input.handoff.executionPlan.version
    || result.executionPlanReviewId !== input.handoff.executionPlanReview.reviewId
    || result.sceneResults.length !== input.handoff.shotTraces.length
    || result.sceneResults.some(scene => {
      const trace = input.handoff.shotTraces.find(item => item.sceneId === scene.sceneId);
      return !trace || trace.execution.idempotencyKey !== scene.idempotencyKey
        || trace.execution.selectedSourceStrategy !== scene.sourceStrategy
        || scene.provenanceCandidateIds.some(candidateId => !trace.execution.candidateIds.includes(candidateId));
    })) {
    fail('social_production_receipt_result_lineage_invalid');
  }
  const sceneId = input.sceneId ? id(input.sceneId) : null;
  const trace = sceneId ? input.handoff.shotTraces.find(item => item.sceneId === sceneId) : null;
  if (sceneId && !trace) fail('social_production_receipt_scene_not_found');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || !input.checks.length || !input.evidenceRefs.length) {
    fail('social_production_receipt_evidence_required');
  }
  if (input.checks.some(check => !id(check.code) || !socialText(check.message))) fail('social_production_receipt_check_invalid');
  const checkCodes = new Set(input.checks.map(check => check.code));
  if (REQUIRED_GATE_CHECKS[input.gate].some(code => !checkCodes.has(code))) {
    fail('social_production_receipt_gate_checks_incomplete');
  }
  if (input.status === 'passed' && input.checks.some(check => !check.passed)) fail('social_production_receipt_check_failed');
  if (input.gate === 'G4' && (!sceneId || !['content_agent','human_reviewer'].includes(input.actor) || !(input.artifactRefs?.length))) {
    fail('social_production_receipt_g4_invalid');
  }
  if (input.gate === 'G5' && (sceneId || !['director_agent','human_director_reviewer'].includes(input.actor))) {
    fail('social_production_receipt_g5_independence_required');
  }
  if (input.gate === 'G6' && (sceneId || !['business_agent', 'rules_engine'].includes(input.actor))) {
    fail('social_production_receipt_g6_business_preflight_required');
  }
  const evidenceKind = input.gate === 'G4' ? (input.actor==='human_reviewer'?'human_technical_review':'technical_detection')
    : input.gate === 'G5' ? (input.actor==='human_director_reviewer'?'human_director_review':'director_expression_review') : 'business_publication_preflight';
  const createdAt = (input.now ?? new Date()).toISOString();
  const identity = { handoffId: input.handoff.handoffId, version: input.handoff.version, gate: input.gate, sceneId, attempt: input.attempt };
  const payload: Omit<SocialProductionReceipt, 'recordHash'> = {
    schemaVersion: SOCIAL_PRODUCTION_RECEIPT_SCHEMA,
    receiptId: `production_receipt_${socialRequestHash(identity).slice(0, 24)}`,
    handoffId: input.handoff.handoffId,
    handoffVersion: input.handoff.version,
    gate: input.gate,
    sceneId,
    attempt: input.attempt,
    status: input.status,
    artifactRefs: [...new Set(input.artifactRefs ?? [])],
    evidenceRefs: [...new Set(input.evidenceRefs)],
    checks: structuredClone(input.checks),
    shotTraceHash: trace ? socialRequestHash(trace) : null,
    productionResultRef: {
      id: id(result.productionResultId), version: id(result.version), recordHash: socialRequestHash(result),
    },
    evidenceKind,
    actor: input.actor,
    createdAt,
  };
  return { ...payload, recordHash: socialRequestHash(receiptPayload(payload)) };
}

export function evaluateSocialProductionGates(handoff: SocialProductionHandoff, receipts: SocialProductionReceipt[]): {
  G4: SocialProductionReceiptStatus; G5: SocialProductionReceiptStatus; G6: SocialProductionReceiptStatus;
  readyForRelease: boolean;
} {
  assertHandoffIntegrity(handoff);
  const exact = receipts.filter(item => item.handoffId === handoff.handoffId && item.handoffVersion === handoff.version);
  exact.forEach(receipt => assertReceiptIntegrity(receipt, handoff));
  const resultVersions = new Set(exact.map(receipt => `${receipt.productionResultRef.id}:${receipt.productionResultRef.version}:${receipt.productionResultRef.recordHash}`));
  if (resultVersions.size > 1) fail('social_production_receipt_result_version_conflict');
  const latest = (gate: SocialProductionGate, sceneId: string | null): SocialProductionReceipt | null => exact
    .filter(item => item.gate === gate && item.sceneId === sceneId)
    .sort((left, right) => right.attempt - left.attempt || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  const sceneReceipts = handoff.shotTraces.map(trace => latest('G4', trace.sceneId));
  const g4 = sceneReceipts.every(item => item?.status === 'passed') ? 'passed'
    : sceneReceipts.some(item => item?.status === 'failed') ? 'failed' : 'review_required';
  const g5 = g4 === 'passed' ? latest('G5', null)?.status ?? 'review_required' : 'review_required';
  const g6 = g5 === 'passed' ? latest('G6', null)?.status ?? 'review_required' : 'review_required';
  return { G4: g4, G5: g5, G6: g6, readyForRelease: g4 === 'passed' && g5 === 'passed' && g6 === 'passed' };
}

function assertHandoffIntegrity(handoff: SocialProductionHandoff): void {
  if (handoff.schemaVersion !== SOCIAL_PRODUCTION_HANDOFF_SCHEMA) {
    fail('social_production_handoff_storage_integrity_violation');
  }
  const { recordHash, ...payload } = handoff;
  if (socialRequestHash(payload) !== recordHash) fail('social_production_handoff_storage_integrity_violation');
}

export async function persistSocialProductionHandoff(repository: Starter198Repository, tenantId: string, handoff: SocialProductionHandoff): Promise<StarterRecord> {
  assertHandoffIntegrity(handoff);
  const existing = await repository.list(STARTER_COLLECTIONS.socialProductionHandoffs, tenantId, {
    where: { handoff_id: handoff.handoffId, handoff_version: handoff.version }, perPage: 2,
  });
  if (existing.totalItems > 1) fail('social_production_handoff_storage_integrity_violation');
  if (existing.items[0]) {
    if (socialText(existing.items[0].record_hash) !== handoff.recordHash) fail('social_production_handoff_version_conflict');
    return existing.items[0];
  }
  return repository.create(STARTER_COLLECTIONS.socialProductionHandoffs, tenantId, {
    schema_version: handoff.schemaVersion, handoff_id: handoff.handoffId, task_id: handoff.taskId,
    handoff_version: handoff.version, director_brief_id: handoff.directorBrief.directorBriefId,
    director_brief_version: handoff.directorBrief.version, execution_plan_id: handoff.executionPlan.executionPlanId,
    execution_plan_version: handoff.executionPlan.version, execution_review_id: handoff.executionPlanReview.reviewId,
    execution_review_version: handoff.executionPlanReview.version, source_analysis_id: handoff.sourceAnalysis.analysisId,
    source_analysis_version: handoff.sourceAnalysis.version, status: handoff.status, payload: handoff,
    record_hash: handoff.recordHash, created_at: handoff.createdAt,
  });
}

export async function persistSocialProductionReceipt(repository: Starter198Repository, tenantId: string, receipt: SocialProductionReceipt): Promise<StarterRecord> {
  assertReceiptIntegrity(receipt);
  const handoffs = await repository.list(STARTER_COLLECTIONS.socialProductionHandoffs, tenantId, {
    where: { handoff_id: receipt.handoffId, handoff_version: receipt.handoffVersion }, perPage: 2,
  });
  if (handoffs.totalItems !== 1) fail('social_production_receipt_handoff_not_found');
  const handoff = parseSocialProductionHandoffRecord(handoffs.items[0]!);
  assertReceiptIntegrity(receipt, handoff);
  if(receipt.actor==='human_reviewer'){const {verifyTrustedHumanProductionReceipt}=await import('./socialSceneG4ReviewService.js');await verifyTrustedHumanProductionReceipt(repository,tenantId,receipt);}
  if(receipt.gate==='G6'&&receipt.actor==='rules_engine'){const {verifySocialWeeklyG6Receipt}=await import('./socialWeeklyG6ReviewService.js');await verifySocialWeeklyG6Receipt(repository,tenantId,receipt);}
  if(receipt.gate==='G5'&&(receipt.actor==='human_director_reviewer'||receipt.evidenceRefs.some(r=>r.startsWith('director_g5_review:')))){const {verifySocialDirectorG5Receipt}=await import('./socialDirectorG5ReviewService.js');await verifySocialDirectorG5Receipt(repository,tenantId,receipt);}
  const existing = await repository.list(STARTER_COLLECTIONS.socialProductionReceipts, tenantId, { where: { receipt_id: receipt.receiptId }, perPage: 2 });
  if (existing.totalItems > 1) fail('social_production_receipt_storage_integrity_violation');
  if (existing.items[0]) {
    if (socialText(existing.items[0].record_hash) !== receipt.recordHash) fail('social_production_receipt_attempt_conflict');
    return existing.items[0];
  }
  if (receipt.gate !== 'G4') {
    const stored = await repository.list(STARTER_COLLECTIONS.socialProductionReceipts, tenantId, {
      where: { handoff_id: receipt.handoffId, handoff_version: receipt.handoffVersion }, perPage: 500,
    });
    const prior = stored.items.map(parseSocialProductionReceiptRecord);
    for(const r of prior){if(r.gate==='G5'&&(r.actor==='human_director_reviewer'||r.evidenceRefs.some(e=>e.startsWith('director_g5_review:')))){const {verifySocialDirectorG5Receipt}=await import('./socialDirectorG5ReviewService.js');await verifySocialDirectorG5Receipt(repository,tenantId,r);}}
    for(const r of prior){if(r.actor==='human_reviewer'){const {verifyTrustedHumanProductionReceipt}=await import('./socialSceneG4ReviewService.js');await verifyTrustedHumanProductionReceipt(repository,tenantId,r);}}
    if (prior.some(item => item.productionResultRef.id !== receipt.productionResultRef.id
      || item.productionResultRef.version !== receipt.productionResultRef.version
      || item.productionResultRef.recordHash !== receipt.productionResultRef.recordHash)) {
      fail('social_production_receipt_result_version_conflict');
    }
    for(const r of prior){if(r.gate==='G6'&&r.actor==='rules_engine'){const {verifySocialWeeklyG6HistoricalReceipt}=await import('./socialWeeklyG6ReviewService.js');await verifySocialWeeklyG6HistoricalReceipt(repository,tenantId,r);}}
    const gates = evaluateSocialProductionGates(handoff, prior);
    if (receipt.gate === 'G5' && gates.G4 !== 'passed') fail('social_production_receipt_g4_incomplete');
    if (receipt.gate === 'G6' && gates.G5 !== 'passed') fail('social_production_receipt_g5_incomplete');
  }
  return repository.create(STARTER_COLLECTIONS.socialProductionReceipts, tenantId, {
    schema_version: receipt.schemaVersion, receipt_id: receipt.receiptId, handoff_id: receipt.handoffId,
    handoff_version: receipt.handoffVersion, gate: receipt.gate, scene_id: receipt.sceneId ?? '',
    attempt: receipt.attempt, status: receipt.status, production_result_id: receipt.productionResultRef.id,
    production_result_version: receipt.productionResultRef.version, evidence_kind: receipt.evidenceKind,
    payload: receipt, record_hash: receipt.recordHash,
    created_at: receipt.createdAt,
  });
}

export function parseSocialProductionHandoffRecord(record: StarterRecord): SocialProductionHandoff {
  const payload = socialObject(socialJson(record.payload)) as unknown as SocialProductionHandoff | null;
  if (!payload || socialText(record.record_hash) !== payload.recordHash) fail('social_production_handoff_storage_integrity_violation');
  assertHandoffIntegrity(payload);
  return payload;
}

export function parseSocialProductionReceiptRecord(record: StarterRecord): SocialProductionReceipt {
  const payload = socialObject(socialJson(record.payload)) as unknown as SocialProductionReceipt | null;
  if (!payload || socialText(record.record_hash) !== payload.recordHash) {
    fail('social_production_receipt_storage_integrity_violation');
  }
  assertReceiptIntegrity(payload);
  return payload;
}

export async function readSocialProductionHandoff(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  version?: string | null;
}): Promise<SocialProductionHandoff | null> {
  const taskId = id(input.taskId);
  const version = input.version ? id(input.version) : null;
  const result = await input.repository.list(STARTER_COLLECTIONS.socialProductionHandoffs, input.tenantId, {
    where: { task_id: taskId, ...(version ? { handoff_version: version } : {}) },
    sort: '-created_at',
    perPage: version ? 2 : 1,
  });
  if (version && result.totalItems > 1) fail('social_production_handoff_storage_integrity_violation');
  return result.items[0] ? parseSocialProductionHandoffRecord(result.items[0]) : null;
}

export async function readSocialProductionState(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  version?: string | null;
}): Promise<{
  handoff: SocialProductionHandoff;
  receipts: SocialProductionReceipt[];
  gates: ReturnType<typeof evaluateSocialProductionGates>;
} | null> {
  const handoff = await readSocialProductionHandoff(input);
  if (!handoff) return null;
  const rows = await input.repository.list(STARTER_COLLECTIONS.socialProductionReceipts, input.tenantId, {
    where: { handoff_id: handoff.handoffId, handoff_version: handoff.version },
    sort: 'created_at',
    perPage: 500,
  });
  if (rows.totalItems > rows.items.length) fail('social_production_receipt_storage_integrity_violation');
  const receipts = rows.items.map(parseSocialProductionReceiptRecord);
  for(const receipt of receipts){if(receipt.actor==='human_reviewer'){const {verifyTrustedHumanProductionReceipt}=await import('./socialSceneG4ReviewService.js');await verifyTrustedHumanProductionReceipt(input.repository,input.tenantId,receipt);}}
  const latestG6=receipts.filter(receipt=>receipt.gate==='G6'&&receipt.sceneId===null).sort((a,b)=>b.attempt-a.attempt||b.createdAt.localeCompare(a.createdAt))[0];
  for(const receipt of receipts){if(receipt.gate==='G6'&&receipt.actor==='rules_engine'){const {verifySocialWeeklyG6HistoricalReceipt}=await import('./socialWeeklyG6ReviewService.js');await verifySocialWeeklyG6HistoricalReceipt(input.repository,input.tenantId,receipt);}}
  if(latestG6?.actor==='rules_engine'){const {verifySocialWeeklyG6Receipt}=await import('./socialWeeklyG6ReviewService.js');await verifySocialWeeklyG6Receipt(input.repository,input.tenantId,latestG6);}
  for(const receipt of receipts){if(receipt.gate==='G5'&&(receipt.actor==='human_director_reviewer'||receipt.evidenceRefs.some(e=>e.startsWith('director_g5_review:')))){const {verifySocialDirectorG5Receipt}=await import('./socialDirectorG5ReviewService.js');await verifySocialDirectorG5Receipt(input.repository,input.tenantId,receipt);}}
  return { handoff, receipts, gates: evaluateSocialProductionGates(handoff, receipts) };
}
