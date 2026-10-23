import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { persistReferenceSelection, type ReferenceSelection, type VersionedReferenceSelection } from '../socialDiscovery/orchestration.js';
import { starter198Repository, type Starter198Repository } from './repository.js';
import { buildAuthoritativeSocialContentWorkflow } from './socialContentTasks.js';
import {
  buildSocialContentAuthorityLineage,
  persistAuthoritativeContentBundle,
  type SocialContentAuthorityLineage,
} from './socialContentLineage.js';

type WorkflowInput = Parameters<typeof buildAuthoritativeSocialContentWorkflow>[0];

export interface SocialDiscoveryAuthorityAdapterInput extends Omit<WorkflowInput, 'referenceSelection'> {
  tenantId: string;
  selection: ReferenceSelection;
  lineageVersion?: string;
  now?: Date;
}

export interface SocialDiscoveryAuthorityEvent {
  schemaVersion: 'social-discovery-director-authority.v1';
  tenantId: string;
  originalTaskRef: VersionedSocialRef;
  referenceSelectionRef: VersionedSocialRef;
  candidateEvidenceRefs: VersionedSocialRef[];
  inspirationHandoffRefs: VersionedSocialRef[];
  directorBriefRef: VersionedSocialRef;
  lineageRef: VersionedSocialRef;
  occurredAt: string;
}

export interface SocialDiscoveryAuthorityAdapterResult {
  referenceSelection: VersionedReferenceSelection;
  workflow: ReturnType<typeof buildAuthoritativeSocialContentWorkflow>;
  lineage: SocialContentAuthorityLineage;
  event: SocialDiscoveryAuthorityEvent;
}

export interface SocialDiscoveryAuthorityAdapterDependencies {
  repository: Starter198Repository;
  persistSelection: typeof persistReferenceSelection;
}

const defaults: SocialDiscoveryAuthorityAdapterDependencies = {
  repository: starter198Repository,
  persistSelection: persistReferenceSelection,
};

/**
 * R3 -> R4 anti-corruption adapter. R3 supplies analyzed handoffs; R4 freezes
 * the selected evidence and uses the existing Starter198 lineage helper.
 */
export async function persistSocialDiscoveryDirectorAuthority(
  input: SocialDiscoveryAuthorityAdapterInput,
  dependencies: SocialDiscoveryAuthorityAdapterDependencies = defaults,
): Promise<SocialDiscoveryAuthorityAdapterResult> {
  if (input.selection.status !== 'selected') throw new Error('social_content_reference_selection_required');
  const referenceSelection = await dependencies.persistSelection({
    tenantId: input.tenantId,
    upstreamTaskRef: input.weeklyWorkflowTask.taskId,
    selection: input.selection,
    now: input.now,
  });
  const workflow = buildAuthoritativeSocialContentWorkflow({ ...input, referenceSelection });
  const candidateEvidenceRefs = referenceSelection.selected.map(item => ({
    type: 'candidate_evidence', id: item.evidenceId, version: item.evidenceVersion,
  }));
  const lineage = buildSocialContentAuthorityLineage({
    version: input.lineageVersion ?? String(input.weeklyWorkflowTask.taskRef.version * 1_000_000 + referenceSelection.version),
    programRef: input.programRef,
    packageRef: { type: 'weekly_operating_package', id: input.weeklyPackage.packageId, version: input.weeklyPackage.version },
    weeklyTaskRef: input.weeklyWorkflowTask.taskRef,
    publicationTaskRef: { type: 'weekly_publication_task', id: input.publicationTask.publicationTaskId, version: input.weeklyPackage.version },
    businessGoalRef: { type: 'business_content_goal', id: input.businessGoal.goalId, version: input.businessGoal.version },
    enterpriseProfileRef: input.enterpriseProfileRef,
    enterpriseFactRefs: input.publicationTask.factRefs,
    referenceSelectionRef: { type: 'reference_selection', id: referenceSelection.selectionId, version: referenceSelection.version },
    candidateEvidenceRefs,
    inspirationHandoffs: workflow.inspirationHandoffs,
    directorBrief: workflow.directorBrief,
    productionResult: workflow.productionResult,
    now: input.now,
  });
  await persistAuthoritativeContentBundle({
    repository: dependencies.repository,
    tenantId: input.tenantId,
    lineage,
    handoffs: workflow.inspirationHandoffs,
    directorBrief: workflow.directorBrief,
  });
  const occurredAt = (input.now ?? new Date()).toISOString();
  const event: SocialDiscoveryAuthorityEvent = {
    schemaVersion: 'social-discovery-director-authority.v1',
    tenantId: input.tenantId,
    originalTaskRef: input.weeklyWorkflowTask.taskRef,
    referenceSelectionRef: lineage.referenceSelectionRef,
    candidateEvidenceRefs,
    inspirationHandoffRefs: lineage.inspirationHandoffRefs,
    directorBriefRef: lineage.directorBriefRef,
    lineageRef: { type: 'social_content_lineage', id: lineage.lineageId, version: Number(lineage.version) },
    occurredAt,
  };
  return { referenceSelection, workflow, lineage, event };
}
