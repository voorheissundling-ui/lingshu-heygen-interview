import type { DataStore } from '../storage/datastore.js';
import type { WeeklyOperatingPackage, SocialWeeklyPublicationTask } from '../../shared/contracts/socialProgram.js';
import type { SocialContentTaskDetail, SocialInspirationHandoff } from '../../shared/contracts/socialContentWorkflow.js';
import { ReferenceSelector, type InventoryCandidate, type VersionedReferenceSelection } from '../socialDiscovery/orchestration.js';
import type { VersionedCandidateEvidence } from '../socialDiscovery/qualityOrchestration.js';
import { createSocialOperatingRepository } from '../socialOperating/repository.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from '../starter198/repository.js';
import { persistSocialDiscoveryDirectorAuthority } from '../starter198/socialDiscoveryAuthorityAdapter.js';
import { buildSocialContentAuthorityLineage, parseSocialContentAuthorityLineage, persistAuthoritativeContentBundle } from '../starter198/socialContentLineage.js';
import { socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import { readWeeklyAutomaticProductionIntent } from '../socialPrograms/weeklyAutomaticProductionPlanning.js';
import type { BuildSocialAgentWorkflowInput } from '../starter198/socialContentAgentWorkflow.js';

type Authority = NonNullable<BuildSocialAgentWorkflowInput['authoritativeContext']>;
/** Hydrated only from server-owned durable evidence, never from a user-supplied title or URL. */
export async function bindWeeklyProductionAuthority(input: {
  dataStore: DataStore; repository: Starter198Repository; tenantId: string;
  pkg: WeeklyOperatingPackage; publication: SocialWeeklyPublicationTask; detail: SocialContentTaskDetail;
}): Promise<Authority> {
  const { dataStore, repository, tenantId, pkg, publication, detail } = input;
  const weeklyWorkflowTask = pkg.workflowTasks.find(task => task.kind === 'content' && task.subjectRefs.some(ref =>
    ref.type === 'weekly_publication_task' && ref.id === publication.publicationTaskId && ref.version === pkg.version));
  if (!weeklyWorkflowTask || !pkg.enterpriseProfileRef || !pkg.businessContentGoalRef) throw new Error('weekly_production_authority_required');
  const businessGoal = await createSocialOperatingRepository(dataStore).getGoal(tenantId, pkg.programId, pkg.businessContentGoalRef.id, pkg.businessContentGoalRef.version);
  if (!businessGoal) throw new Error('weekly_production_business_goal_required');
  if (businessGoal.status !== 'ready') {
    const automatic = await readWeeklyAutomaticProductionIntent(dataStore, {
      tenantId, programId: pkg.programId, packageId: pkg.packageId, packageVersion: pkg.version,
    }, pkg, publication.publicationTaskId);
    if (!automatic || automatic.authority.proof.goalRef.id !== pkg.businessContentGoalRef.id
      || automatic.authority.proof.goalRef.version !== pkg.businessContentGoalRef.version
      || socialRequestHash(automatic.authority.goal) !== socialRequestHash(businessGoal)) {
      throw new Error('weekly_production_business_goal_required');
    }
  }
  const program = await dataStore.list<any>('social_programs', { where: { tenant_id: tenantId, program_id: pkg.programId }, perPage: 2 });
  const programVersion = Number(program.items[0]?.payload?.version);
  if (program.totalItems !== 1 || !Number.isSafeInteger(programVersion) || programVersion < 1) throw new Error('weekly_production_program_required');
  const scheduleItem = pkg.agentPlanning?.dispatch?.scheduleItems.find(item => item.publicationTaskId === publication.publicationTaskId);
  const analysis = pkg.agentPlanning?.directorAnalyses.find(item => item.analysisId === scheduleItem?.directorAnalysisRef.id);
  if (!analysis) throw new Error('weekly_production_director_analysis_required');
  const frozenVideos = new Set(analysis.benchmarkVideoRefs.map(ref => ref.id));
  const evidenceRows = await dataStore.list<VersionedCandidateEvidence & { id: string; tenant_id: string }>('social_candidate_evidence', { where: { tenant_id: tenantId }, perPage: 500 });
  if (evidenceRows.totalItems > evidenceRows.items.length) throw new Error('weekly_production_evidence_scan_truncated');
  const handoffRows = await repository.list(STARTER_COLLECTIONS.socialInspirationHandoffVersions, tenantId, { perPage: 500 });
  if (handoffRows.totalItems > handoffRows.items.length) throw new Error('weekly_production_handoff_scan_truncated');
  const storedHandoffs = [...new Map(handoffRows.items.filter(row => {
    const payload = socialJson(row.payload) as SocialInspirationHandoff;
    return payload && row.record_hash === socialRequestHash(payload)
      && (analysis.frozenHandoffRefs === undefined || analysis.frozenHandoffRefs.some(ref => ref.inspirationId === payload.inspirationId
        && ref.version === String(payload.version ?? payload.analysisVersion) && ref.recordHash === row.record_hash));
  }).map(row => socialJson(row.payload) as SocialInspirationHandoff)
    .filter(item => item && frozenVideos.has(item.inspirationId))
    .sort((a, b) => Number(a.version ?? a.analysisVersion) - Number(b.version ?? b.analysisVersion))
    .map(item => [item.inspirationId, item] as const)).values()];
  const candidates: InventoryCandidate[] = [];
  for (const handoff of storedHandoffs) {
    const evidence = evidenceRows.items.find(row => row.tenant_id === tenantId && row.tenantId === tenantId && row.candidateId === handoff.inspirationId
      && analysis.benchmarkVideoRefs.some(ref => ref.id === row.candidateId && ref.version === row.version) && (
      analysis.benchmarkEvidenceRefs.includes(`${row.evidenceId}@${row.version}`)
      || analysis.benchmarkEvidenceRefs.includes(row.evidenceId)
      || analysis.benchmarkEvidenceRefs.includes(`candidate_evidence:${row.evidenceId}@${row.version}`)
    ));
    if (!evidence || handoff.source.sourceUrl !== evidence.g1.sourceUrl || !handoff.source.sourceUrl || handoff.rights.mayAdapt !== true) continue;
    candidates.push({ candidateId: handoff.inspirationId, evidenceId: evidence.evidenceId, evidenceVersion: evidence.version,
      readiness: handoff.readiness, taskRelevance: (evidence.evidence.qualityScore?.dimensions.relevance ?? 0) / 100,
      transferability: (evidence.evidence.qualityScore?.dimensions.transferability ?? 0) / 100, rightsClear: handoff.rights.mayAdapt,
      sceneIds: [], sourceRef: handoff.source.sourceUrl });
  }
  const selection = new ReferenceSelector().select({ candidates, requireProductionReady: true });
  if (selection.status !== 'selected') throw new Error('weekly_production_analyzed_handoff_required');
  const selectedHandoffs = storedHandoffs.filter(handoff => selection.selected.some(candidate => candidate.candidateId === handoff.inspirationId))
    .map(handoff => ({ ...handoff, handoffId: `weekly_handoff_${socialRequestHash({ weeklyTask: weeklyWorkflowTask.taskRef, handoff }).slice(0, 20)}`, version: String(pkg.version) }));
  const result = await persistSocialDiscoveryDirectorAuthority({
    now: new Date(pkg.agentPlanning!.dispatch!.issuedAt), tenantId, programRef: { type: 'social_program', id: pkg.programId, version: programVersion },
    enterpriseProfileRef: pkg.enterpriseProfileRef, weeklyPackage: pkg, weeklyWorkflowTask, publicationTask: publication,
    businessGoal, selection, selectedHandoffs, taskId: detail.taskId, taskVersion: detail.version, taskStatus: detail.status,
    brief: detail.brief, sources: detail.sources, assetSupplyPlan: detail.assetSupplyPlan!,
    referenceAnalysis: detail.referenceVideoAnalysis ?? null, replicationScript: detail.replicationScript ?? null,
    factSourceRefs: publication.factRefs.map(ref => `${ref.type}:${ref.id}@${ref.version}`),
  }, { repository, persistSelection: async value => {
    const fingerprint = socialRequestHash({ upstreamTaskRef: value.upstreamTaskRef, selection: value.selection });
    const existing = await dataStore.list<VersionedReferenceSelection & { id: string }>('social_reference_selections', { where: { tenant_id: tenantId, selectionId: `weekly_reference_${fingerprint.slice(0, 20)}` }, perPage: 2 });
    if (existing.totalItems > 1) throw new Error('weekly_reference_selection_ambiguous');
    if (existing.items[0]) return existing.items[0];
    const stored: VersionedReferenceSelection = { ...value.selection, selectionId: `weekly_reference_${fingerprint.slice(0, 20)}`, version: 1,
      tenantId, upstreamTaskRef: value.upstreamTaskRef, createdAt: pkg.agentPlanning!.dispatch!.issuedAt, supersedesSelectionId: null };
    const saved = await dataStore.create('social_reference_selections', { ...stored, tenant_id: tenantId });
    if (!saved) throw new Error('weekly_reference_selection_storage_unavailable');
    return stored;
  } });
  return { programRef: result.lineage.programRef, enterpriseProfileRef: pkg.enterpriseProfileRef, weeklyPackage: pkg,
    weeklyWorkflowTask, publicationTask: publication, businessGoal, referenceSelection: result.referenceSelection, selectedHandoffs };
}

export async function persistWeeklyProductionResultAuthority(input: {
  repository: Starter198Repository; tenantId: string; authority: Authority; detail: SocialContentTaskDetail;
}): Promise<void> {
  const { authority, detail } = input;
  const artifact = [...detail.artifacts].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).find(item => !['superseded', 'changes_requested'].includes(item.status) && item.kind === 'short_video' && item.origin === 'agent' && item.resourceRef && item.content?.productionResult);
  if (!artifact || !detail.agentWorkflow) return;
  const productionResult = artifact.content!.productionResult as NonNullable<Parameters<typeof buildSocialContentAuthorityLineage>[0]['productionResult']>;
  if (productionResult.artifactResourceRef !== artifact.resourceRef) throw new Error('weekly_production_result_resource_mismatch');
  const existing = await input.repository.list(STARTER_COLLECTIONS.socialContentLineage, input.tenantId, { where: { production_result_id: productionResult.productionResultId }, perPage: 2 });
  if (existing.totalItems > 1) throw new Error('weekly_production_result_lineage_ambiguous');
  const workflow = detail.agentWorkflow;
  const artifactVersion = Number(artifact.version.replace(/^v/, ''));
  if (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1) throw new Error('weekly_production_artifact_version_invalid');
  // Separate artifacts each begin at their own version 1. Their lineage identities
  // must therefore include the actual artifact identity, not only its local version.
  const lineage = buildSocialContentAuthorityLineage({ version: `${authority.weeklyPackage.version * 1_000_000 + authority.referenceSelection.version + artifactVersion * 1000}:${artifact.artifactId}`,
    programRef: authority.programRef, packageRef: { type: 'weekly_operating_package', id: authority.weeklyPackage.packageId, version: authority.weeklyPackage.version },
    weeklyTaskRef: authority.weeklyWorkflowTask.taskRef, publicationTaskRef: { type: 'weekly_publication_task', id: authority.publicationTask.publicationTaskId, version: authority.weeklyPackage.version },
    businessGoalRef: { type: 'business_content_goal', id: authority.businessGoal.goalId, version: authority.businessGoal.version },
    enterpriseProfileRef: authority.enterpriseProfileRef, enterpriseFactRefs: authority.publicationTask.factRefs,
    referenceSelectionRef: { type: 'reference_selection', id: authority.referenceSelection.selectionId, version: authority.referenceSelection.version },
    candidateEvidenceRefs: authority.referenceSelection.selected.map(item => ({ type: 'candidate_evidence', id: item.evidenceId, version: item.evidenceVersion })),
    inspirationHandoffs: workflow.inspirationHandoffs, directorBrief: workflow.directorBrief, productionResult,
    now: new Date(artifact.createdAt),
  });
  if (existing.items[0]) {
    const previous = parseSocialContentAuthorityLineage(existing.items[0]);
    if (previous.upstreamFingerprint !== lineage.upstreamFingerprint
      || socialRequestHash(previous.productionResultRef) !== socialRequestHash(lineage.productionResultRef)
      || socialRequestHash(previous.directorBriefRef) !== socialRequestHash(lineage.directorBriefRef)
      || socialRequestHash(previous.inspirationHandoffRefs) !== socialRequestHash(lineage.inspirationHandoffRefs)) {
      throw new Error('weekly_production_result_lineage_changed');
    }
    return;
  }
  await persistAuthoritativeContentBundle({ ...input, lineage, handoffs: workflow.inspirationHandoffs, directorBrief: workflow.directorBrief });
}
