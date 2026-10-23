import {assertAccountPlaybookBaselineCurrent} from './socialAccountProductionConstraints.js';
import type {readWeeklyReplicationAuthority} from './socialWeeklyReplicationAuthority.js';
import type {readWeeklyPreSupplyHandoff} from './socialWeeklyPreSupplyHandoff.js';
import type {readWeeklyTemplateStructure} from '../socialPrograms/weeklyTemplateStructure.js';
import type {readSocialTaskDetail} from './socialContentRecords.js';
import type {Starter198Repository,StarterRecord} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {SocialContentWorkflowError,socialJson,socialObject,socialRequestHash,socialText} from './socialContentValidation.js';
import {freezeSocialScriptBaseline,parseStoredSocialScriptBaseline,SOCIAL_SCRIPT_GROUNDING_VERSION} from './socialContentScriptBaseline.js';
import type {verifiedSocialScriptContext} from './socialContentScriptBaseline.js';
import {resolveSocialContentFormulaReference} from './socialContentFormulas.js';
import {resolveSocialInspirationScript,resolveSocialTaskReferenceScript} from './socialContentScriptSources.js';
import type {InternalSocialContentFormula} from './socialContentThemes.js';

export async function prepareSocialProductionScriptBaseline(input:{
  repository:Starter198Repository;
  tenantId:string;
  taskId:string;
  runId:string;
  taskRecord:StarterRecord;
  detail:NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
  originalReplication:Awaited<ReturnType<typeof readWeeklyReplicationAuthority>>;
  replicationContext:NonNullable<Awaited<ReturnType<typeof readWeeklyReplicationAuthority>>>['context']|undefined;
  contentTemplateStructure:Awaited<ReturnType<typeof readWeeklyTemplateStructure>>|undefined;
  verifiedContext:ReturnType<typeof verifiedSocialScriptContext>;
  weeklyExecutionGraphVersion:number;
  existingWeeklyPreSupply:Awaited<ReturnType<typeof readWeeklyPreSupplyHandoff>>;
}){
  const {taskRecord,detail,originalReplication,replicationContext,contentTemplateStructure,verifiedContext,weeklyExecutionGraphVersion,existingWeeklyPreSupply}=input;
  let baseline = existingWeeklyPreSupply?.baseline ?? parseStoredSocialScriptBaseline(taskRecord.script_baseline);
  let initialAuthorityBaselineVersion:number|null=null;
  if(baseline&&originalReplication?.context.verifiedAccountPlaybook&&weeklyExecutionGraphVersion>=2&&!baseline.accountPlaybookConstraints){
    // Creation precedes the weekly authority binding. Such an initial script
    // cannot be a production lock until the original scheduler rules are captured.
    const {readContentExecutionJob}=await import('../contentExecution/durableQueue.js');
    const originalJob=input.repository.dataStore?await readContentExecutionJob(input.repository.dataStore,input.tenantId,input.taskId,input.runId):null;
    if(!originalJob||originalJob.providerReceipts.length||detail.artifacts.length)throw new SocialContentWorkflowError('account_playbook_baseline_revision_required',409);
    const scriptRows=await input.repository.dataStore!.list<Record<string,unknown>>('social_weekly_execution_tasks',{where:{tenant_id:input.tenantId,program_id:originalReplication.programId,package_id:originalReplication.packageId,package_version:originalReplication.packageVersion},perPage:500});
    if(scriptRows.totalItems!==scriptRows.items.length||scriptRows.items.some(row=>{const value=socialObject(socialJson(row.payload));return value?.publicationTaskId===originalReplication.publicationTaskId&&socialObject(value.schedule)?.stepKind==='script'&&value.status==='succeeded';}))throw new SocialContentWorkflowError('account_playbook_baseline_revision_required',409);
    const prior=Number(baseline.version);if(!Number.isSafeInteger(prior)||prior<1)throw new SocialContentWorkflowError('account_playbook_baseline_revision_required',409);
    initialAuthorityBaselineVersion=prior+1;baseline=null;
  }
  const factVersionKey = (value: { id: string; revision: number; contentHash: string } | null | undefined): string => (
    value ? `${value.id}\0${value.revision}\0${value.contentHash}` : ''
  );
  let executionVerifiedContext = verifiedContext;
  if (baseline?.verifiedContextSnapshot) {
    // A durable retry is the same production run. Keep the admitted enterprise
    // facts even if the user saved a newer profile while a provider was busy.
    executionVerifiedContext = structuredClone(baseline.verifiedContextSnapshot);
  } else if (baseline
    && factVersionKey(baseline.enterpriseFactVersion) !== factVersionKey(verifiedContext.factVersion)) {
    // Historic baselines without a value snapshot cannot be truthfully
    // replayed against a different fact generation. Require a new plan instead
    // of silently relabelling the old script with current enterprise facts.
    throw new SocialContentWorkflowError('social_content_enterprise_fact_replan_required', 409);
  }
  if(baseline)assertAccountPlaybookBaselineCurrent(baseline,replicationContext,detail.brief.callToAction);
  if(baseline?.contentTemplateStructure&&socialRequestHash(baseline.contentTemplateStructure)!==socialRequestHash(contentTemplateStructure))throw new SocialContentWorkflowError('content_template_structure_changed_during_production',409);
  let directorFormula: InternalSocialContentFormula | null = null;
  let staleFormulaReference = false;
  if (baseline?.formulaReference) {
    try {
      directorFormula = await resolveSocialContentFormulaReference({
        repository: input.repository,
        formulaId: baseline.formulaReference.formulaId,
        version: baseline.formulaReference.version,
      });
    } catch (error) {
      // Bundled formulas were intentionally removed. Re-ground older tasks
      // through the governed inspiration -> enterprise knowledge fallback.
      if (!(error instanceof SocialContentWorkflowError)
        || error.code !== 'social_content_formula_reference_invalid') throw error;
      baseline = null;
      staleFormulaReference = true;
    }
  }
  if (baseline?.source === 'knowledge_fallback'
    && baseline.match?.verifiedKnowledgeSource === 'none'
    && !baseline.formulaReference
    && !baseline.match?.inspirationReference
    && !baseline.match?.userProductAssociation) {
    // Older v3 baselines treated an empty tenant as a knowledge fallback and
    // then blocked on missing evidence. Re-freeze them into the governed
    // system-theme baseline so first-content tasks gain the new safe fallback.
    baseline = null;
  }
  const replicationBaselineOutdated = !existingWeeklyPreSupply && Boolean(detail.replicationScript?.shots.length
    && (baseline?.scenes.length !== detail.replicationScript.shots.length
      || detail.replicationScript.shots.some((shot, index) => (
        socialText(baseline?.scenes[index]?.voiceover) !== socialText(shot.spokenText || shot.captionText)
        || socialText(baseline?.scenes[index]?.caption) !== socialText(shot.captionText || shot.spokenText)
      ))));
  if (!baseline
    || Boolean(contentTemplateStructure && !baseline.contentTemplateStructure)
    || baseline.groundingVersion !== SOCIAL_SCRIPT_GROUNDING_VERSION
    || replicationBaselineOutdated) {
    // Compatibility path for older tasks: discard any baseline that directly
    // interpolated title/objective/product free text and re-freeze it from
    // governed formula/inspiration structure plus verified enterprise facts.
    const storedReference = socialObject(socialJson(taskRecord.formula_reference));
    const formulaId = staleFormulaReference ? '' : baseline?.formulaReference?.formulaId || socialText(storedReference?.formulaId);
    const formulaVersion = staleFormulaReference ? '' : baseline?.formulaReference?.version || socialText(storedReference?.version);
    directorFormula = formulaId && formulaVersion
      ? await resolveSocialContentFormulaReference({
          repository: input.repository,
          formulaId,
          version: formulaVersion,
        })
      : null;
    const themeId=detail.theme?.themeId;
    const inspiration = themeId
      ? detail.brief.referenceReuse ? await (async () => {
          const resolved = await resolveSocialTaskReferenceScript({tenantId: input.tenantId, themeId,
            verifiedContext: executionVerifiedContext, referenceReuse: detail.brief.referenceReuse, referenceStore: input.repository.dataStore,
            referenceSources: detail.sources.filter(source => source.status === 'active' && source.kind === 'reference_link')});
          if (!resolved) throw new SocialContentWorkflowError('social_reference_reuse_source_missing', 409);
          return resolved.match;
        })() : originalReplication?await (async()=>{
          if(!input.repository.dataStore)throw new SocialContentWorkflowError('weekly_replication_authority_unverified',409);
          const authority=socialObject(socialObject(socialJson(taskRecord.brief))?._weeklyAuthority) as unknown as Awaited<ReturnType<typeof import('../runtime/socialWeeklyProductionAuthority.js').bindWeeklyProductionAuthority>>;
          const pkg=authority.weeklyPackage,item=pkg.agentPlanning?.dispatch?.scheduleItems.find(item=>item.publicationTaskId===originalReplication.publicationTaskId),analysis=pkg.agentPlanning?.directorAnalyses.find(analysis=>analysis.analysisId===item?.directorAnalysisRef.id);
          if(!analysis)throw new SocialContentWorkflowError('weekly_production_planning_missing',409);
          const {readWeeklyReferenceSources,weeklyReferenceResolver}=await import('../runtime/socialWeeklyReferenceSource.js');
          const references=await readWeeklyReferenceSources(input.repository.dataStore,input.tenantId,authority,analysis);
          const resolved=await weeklyReferenceResolver(references)({tenantId:input.tenantId,themeId,verifiedContext:executionVerifiedContext,referenceSources:detail.sources.filter(source=>source.status==='active'&&source.kind==='reference_link')});
          if(!resolved)throw new SocialContentWorkflowError('weekly_reference_source_missing',409);return resolved.match;
        })():await resolveSocialInspirationScript({
          tenantId: input.tenantId,
          themeId,
          verifiedContext: executionVerifiedContext,
        })
      : null;
    baseline = freezeSocialScriptBaseline({
      replicationContext,
      contentTemplateStructure,
      brief: detail.brief,
      theme: detail.theme ?? null,
      formula: directorFormula,
      inspiration,
      replicationScript: detail.replicationScript ?? null,
      verifiedContext: executionVerifiedContext,
      lockedAt: new Date().toISOString(),
      previous: baseline,
    });
    if(initialAuthorityBaselineVersion!==null)baseline={...baseline,version:String(initialAuthorityBaselineVersion)};
    await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, taskRecord.id, {
      script_baseline: baseline,
      formula_reference: baseline.formulaReference ?? '',
      updated_at: new Date().toISOString(),
    });
  }
  if (!baseline) throw new Error('脚本基线生成失败，已停止自动制作');

  return {baseline,directorFormula,executionVerifiedContext};
}
