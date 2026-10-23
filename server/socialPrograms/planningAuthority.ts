import {freezeWeeklyTargetAccountPlaybook,verifyWeeklyPlanningPlaybooks} from './weeklyTargetAccountPlaybook.js';
import {verifiedWeeklyPlanningTemplateAdoption,weeklyPlanningAnalysisHash,weeklyPlanningExecutionSelection} from './weeklyPlanningTemplateAdoption.js';
import {adoptWeeklyAutomationTemplate} from './weeklyAutomationTemplate.js';
import {assertWeeklyScheduleActor} from './weeklyScheduleActor.js';
import {withExecutionPackageGate,executionPackageFrozen} from './weeklyExecutionGate.js';
import {latestPackageRow} from './weeklyOperatingPackageSupport.js';
import {weeklyProductionPopulation} from './weeklyProductionPopulation.js';
import {selectWeeklyPlanningCoverage,assertWeeklyPlanningCoverage,assertWeeklyDetailedCoverage,type WeeklyDirectorSlotGap} from './weeklyPlanningCoverage.js';
import {SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {readWeeklyTemplateStructure} from './weeklyTemplateStructure.js';
import { createCustomerFeedbackTopicService } from './customerFeedbackTopics.js';
import { latestMaterialEvidenceConfiguration } from './materialEvidenceConfiguration.js';
import { classifyMaterialEvidence } from './materialEvidenceClassification.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import type {
  VersionedSocialRef,
  WeeklyAgentPlanningState,
  WeeklyBusinessContentDispatch,
  WeeklyDirectorPlanningAnalysis,
  WeeklyOperatingPackage,
  WeeklyOperatingScheduleSkeleton,
} from '../../shared/contracts/socialProgram.js';
import { listCompleteSocialDiscoverySupply } from '../socialDiscovery/supply.js';
import { ownedReferenceSupply } from './ownedReferenceSupply.js';
import { diagnoseOwnedReference,ownedDiagnosisReady } from './ownedReferenceDiagnosis.js';
import { allocateWeeklyReferenceSources } from './weeklyReferenceSources.js';
import { socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import type { SocialInspirationHandoff } from '../../shared/contracts/socialContentWorkflow.js';
import { acquireDurableOperationLease, assertDurableOperationLease, releaseDurableOperationLease, DurableOperationLeaseError } from '../runtime/durableLease.js';
import { SocialProgramError } from './service.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Record_} from '../storage/datastore.js';
import {socialObject} from '../starter198/socialContentValidation.js';
import {verifiedWeeklyCandidateMedia} from '../runtime/weeklyCandidateReassessment.js';
import {readCandidateContextAssessment} from '../socialDiscovery/candidateContextAssessment.js';
import {readCandidateSemanticAssessment} from '../socialDiscovery/candidateSemanticAssessment.js';
import {readCandidateTransferabilityAssessment} from '../socialDiscovery/candidateTransferabilityAssessment.js';
import {selectWeeklyDiscoveryProductFacts} from '../digitalEmployees/weeklyDiscoveryScope.js';
import {WEEKLY_PREPRODUCTION_JOBS,type WeeklyExactSettlementPortsForRun,type WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import {PREPRODUCTION_RETRY_ATTEMPTS,type WeeklyPreproductionRetryAttempt} from '../runtime/weeklyPreproductionRetryAttempts.js';
import {readWeeklyPreproductionRetryAttempt} from '../runtime/weeklyPreproductionRetryAttempts.js';
import {WEEKLY_TEMPLATE_ADOPTIONS} from './weeklyAutomationTemplate.js';

export const WEEKLY_AGENT_PLANNING = 'social_weekly_agent_planning';

const directorMediaRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../data/media');
type DirectorAdmissionReaders={
 media:typeof verifiedWeeklyCandidateMedia;
 context:typeof readCandidateContextAssessment;
 semantic:typeof readCandidateSemanticAssessment;
 transferability:typeof readCandidateTransferabilityAssessment;
};
const directorAdmissionReaders:DirectorAdmissionReaders={media:verifiedWeeklyCandidateMedia,context:readCandidateContextAssessment,semantic:readCandidateSemanticAssessment,transferability:readCandidateTransferabilityAssessment};
type DirectorTestPorts={mediaRoot:string;transferabilityPorts:NonNullable<Parameters<typeof readCandidateTransferabilityAssessment>[0]['ports']>};
function checkedDirectorTestPorts(ports?:DirectorTestPorts):DirectorTestPorts|undefined{
 if(!ports)return undefined;
 if(process.env.NODE_ENV!=='test'||!path.isAbsolute(ports.mediaRoot)||!ports.transferabilityPorts||!ports.transferabilityPorts.materials||!ports.transferabilityPorts.livePresenter||!ports.transferabilityPorts.privateAssetTenantId)throw new SocialProgramError('weekly_director_test_ports_forbidden',403,'编导隔离端口只可用于服务端测试。');
 return ports;
}
type WeeklyDirectorDiscoveryAuthority={rootJobId:string;currentJobId:string;runId:string};
async function directorRows(store:DataStore,collection:string,where:Record<string,string|number>):Promise<Record_[]>{
 const rows:Record_[]=[];let total:number|undefined;
 for(let page=1;page<=1000;page++){
  const result=await store.list<Record_>(collection,{where,page,perPage:200,sort:'id'});
  if(!Number.isSafeInteger(result.totalItems)||result.totalItems<0||total!==undefined&&result.totalItems!==total||result.items.some(row=>Object.entries(where).some(([key,value])=>row[key]!==value)||rows.some(old=>old.id===row.id)))throw new SocialProgramError('weekly_director_authority_scan_invalid',409,'周包编导权威读取不完整。');
  total=result.totalItems;rows.push(...result.items);
  if(rows.length===total)return rows;
  if(!result.items.length||rows.length>total)break;
 }throw new SocialProgramError('weekly_director_authority_scan_invalid',409,'周包编导权威读取不完整。');
}
async function readDirectorDiscoveryAuthority(store:DataStore,scope:{tenantId:string;programId:string;packageId:string;packageVersion:number},reference:WeeklyDirectorDiscoveryAuthority,testPorts?:DirectorTestPorts,exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun){
 const fail=()=>new SocialProgramError('weekly_director_discovery_authority_required',409,'本轮编导必须绑定真实采集任务、运行与后分析准入。');
 if(!reference?.rootJobId||!reference.currentJobId||!reference.runId)throw fail();
 const where={tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion};
 const roots=await directorRows(store,WEEKLY_PREPRODUCTION_JOBS,{...where,id:reference.rootJobId});
 if(roots.length!==1)throw fail();
 const rootRow=roots[0]!,root=rootRow.payload as WeeklyPreproductionJob;
 if(!root||root.kind!=='discovery'||root.jobId!==rootRow.id||root.recordHash!==rootRow.record_hash||root.recordHash!==socialRequestHash({...root,recordHash:''})||root.tenantId!==scope.tenantId||root.programId!==scope.programId||root.packageId!==scope.packageId||root.packageVersion!==scope.packageVersion)throw fail();
 const currentRows=reference.currentJobId===root.jobId?[rootRow]:await directorRows(store,PREPRODUCTION_RETRY_ATTEMPTS,{...where,id:reference.currentJobId,root_job_id:root.jobId});
 if(currentRows.length!==1)throw fail();
 const currentRow=currentRows[0]!,job=currentRow.payload as WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;
 if(!job||job.kind!=='discovery'||job.jobId!==currentRow.id||job.recordHash!==currentRow.record_hash||job.recordHash!==socialRequestHash({...job,recordHash:''})||job.tenantId!==root.tenantId||job.programId!==root.programId||job.packageId!==root.packageId||job.packageVersion!==root.packageVersion||job.consumerTaskId!==root.consumerTaskId||job.consumerInputHash!==root.consumerInputHash||job.sourceHash!==root.sourceHash||socialRequestHash(job.authority)!==socialRequestHash(root.authority))throw fail();
 const runs=await directorRows(store,'social_discovery_runs',{tenant_id:scope.tenantId,runId:reference.runId});
 if(runs.length!==1)throw fail();
 const run=runs[0] as unknown as import('../../shared/contracts/socialContentWorkflow.js').SocialInspirationCollectionRun;
 const expectedRunId=`weekly_discovery_${socialRequestHash({tenantId:scope.tenantId,key:job.originalRunKey})}`;
 if(run.runId!==expectedRunId)throw fail();
 try{
  const {readWeeklyQualifiedDirectorAdmission}=await import('../runtime/weeklyPreproductionProducer.js');
  return await readWeeklyQualifiedDirectorAdmission({store,rootJob:root,job,run,mediaRoot:testPorts?.mediaRoot??directorMediaRoot,...(testPorts?{transferabilityPorts:testPorts.transferabilityPorts}:{}),...(exactAnalysisPortsForRun?{exactAnalysisPortsForRun}:{})});
 }catch{throw fail();}
}

/** A discovery score and an ID allowlist are not a product-specific production
 * admission. Recheck the current package context, exact media, semantic product
 * evidence, live target resources and the same exact-video handoff before a
 * weekly director can freeze any external mother reference. */
export async function assertWeeklyDirectorQualifiedAdmission(input:{store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number;candidateId:string;handoffs:Record_[];mediaRoot?:string;readers?:DirectorAdmissionReaders}):Promise<Record_>{
 const {store,tenantId,candidateId}=input,readers=input.readers??directorAdmissionReaders;
 const invalid=()=>new SocialProgramError('weekly_candidate_post_admission_required',409,'本轮候选尚无绑定当前产品、人物声音与目标素材的完整准入证明。');
 try{
  const record=await store.getById<Record_>('trend_videos',candidateId);
  if(!record||record.tenantId!==tenantId||!await readers.media(record,input.mediaRoot??directorMediaRoot))throw invalid();
  const context=await readers.context(store,tenantId,candidateId,{programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion},record);
  if(!context||context.tenantId!==tenantId||context.candidateId!==candidateId||context.programId!==input.programId||context.packageId!==input.packageId||context.packageVersion!==input.packageVersion||!context.productFacts.length)throw invalid();
  const scopeRow=await store.getById<Record_>('social_discovery_scopes',context.keyword.scopeId),scope=socialObject(socialJson(scopeRow?.payload))??{},keywordSet=socialObject(scope.keywordSet)??{},scopeProduct=socialObject(keywordSet.scope)??{};
  const profileRows=await store.list<Record_>('tenant_profiles',{where:{tenant_id:tenantId},perPage:2});
  const profile=socialObject(socialJson(profileRows.items[0]?.profile))??{},profileProducts=socialObject(profile.products)??{};
  const products=Array.isArray(profileProducts.items)?profileProducts.items.map(item=>socialObject(item)??{}):[];
  const selected=selectWeeklyDiscoveryProductFacts([String(scopeProduct.productRef??'')],products.map(item=>({name:String(item.name??'')})));
  if(!scopeRow||scopeRow.tenant_id!==tenantId||scopeRow.version!==context.keyword.scopeVersion||socialRequestHash(scopeRow)!==context.keyword.scopeHash||profileRows.totalItems!==1||selected.length!==1||!context.productFacts.some(f=>f.statement.trim()===selected[0]!.name.trim()))throw invalid();
  const semantic=await readers.semantic(store,context);
  if(!semantic||semantic.tenantId!==tenantId||semantic.candidateId!==candidateId||semantic.contextHash!==context.recordHash||semantic.dimensions.relevance.state!=='assessed'||semantic.dimensions.relevance.value===null||semantic.dimensions.relevance.value<0.7||!semantic.dimensions.relevance.evidence.length)throw invalid();
  const productFactKeys=new Set(context.productFacts.map(f=>`${f.ref.type}:${f.ref.id}@${f.ref.version}`));
  const observedShots=new Set(context.observations.map(s=>s.shotIndex));
  if(!semantic.dimensions.relevance.evidence.every(e=>productFactKeys.has(e.factRef)&&observedShots.has(e.shotIndex)&&e.quote.length>=4))throw invalid();
  const transferable=await readers.transferability({store,context,semantic});
  if(!transferable||transferable.state!=='assessed'||transferable.tenantId!==tenantId||transferable.candidateId!==candidateId||transferable.contextHash!==context.recordHash||transferable.semanticAssessmentId!==semantic.assessmentId)throw invalid();
  const analysis=socialObject(socialJson(record.aiAnalysis))??{};
  const exact=input.handoffs.filter(row=>{
   const handoff=socialObject(socialJson(row.payload))??{};
   const source=socialObject(handoff.source)??{};
   const rights=socialObject(handoff.rights)??{};
   return row.tenant_id===tenantId&&row.record_hash===socialRequestHash(row.payload)&&handoff.inspirationId===candidateId&&handoff.readiness==='production_reference'&&handoff.analysisId===analysis.analysisRunId&&source.sourceUrl===record.sourceUrl&&Boolean(handoff.version??handoff.analysisVersion)&&rights.mayAnalyze===true&&rights.mayAdapt===true&&rights.mayUseOriginalMedia===false;
  });
  if(exact.length!==1)throw invalid();
  return exact[0]!;
 }catch(error){if(error instanceof SocialProgramError&&error.code==='weekly_candidate_post_admission_required')throw error;throw invalid();}
}

type PlanningRow = {
  id: string;
  tenant_id: string;
  program_id: string;
  package_id: string;
  package_version: number;
  planning_version: number;
  payload: WeeklyAgentPlanningState;
  created_at: string;
};

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function minutes(value: number): number {
  return Math.max(30, Math.min(24 * 60, Math.round(Number(value) || 180)));
}

export function buildWeeklyOperatingScheduleSkeleton(pkg: WeeklyOperatingPackage): WeeklyOperatingScheduleSkeleton {
  const byMother = new Map<string, typeof pkg.socialContentPackage.publicationTasks>();
  for (const item of weeklyProductionPopulation(pkg.socialContentPackage.publicationTasks).productionPublications) {
    byMother.set(item.motherContentId, [...(byMother.get(item.motherContentId) ?? []), item]);
  }
  const createdAt = pkg.createdAt;
  const sourceAllocation = allocateWeeklyReferenceSources(pkg.socialContentPackage.publicationTasks, pkg.referenceSourcePolicy);
  return {
    skeletonId: stableId('weekly_skeleton', { packageId: pkg.packageId, version: pkg.version }),
    packageId: pkg.packageId,
    packageVersion: pkg.version,
    generatedBy: 'business_agent',
    tokenCost: 0,
    slots: [...byMother.entries()].map(([motherContentId, tasks]) => ({
      ...(pkg.referenceSourcePolicy ? { referenceSource: sourceAllocation.get(motherContentId) as 'owned' | 'external' } : {}),
      slotId: stableId('weekly_slot', { packageId: pkg.packageId, version: pkg.version, motherContentId }),
      motherContentId,
      publicationTaskIds: tasks.map(item => item.publicationTaskId),
      accountIds: [...new Set(tasks.map(item => item.accountId))],
      platforms: [...new Set(tasks.map(item => item.platform))],
      plannedPublishWindows: [...new Set(tasks.map(item => item.publishWindow).filter((value): value is string => Boolean(value)))],
      objective: pkg.objective,
      quantity: tasks.length,
    })),
    createdAt,
  };
}

async function latest(dataStore: DataStore, tenantId: string, programId: string, packageId: string, packageVersion: number): Promise<PlanningRow | null> {
  return (await dataStore.list<PlanningRow>(WEEKLY_AGENT_PLANNING, {
    where: { tenant_id: tenantId, program_id: programId, package_id: packageId, package_version: packageVersion },
    sort: '-planning_version', page: 1, perPage: 1,
  })).items[0] ?? null;
}

async function append(dataStore: DataStore, tenantId: string, state: WeeklyAgentPlanningState): Promise<WeeklyAgentPlanningState> {
  const id = createHash('sha256').update(JSON.stringify([tenantId, state.programId, state.packageId, state.packageVersion, state.version])).digest('hex').slice(0, 15);
  let saved: PlanningRow | null;
  try {
    saved = await dataStore.create<PlanningRow>(WEEKLY_AGENT_PLANNING, {
      id,
      tenant_id: tenantId,
      program_id: state.programId,
      package_id: state.packageId,
      package_version: state.packageVersion,
      planning_version: state.version,
      payload: state,
      created_at: state.updatedAt,
    });
  } catch (error) {
    const winner = await dataStore.getById<PlanningRow>(WEEKLY_AGENT_PLANNING, id);
    if (winner) throw new SocialProgramError('weekly_agent_planning_version_conflict', 409, '本周计划已更新，请刷新后重试；已有计划已保留。');
    throw error;
  }
  if (!saved) {
    const winner = await dataStore.getById<PlanningRow>(WEEKLY_AGENT_PLANNING, id);
    if (winner) throw new SocialProgramError('weekly_agent_planning_version_conflict', 409, '本周计划已更新，请刷新后重试；已有计划已保留。');
    throw new SocialProgramError('weekly_agent_planning_storage_unavailable', 503, 'Agent 计划状态暂时无法保存。');
  }
  return state;
}

function requirePlanningVersion(current: WeeklyAgentPlanningState, expected: number | undefined): void {
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    throw new SocialProgramError('weekly_agent_planning_version_required', 400, '请提供有效的 Agent 规划版本。');
  }
  if (current.version !== expected) {
    throw new SocialProgramError('weekly_agent_planning_version_conflict', 409, '本周计划已更新，请从后端刷新后重试；已有计划已保留。');
  }
}

function requireEditablePlanning(current: WeeklyAgentPlanningState): void {
  if (current.status === 'confirmed' || current.status === 'dispatched') {
    throw new SocialProgramError('weekly_agent_plan_already_confirmed', 409, '本周计划已确认或已派单，不能重写分析和排期；请创建新的周任务包修订并重新确认。');
  }
}

function verifiedPinnedReference(pin: NonNullable<WeeklyAgentPlanningState['pinnedReference']>): boolean {
  const { recordHash, ...body } = pin;
  return pin.schema === 'weekly-pinned-reference.v1' && recordHash === socialRequestHash(body)
    && Boolean(pin.selectedBy.trim() && pin.candidateId && pin.accountCandidateId && pin.slotId)
    && /^[a-f0-9]{64}$/.test(pin.mediaSha256) && /^[a-f0-9]{64}$/.test(pin.handoffRecordHash);
}
function sourceBelongsToAccount(videoUrl:string,accountUrl:string):boolean{
  try{
    const video=new URL(videoUrl),account=new URL(accountUrl);
    const host=(url:URL)=>url.hostname.toLowerCase().replace(/^www\./,'');
    const first=(url:URL)=>url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    return video.protocol==='https:'&&account.protocol==='https:'&&host(video)===host(account)&&Boolean(first(account))&&first(video)===first(account);
  }catch{return false;}
}

/** Read-only options for the existing weekly intervention card. A historical
 * supply item cannot appear without the current package's exact run lineage. */
export async function readWeeklyPinnableReferenceOptions(store:DataStore,input:{tenantId:string;programId:string;packageId:string;packageVersion:number}){
 const planning=await latest(store,input.tenantId,input.programId,input.packageId,input.packageVersion);
 if(!planning)throw new SocialProgramError('weekly_agent_planning_not_found',404,'本周编导计划尚未建立。');
 const state=planning.payload;
 const empty=(status:'awaiting_collection'|'awaiting_admission'|'already_pinned'|'plan_locked')=>({status,packageVersion:input.packageVersion,planningVersion:state.version,options:[] as Array<{candidateId:string;title:string;sourceUrl:string;accountUrl:string;discoveryAuthority:WeeklyDirectorDiscoveryAuthority}>});
 if(state.pinnedReference)return empty('already_pinned');
 if(state.status==='confirmed'||state.status==='dispatched')return empty('plan_locked');
 const where={tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,kind:'discovery'};
 const roots=await directorRows(store,WEEKLY_PREPRODUCTION_JOBS,where);
 if(!roots.length)return empty('awaiting_collection');
 if(roots.length!==1)throw new SocialProgramError('weekly_pinned_reference_run_ambiguous',409,'本周采集运行不唯一，需系统核验。');
 const root=roots[0]!.payload as WeeklyPreproductionJob;
 if(!root||root.recordHash!==roots[0]!.record_hash||root.recordHash!==socialRequestHash({...root,recordHash:''}))throw new SocialProgramError('weekly_pinned_reference_run_changed',409,'本周采集证据已变化，需系统核验。');
 const current=await readWeeklyPreproductionRetryAttempt(store,root)??root;
 const runId=`weekly_discovery_${socialRequestHash({tenantId:input.tenantId,key:current.originalRunKey})}`;
 const runs=await directorRows(store,'social_discovery_runs',{tenant_id:input.tenantId,runId});
 if(!runs.length)return empty('awaiting_collection');
 if(runs.length!==1)throw new SocialProgramError('weekly_pinned_reference_run_ambiguous',409,'本周采集运行不唯一，需系统核验。');
 const run=runs[0]!,target=socialObject(socialObject(run.scopeSnapshot)?.weeklyAccountCollectionTarget);
 if(target?.targetCount!==5||typeof target.accountUrl!=='string')return empty('awaiting_collection');
 const discoveryAuthority={rootJobId:root.jobId,currentJobId:current.jobId,runId};
 const admitted=await readDirectorDiscoveryAuthority(store,input,discoveryAuthority);
 if(!admitted.candidateIds.length)return empty('awaiting_admission');
 const [videos,accounts,handoffs]=await Promise.all([
  listCompleteSocialDiscoverySupply({tenantId:input.tenantId,dataStore:store,filters:{candidateType:'video',decision:'accepted',businessModel:'b2b',sort:'score'}}),
  listCompleteSocialDiscoverySupply({tenantId:input.tenantId,dataStore:store,filters:{candidateType:'account',decision:'accepted',businessModel:'b2b',sort:'score'}}),
  directorRows(store,'starter_social_inspiration_handoff_versions',{tenant_id:input.tenantId}),
 ]);
 const options:Array<{candidateId:string;title:string;sourceUrl:string;accountUrl:string;discoveryAuthority:WeeklyDirectorDiscoveryAuthority}>=[];
 for(const candidateId of admitted.candidateIds){
  const video=videos.items.find(item=>item.candidateId===candidateId);
  const account=accounts.items.find(item=>Array.isArray(item.raw?.evidenceVideoIds)&&item.raw.evidenceVideoIds.includes(candidateId)&&item.sourceUrl===target.accountUrl);
  const record=await store.getById<Record_>('trend_videos',candidateId);
  if(!video||!account||!record||record.tenantId!==input.tenantId||!sourceBelongsToAccount(String(record.sourceUrl??''),account.sourceUrl))continue;
  const analysis=socialObject(socialJson(record.aiAnalysis))??{};
  const exact=handoffs.filter(row=>{const handoff=socialObject(socialJson(row.payload))??{},source=socialObject(handoff.source)??{};return row.record_hash===socialRequestHash(row.payload)&&handoff.inspirationId===candidateId&&handoff.readiness==='production_reference'&&handoff.analysisId===analysis.analysisRunId&&source.sourceUrl===record.sourceUrl;});
  if(!/^[a-f0-9]{64}$/.test(String(analysis.contentSha256??''))||exact.length!==1)continue;
  try{await assertWeeklyDirectorQualifiedAdmission({store,tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,candidateId,handoffs});}catch{continue;}
  options.push({candidateId,title:video.title,sourceUrl:String(record.sourceUrl),accountUrl:account.sourceUrl,discoveryAuthority});
 }
 return {status:options.length?'ready' as const:'awaiting_admission' as const,packageVersion:input.packageVersion,planningVersion:state.version,options};
}

function unguardedPlanningAuthority(dataStore: DataStore, beforeAppend: () => Promise<void> = async () => undefined,
  testPorts?:DirectorTestPorts,exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun) {
  const guardedAppend = async (tenantId: string, state: WeeklyAgentPlanningState) => {
    await beforeAppend();
    return append(dataStore, tenantId, state);
  };
  return {
    async initialize(tenantId: string, pkg: WeeklyOperatingPackage): Promise<WeeklyAgentPlanningState> {
      const existing = await latest(dataStore, tenantId, pkg.programId, pkg.packageId, pkg.version);
      if (existing) return existing.payload;
      const skeleton = buildWeeklyOperatingScheduleSkeleton(pkg);
      const state: WeeklyAgentPlanningState = {
        planningId: stableId('weekly_agent_planning', { packageId: pkg.packageId, version: pkg.version }),
        version: 1,
        programId: pkg.programId,
        packageId: pkg.packageId,
        packageVersion: pkg.version,
        status: 'outline_ready',
        skeleton,
        referenceSourcePolicy: pkg.referenceSourcePolicy ?? null,
        directorAnalyses: [],
        detailedSchedule: null,
        userConfirmation: null,
        dispatch: null,
        createdAt: pkg.createdAt,
        updatedAt: pkg.createdAt,
      };
      return guardedAppend(tenantId, state);
    },

    async get(tenantId: string, programId: string, packageId: string, packageVersion: number): Promise<WeeklyAgentPlanningState> {
      const row = await latest(dataStore, tenantId, programId, packageId, packageVersion);
      if (!row) throw new SocialProgramError('weekly_agent_planning_not_found', 404, 'Agent 计划状态不存在。');
      return row.payload;
    },

    async pinDirectorReference(input: {
      tenantId:string;programId:string;packageId:string;packageVersion:number;
      expectedPlanningVersion:number;candidateId:string;selectedBy:string;expectedAccountUrl:string;
      discoveryAuthority:WeeklyDirectorDiscoveryAuthority;now?:Date;
    }):Promise<WeeklyAgentPlanningState> {
      const current=await this.get(input.tenantId,input.programId,input.packageId,input.packageVersion);
      requirePlanningVersion(current,input.expectedPlanningVersion);
      requireEditablePlanning(current);
      const invalid=()=>new SocialProgramError('weekly_pinned_reference_not_admitted',409,'指定视频必须属于本轮五母版采集、完成原片精确分析并有同账号生产交接。');
      if(!input.selectedBy?.trim()||!input.candidateId?.trim()||!/^https?:\/\//i.test(input.expectedAccountUrl??'')||current.pinnedReference)throw invalid();
      const slot=current.skeleton.slots.find(item=>item.referenceSource!=='owned');
      if(current.skeleton.slots.length<5||!slot)throw invalid();
      const admitted=await readDirectorDiscoveryAuthority(dataStore,{tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion},input.discoveryAuthority,testPorts,exactAnalysisPortsForRun);
      if(!admitted.candidateIds.includes(input.candidateId))throw invalid();
      const [videos,accounts,handoffs]=await Promise.all([
        listCompleteSocialDiscoverySupply({tenantId:input.tenantId,dataStore,filters:{candidateType:'video',decision:'accepted',businessModel:'b2b',sort:'score'}}),
        listCompleteSocialDiscoverySupply({tenantId:input.tenantId,dataStore,filters:{candidateType:'account',decision:'accepted',businessModel:'b2b',sort:'score'}}),
        directorRows(dataStore,'starter_social_inspiration_handoff_versions',{tenant_id:input.tenantId}),
      ]);
      const video=videos.items.find(item=>item.candidateId===input.candidateId);
      const account=accounts.items.find(item=>Array.isArray(item.raw?.evidenceVideoIds)&&item.raw.evidenceVideoIds.includes(input.candidateId));
      const record=await dataStore.getById<Record_>('trend_videos',input.candidateId);
      if(!video||!account||account.sourceUrl!==input.expectedAccountUrl||!record||record.tenantId!==input.tenantId||!sourceBelongsToAccount(String(record.sourceUrl??''),account.sourceUrl))throw invalid();
      const exactHandoff=await assertWeeklyDirectorQualifiedAdmission({store:dataStore,tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,candidateId:input.candidateId,handoffs,...(testPorts?{mediaRoot:testPorts.mediaRoot,readers:{...directorAdmissionReaders,transferability:(args)=>readCandidateTransferabilityAssessment({...args,ports:testPorts.transferabilityPorts})}}:{})});
      const analysis=socialObject(socialJson(record.aiAnalysis))??{};
      if(!/^https?:\/\//i.test(String(record.sourceUrl??'')))throw invalid();
      const body={schema:'weekly-pinned-reference.v1' as const,slotId:slot.slotId,candidateId:input.candidateId,evidenceVersion:video.evidenceVersion,accountCandidateId:account.candidateId,accountEvidenceVersion:account.evidenceVersion,accountSourceUrl:account.sourceUrl,mediaSha256:String(analysis.contentSha256),handoffRecordHash:String(exactHandoff.record_hash),sourceUrl:String(record.sourceUrl),selectedBy:input.selectedBy.trim(),selectedAt:(input.now??new Date()).toISOString(),discoveryAuthority:input.discoveryAuthority};
      if(!/^[a-f0-9]{64}$/.test(body.mediaSha256))throw invalid();
      return guardedAppend(input.tenantId,{...current,version:current.version+1,pinnedReference:{...body,recordHash:socialRequestHash(body)},directorAnalyses:[],directorGaps:[],detailedSchedule:null,userConfirmation:null,dispatch:null,status:'outline_ready',updatedAt:body.selectedAt});
    },

    async runDirectorAnalysis(input: {
      tenantId: string;
      programId: string;
      packageId: string;
      packageVersion: number;
      expectedPlanningVersion: number;
      actor: 'director_agent';
      selectedSlotIds?:string[];
      /** Server-only supplement path: retain the already frozen owned reference and handoff. */
      preserveOwnedReferences?:boolean;
      /** Automatic weekly collection may only freeze references proven by its
       * own immutable discovery-run lineage, including prior daily attempts. */
      eligibleVideoIds?:string[];
      discoveryAuthority?:WeeklyDirectorDiscoveryAuthority;
      now?: Date;
    }): Promise<WeeklyAgentPlanningState> {
      if (input.actor !== 'director_agent') throw new SocialProgramError('director_analysis_authority_required', 403, '只有编导 Agent 可以写入对标分析。');
      const current = await this.get(input.tenantId, input.programId, input.packageId, input.packageVersion);
      requirePlanningVersion(current, input.expectedPlanningVersion);
      requireEditablePlanning(current);
      const analysisCoverage=selectWeeklyPlanningCoverage(current,input.selectedSlotIds);
      const pin=current.pinnedReference;
      if(pin){
        if(!verifiedPinnedReference(pin)||!input.discoveryAuthority||socialRequestHash(input.discoveryAuthority)!==socialRequestHash(pin.discoveryAuthority)||!analysisCoverage.selectedSlotIds.includes(pin.slotId))throw new SocialProgramError('weekly_pinned_reference_invalid',409,'指定参考视频的版本或本轮采集血缘已变化，不能继续编导。');
      }
      const analysisSlots=current.skeleton.slots.filter(slot=>analysisCoverage.selectedSlotIds.includes(slot.slotId));
      // Partial reanalysis must not carry an older external mother reference
      // around the current-run gate by selecting only owned slots.
      const hasExternal=current.skeleton.slots.some(slot=>slot.referenceSource!=='owned');
      const scope={tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId};
      const [adoptions,rootJobs]=hasExternal?await Promise.all([
        directorRows(dataStore,WEEKLY_TEMPLATE_ADOPTIONS,scope),
        directorRows(dataStore,WEEKLY_PREPRODUCTION_JOBS,{...scope,package_version:input.packageVersion,kind:'discovery'}),
      ]):[[],[]];
      const automatic=current.skeleton.slots.length>=5&&(adoptions.some(row=>Number.isSafeInteger(row.package_version)&&Number(row.package_version)<=input.packageVersion)||rootJobs.length>0);
      if(hasExternal&&(automatic||input.eligibleVideoIds||input.discoveryAuthority)){
        if(!input.discoveryAuthority||!input.eligibleVideoIds)throw new SocialProgramError('weekly_director_discovery_authority_required',409,'自动周包编导必须绑定本轮采集权威。');
        if(automatic&&current.skeleton.slots.some(slot=>slot.referenceSource!=='owned'&&!analysisCoverage.selectedSlotIds.includes(slot.slotId)))throw new SocialProgramError('weekly_director_full_external_reanalysis_required',409,'自动周包需要重新验证全部外部母版槽，不能沿用未选槽的旧引用。');
        const admission=await readDirectorDiscoveryAuthority(dataStore,{tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion},input.discoveryAuthority,testPorts,exactAnalysisPortsForRun);
        const admitted=new Set(admission.candidateIds);
        if(input.eligibleVideoIds.length!==admitted.size||new Set(input.eligibleVideoIds).size!==admitted.size||input.eligibleVideoIds.some(id=>!admitted.has(id)))throw new SocialProgramError('weekly_candidate_post_admission_required',409,'编导候选与本轮真实后分析准入不一致。');
        for(const analysis of current.directorAnalyses.filter(item=>!analysisCoverage.selectedSlotIds.includes(item.slotId)&&current.skeleton.slots.some(slot=>slot.slotId===item.slotId&&slot.referenceSource!=='owned'))){
          if(analysis.benchmarkVideoRefs.length!==1||!admitted.has(analysis.benchmarkVideoRefs[0]!.id))throw new SocialProgramError('weekly_candidate_post_admission_required',409,'旧外部母版不属于本轮合格采集血缘，不能在局部重析中保留。');
        }
      }
      const [videos, accounts] = await Promise.all([
        listCompleteSocialDiscoverySupply({ tenantId: input.tenantId, dataStore, filters: { candidateType: 'video', decision: 'accepted', businessModel: 'b2b', sort: 'score' } }),
        listCompleteSocialDiscoverySupply({ tenantId: input.tenantId, dataStore, filters: { candidateType: 'account', decision: 'accepted', businessModel: 'b2b', sort: 'score' } }),
      ]);
      if(input.eligibleVideoIds){const eligible=new Set(input.eligibleVideoIds);videos.items=videos.items.filter(video=>eligible.has(video.candidateId));}
      if (!videos.items.length&&!input.selectedSlotIds) {
        throw new SocialProgramError('qualified_benchmark_supply_required', 409, '详细计划需要已通过服务端评分的 B2B 对标账号和爆款视频。');
      }
      const ownedPairs = await ownedReferenceSupply(dataStore, input.tenantId, input.programId, videos.items, input.now);
      const ownedIds = new Set(ownedPairs.map(pair => pair.video.candidateId));
      const pairs = videos.items.filter(video => !ownedIds.has(video.candidateId)).flatMap(video => {
        const account = accounts.items.find(candidate => Array.isArray(candidate.raw?.evidenceVideoIds) && candidate.raw.evidenceVideoIds.includes(video.candidateId));
        return account ? [{ video, account }] : [];
      });
      const now = (input.now ?? new Date()).toISOString();
      const handoffs = await dataStore.list<any>('starter_social_inspiration_handoff_versions', { where: { tenant_id: input.tenantId }, perPage: 500 });
      if (handoffs.totalItems > handoffs.items.length) throw new SocialProgramError('planning_handoff_scan_truncated', 409, '参考分析版本读取不完整，请补齐读取后再冻结计划。');
      const qualifiedHandoffHashes=new Map<string,string>();
      if(input.eligibleVideoIds){
        const ids=[...new Set(input.eligibleVideoIds)];
        if(ids.length!==input.eligibleVideoIds.length||ids.some(id=>!id||!videos.items.some(video=>video.candidateId===id)))throw new SocialProgramError('weekly_candidate_post_admission_required',409,'本轮候选清单含重复项或未通过基础评分的条目。');
        for(const candidateId of ids){const exact=await assertWeeklyDirectorQualifiedAdmission({store:dataStore,tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,candidateId,handoffs:handoffs.items,...(testPorts?{mediaRoot:testPorts.mediaRoot,readers:{...directorAdmissionReaders,transferability:(args)=>readCandidateTransferabilityAssessment({...args,ports:testPorts.transferabilityPorts})}}:{})});qualifiedHandoffHashes.set(candidateId,String(exact.record_hash));}
      }
      if(pin){
        const video=videos.items.find(item=>item.candidateId===pin.candidateId);
        const account=accounts.items.find(item=>item.candidateId===pin.accountCandidateId&&Array.isArray(item.raw?.evidenceVideoIds)&&item.raw.evidenceVideoIds.includes(pin.candidateId));
        const record=await dataStore.getById<Record_>('trend_videos',pin.candidateId);
        const analysis=socialObject(socialJson(record?.aiAnalysis))??{};
        const exact=handoffs.items.find(row=>row.record_hash===pin.handoffRecordHash&&row.record_hash===socialRequestHash(row.payload)&&(socialObject(socialJson(row.payload))??{}).inspirationId===pin.candidateId);
        if(!video||!account||!record||record.tenantId!==input.tenantId||video.evidenceVersion!==pin.evidenceVersion||account.evidenceVersion!==pin.accountEvidenceVersion||account.sourceUrl!==pin.accountSourceUrl||!sourceBelongsToAccount(String(record.sourceUrl??''),account.sourceUrl)||record.sourceUrl!==pin.sourceUrl||analysis.contentSha256!==pin.mediaSha256||!exact||qualifiedHandoffHashes.get(pin.candidateId)!==pin.handoffRecordHash||!input.eligibleVideoIds?.includes(pin.candidateId))throw new SocialProgramError('weekly_pinned_reference_invalid',409,'指定参考视频的媒体、账号、分析或本轮准入已变化。');
      }
      // One mother-content slot consumes one distinct reference video for the
      // natural week. Keep references already frozen on untouched slots, then
      // allocate the score-ordered supply in skeleton order. A shortage remains
      // a director gap; cycling back to the first video would duplicate a mother.
      const usedVideos=new Set(current.directorAnalyses.filter(analysis=>!analysisCoverage.selectedSlotIds.includes(analysis.slotId)).flatMap(analysis=>analysis.benchmarkVideoRefs.map(ref=>ref.id)));
      const selectedBySlot=new Map<string,(typeof pairs)[number]|(typeof ownedPairs)[number]>();
      for(const slot of analysisSlots){
        const own=slot.referenceSource==='owned'?ownedPairs.filter(pair=>slot.accountIds.includes(pair.account.accountId)):[];
        const previousOwned=input.preserveOwnedReferences&&slot.referenceSource==='owned'?current.directorAnalyses.find(analysis=>analysis.slotId===slot.slotId):undefined;
        const frozenOwned=previousOwned?own.find(pair=>previousOwned.benchmarkVideoRefs.length===1&&previousOwned.benchmarkVideoRefs[0]!.id===pair.video.candidateId&&previousOwned.benchmarkVideoRefs[0]!.version===pair.video.evidenceVersion&&previousOwned.benchmarkAccountRefs.length===1&&previousOwned.benchmarkAccountRefs[0]!.id===pair.account.accountId&&previousOwned.benchmarkAccountRefs[0]!.version===pair.account.version):undefined;
        if(input.preserveOwnedReferences&&slot.referenceSource==='owned'&&previousOwned&&!frozenOwned)continue;
        const pinned=pin&&slot.slotId===pin.slotId?pairs.find(pair=>pair.video.candidateId===pin.candidateId&&pair.account.candidateId===pin.accountCandidateId):undefined;
        if(pin&&slot.slotId===pin.slotId&&!pinned)throw new SocialProgramError('weekly_pinned_reference_invalid',409,'指定参考视频不再有当前账号与视频关联。');
        const choice=pinned??frozenOwned??(slot.referenceSource==='owned'?own:pairs).find(pair=>!usedVideos.has(pair.video.candidateId)&&(!pin||pair.video.candidateId!==pin.candidateId));
        if(choice&&!usedVideos.has(choice.video.candidateId)){selectedBySlot.set(slot.slotId,choice);usedVideos.add(choice.video.candidateId);}
      }
      const feedbackPackageRows = await dataStore.list<any>('social_weekly_operating_packages',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:current.packageId,version:current.packageVersion},perPage:2});
      if(feedbackPackageRows.totalItems>1)throw new SocialProgramError('weekly_feedback_package_ambiguous',409,'客户反馈引用需要唯一的冻结周任务包。');
      const feedbackPackage = feedbackPackageRows.items[0] ? socialJson(feedbackPackageRows.items[0].payload) as WeeklyOperatingPackage : null;
      const outcomes = await Promise.allSettled(analysisSlots.map(async (slot) => {
        const targetAccountPlaybooks=(await Promise.all(slot.accountIds.map(accountId=>freezeWeeklyTargetAccountPlaybook(dataStore,input.tenantId,input.programId,accountId)))).filter((value): value is NonNullable<typeof value>=>value!==null);
        const own = slot.referenceSource === 'owned' ? ownedPairs.filter(pair => slot.accountIds.includes(pair.account.accountId)) : [];
        if (slot.referenceSource === 'owned' && !own.length) throw new SocialProgramError('owned_reference_account_required', 409, '该独立视频目标账号缺少已核验的自有参考，需补齐或明确修订配额。');
        if(slot.referenceSource!=='owned'&&!pairs.length)throw new SocialProgramError('benchmark_account_video_link_required',409,'该外部条目缺少可核验的账号与视频关联，暂不能继续。');
        const previousOwned=input.preserveOwnedReferences&&slot.referenceSource==='owned'?current.directorAnalyses.find(x=>x.slotId===slot.slotId):undefined;
        const frozenOwned=previousOwned?own.find(pair=>previousOwned.benchmarkVideoRefs.length===1&&previousOwned.benchmarkVideoRefs[0]!.id===pair.video.candidateId&&previousOwned.benchmarkVideoRefs[0]!.version===pair.video.evidenceVersion&&previousOwned.benchmarkAccountRefs.length===1&&previousOwned.benchmarkAccountRefs[0]!.id===pair.account.accountId&&previousOwned.benchmarkAccountRefs[0]!.version===pair.account.version):undefined;
        if(input.preserveOwnedReferences&&slot.referenceSource==='owned'&&!frozenOwned)throw new SocialProgramError('owned_reference_frozen_binding_changed',409,'原自有视频及账号证据已变化，补指标不能替换参考。');
        const selected=selectedBySlot.get(slot.slotId);
        if(!selected)throw new SocialProgramError('weekly_unique_benchmark_video_required',409,'每条母版需要不同的合格对标视频；现有候选不足，等待后续采集补齐。');
        const feedbackTopics = await Promise.all(slot.publicationTaskIds.flatMap(id => { const publication = feedbackPackage?.socialContentPackage?.publicationTasks?.find(p=>p.publicationTaskId===id); return publication?.customerFeedbackTopicRef ? [{publication,ref:publication.customerFeedbackTopicRef}] : []; }).map(({publication,ref})=>createCustomerFeedbackTopicService(dataStore).verifiedPlanningReference({tenantId:input.tenantId,programId:input.programId,pkg:feedbackPackage!,publicationTaskId:publication.publicationTaskId,ref})));
        const contentTemplateEvidence=await Promise.all(slot.publicationTaskIds.flatMap(id=>{const publication=feedbackPackage?.socialContentPackage?.publicationTasks?.find(p=>p.publicationTaskId===id);return publication?.contentTemplateBindingRef?[{publication,ref:publication.contentTemplateBindingRef}]:[];}).map(async({publication,ref})=>({publicationTaskId:publication.publicationTaskId,bindingRef:ref,structure:await readWeeklyTemplateStructure(dataStore,{tenantId:input.tenantId,programId:input.programId,packageId:current.packageId,packageVersion:current.packageVersion,publicationTaskId:publication.publicationTaskId},ref)})));
        const { video } = selected;
        const frozenHandoff = handoffs.items.filter(row => row.tenant_id === input.tenantId && row.record_hash === socialRequestHash(socialJson(row.payload)))
          .map(row => ({ row, handoff: socialJson(row.payload) as SocialInspirationHandoff }))
          .filter(({ row,handoff }) => handoff?.inspirationId === video.candidateId && handoff.source?.sourceUrl === video.sourceUrl&&(slot.referenceSource==='owned'||!input.eligibleVideoIds||row.record_hash===qualifiedHandoffHashes.get(video.candidateId))&&(!input.preserveOwnedReferences||slot.referenceSource!=='owned'||previousOwned?.frozenHandoffRefs?.some(ref=>ref.inspirationId===video.candidateId&&ref.version===String(handoff.version??handoff.analysisVersion)&&ref.recordHash===row.record_hash)))
          .sort((a,b) => Number(b.handoff.version ?? b.handoff.analysisVersion) - Number(a.handoff.version ?? a.handoff.analysisVersion))[0];
        if(slot.referenceSource!=='owned'&&input.eligibleVideoIds&&!frozenHandoff)throw new SocialProgramError('weekly_candidate_post_admission_required',409,'本轮正式参考交接已变化，不能冻结旧版或候选分析回执。');
        if(input.preserveOwnedReferences&&previousOwned?.frozenHandoffRefs?.length&&!frozenHandoff)throw new SocialProgramError('owned_reference_frozen_handoff_changed',409,'原参考分镜证据缺失，补指标不能换成新版本。');
        const accountTitle = 'evidenceRef' in selected ? selected.account.displayName : selected.account.title;
        const benchmarkVideoRef: VersionedSocialRef = { type: 'social_discovery_video', id: video.candidateId, version: video.evidenceVersion };
        const benchmarkAccountRef: VersionedSocialRef = 'evidenceRef' in selected ? { type: 'owned_social_account', id: selected.account.accountId, version: selected.account.version } : { type: 'social_benchmark_account', id: selected.account.candidateId, version: selected.account.evidenceVersion };
        const handoffRef = frozenHandoff ? { inspirationId: video.candidateId, version: String(frozenHandoff.handoff.version ?? frozenHandoff.handoff.analysisVersion), recordHash: frozenHandoff.row.record_hash } : null;
        const diagnosis = 'evidenceRef' in selected && current.referenceSourcePolicy ? diagnoseOwnedReference({ policy: current.referenceSourcePolicy, performance: selected.historicalPerformance, handoff: frozenHandoff?.handoff, handoffRef, now: input.now ?? new Date() }) : null;
        const materialScope = { packageId: current.packageId, packageVersion: current.packageVersion, slotId: slot.slotId };
        const materialConfiguration = handoffRef ? await latestMaterialEvidenceConfiguration(dataStore,{tenantId:input.tenantId,programId:input.programId,scope:materialScope,handoffRef}) : null;
        const materialEvidenceRequirements = classifyMaterialEvidence({ scope: materialScope, handoff: frozenHandoff?.handoff, handoffRef, configuration:materialConfiguration });
        const inheritedStyle = diagnosis?.tone ? [`开场结构：${diagnosis.tone.hookTypes.join('、')}`, `信息顺序：${diagnosis.tone.revealOrder.join('→')}`, `表达节奏：${diagnosis.tone.pacing}`, `行动引导位置：${diagnosis.tone.ctaPosition}`] : ['自有调性尚待真实分镜分析核验，不默认继承外部风格'];
        return {
          targetAccountPlaybooks,
          analysisId: stableId('director_analysis', { planningId: current.planningId, planningVersion: current.version + 1, slotId: slot.slotId, benchmarkVideoRef, benchmarkAccountRef }),
          slotId: slot.slotId,
          packageId: current.packageId,
          packageVersion: current.packageVersion,
          analyzedBy: 'director_agent',
          ...(contentTemplateEvidence.length?{contentTemplateEvidence}:{}),
          ...(feedbackTopics.length ? {customerFeedbackTopicRefs:feedbackTopics.map(topic=>({type:'customer_feedback_topic_confirmation',id:topic.confirmation.id,version:topic.confirmation.version})),customerFeedbackTopicEvidence:feedbackTopics.map(topic=>({publicationTaskId:topic.confirmation.target.publicationTaskId,confirmationRef:{type:'customer_feedback_topic_confirmation',id:topic.confirmation.id,version:1},candidateRef:{id:topic.candidate.id,version:1,recordHash:topic.candidate.recordHash},question:topic.candidate.source.question,topicAngle:topic.candidate.topicAngle}))} : {}),
          frozenHandoffRefs: handoffRef ? [handoffRef] : [],
          benchmarkAccountRefs: [benchmarkAccountRef],
          benchmarkVideoRefs: [benchmarkVideoRef],
          historicalPerformance: 'evidenceRef' in selected ? selected.historicalPerformance : null,
          ...(diagnosis ? { ownedReferenceDiagnosis: diagnosis } : {}),
          benchmarkEvidenceRefs: [video.evidenceRef, 'evidenceRef' in selected ? selected.evidenceRef : selected.account.evidenceRef,...feedbackTopics.map(topic=>`customer_feedback_topic:${topic.candidate.id}@${topic.candidate.recordHash}`)],
          contentDirection: (slot.referenceSource === 'owned' ? `以本账号 ${accountTitle} 的历史视频 ${video.title} 为参考，${diagnosis?.toneStatus === 'verified' ? '保留已核验的开场、信息顺序和表达节奏' : '调性尚待核验，不以外部风格替代'}，更新本次产品事实与表达。` : `按 ${accountTitle} 的更新节奏和内容方向，迁移 ${video.title} 的结构；必须替换产品事实、原素材和原台词。`) + (feedbackTopics.length ? `；真实客户问题：${feedbackTopics.map(topic=>topic.candidate.source.question).join('；')}；待验证选题方向：${feedbackTopics.map(topic=>topic.candidate.topicAngle).join('；')}（未形成获客归因）` : ''),
          styleRules: slot.referenceSource === 'owned' ? [...inheritedStyle, '使用企业已确认事实', '历史人物与品牌表达可沿用已核验边界；原画面、音乐和肖像须逐资产确认授权，不凭账号归属直接复用'] : ['保留前三秒信息结构', '使用企业已确认事实', '不得复用原视频画面、音乐或台词'],
          updateRhythm: slot.plannedPublishWindows.length ? slot.plannedPublishWindows.join('、') : '按本周账号配额均匀发布',
          materialRequirements: materialEvidenceRequirements.items.map(item => item.description),
          materialEvidenceRequirements,
          estimatedProductionMinutes: 180,
          createdAt: now,
        };
      }));
      const analyses:WeeklyDirectorPlanningAnalysis[]=[],directorGaps:WeeklyDirectorSlotGap[]=[];
      outcomes.forEach((outcome,index)=>{const slot=analysisSlots[index]!;if(outcome.status==='fulfilled'){analyses.push(outcome.value as WeeklyDirectorPlanningAnalysis);if(slot.referenceSource==='owned'&&!ownedDiagnosisReady(outcome.value as WeeklyDirectorPlanningAnalysis))directorGaps.push({slotId:slot.slotId,referenceSource:'owned',code:'owned_reference_diagnosis_pending',message:'自有播放、赞转评或调性分析尚未齐全，保留该条目缺口。',observedAt:now});}else{const error=outcome.reason;if(!(error instanceof SocialProgramError)&&!(error instanceof SocialContentWorkflowError))throw error;directorGaps.push({slotId:slot.slotId,referenceSource:slot.referenceSource??'unknown',code:error.code,message:error.message,observedAt:now});}});
      if(!analyses.length&&directorGaps.length&&!input.selectedSlotIds){const first=directorGaps[0]!;throw new SocialProgramError(first.referenceSource==='owned'&&!ownedPairs.length?'owned_reference_evidence_required':first.code,409,first.message);}
      analyses.push(...current.directorAnalyses.filter(a=>!analysisCoverage.selectedSlotIds.includes(a.slotId)));
      directorGaps.push(...(current.directorGaps??[]).filter(g=>!analysisCoverage.selectedSlotIds.includes(g.slotId)));
      for(const slot of current.skeleton.slots)if(!analyses.some(a=>a.slotId===slot.slotId)&&!directorGaps.some(g=>g.slotId===slot.slotId))directorGaps.push({slotId:slot.slotId,referenceSource:slot.referenceSource??'unknown',code:'director_slot_analysis_pending',message:'该独立视频仍需完成其原来源分析，不改为另一来源。',observedAt:now});
      return guardedAppend(input.tenantId, {
        ...current,
        version: current.version + 1,
        status: 'director_analyzing',
        directorAnalyses: analyses,
        directorGaps,
        detailedSchedule: null,
        userConfirmation: null,
        dispatch: null,
        updatedAt: now,
      });
    },

    async mergeDetailedSchedule(input: {
      tenantId: string;
      programId: string;
      package: WeeklyOperatingPackage;
      expectedPlanningVersion: number;
      actor: 'business_agent';
      selectedSlotIds?:string[];
      now?: Date;
    }): Promise<WeeklyAgentPlanningState> {
      if (input.actor !== 'business_agent') throw new SocialProgramError('business_schedule_authority_required', 403, '只有经营 Agent 可以生成详细内容排期。');
      const current = await this.get(input.tenantId, input.programId, input.package.packageId, input.package.version);
      requirePlanningVersion(current, input.expectedPlanningVersion);
      requireEditablePlanning(current);
      await verifyWeeklyPlanningPlaybooks(dataStore,input.tenantId,input.programId,current.directorAnalyses);
      const analysisBySlot = new Map(current.directorAnalyses.map(item => [item.slotId, item]));
      const coverage=selectWeeklyPlanningCoverage(current,input.selectedSlotIds);
      const selectedSlots=current.skeleton.slots.filter(slot=>coverage.selectedSlotIds.includes(slot.slotId));
      const missing = selectedSlots.filter(slot => !analysisBySlot.has(slot.slotId)||(slot.referenceSource==='owned'&&!ownedDiagnosisReady(analysisBySlot.get(slot.slotId)!))||current.directorGaps?.some(g=>g.slotId===slot.slotId));
      if (missing.length) throw new SocialProgramError('director_analysis_incomplete', 409, `仍有 ${missing.length} 个内容槽位缺少编导分析。`);
      const now = (input.now ?? new Date()).toISOString();
      const tasksById = new Map(input.package.socialContentPackage.publicationTasks.map(item => [item.publicationTaskId, item]));
      const items = selectedSlots.flatMap(slot => {
        const analysis = analysisBySlot.get(slot.slotId)!;
        return slot.publicationTaskIds.map(publicationTaskId => {
          const publication = tasksById.get(publicationTaskId);
          if (!publication) throw new SocialProgramError('publication_task_lineage_invalid', 409, '内容排期引用了不存在的发布任务。');
          return {
            scheduleItemId: stableId('detailed_schedule_item', { planningId: current.planningId, publicationTaskId }),
            slotId: slot.slotId,
            publicationTaskId,
            accountId: publication.accountId,
            platform: publication.platform,
            topic: analysis.customerFeedbackTopicEvidence?.find(e=>e.publicationTaskId===publicationTaskId&&e.confirmationRef.id===publication.customerFeedbackTopicRef?.id)?.topicAngle || publication.businessProposition || analysis.contentDirection,
            directorAnalysisRef: { type: 'weekly_director_analysis', id: analysis.analysisId, version: 1 },
            ...(analysis.targetAccountPlaybooks?.find(value=>value.accountId===publication.accountId)?{targetAccountPlaybook:structuredClone(analysis.targetAccountPlaybooks.find(value=>value.accountId===publication.accountId)!)}:{}),
            benchmarkAccountRefs: analysis.benchmarkAccountRefs,
            benchmarkVideoRefs: analysis.benchmarkVideoRefs,
            ...(publication.contentTemplateBindingRef?{contentTemplateStructure:structuredClone(analysis.contentTemplateEvidence?.find(e=>e.publicationTaskId===publication.publicationTaskId&&e.bindingRef.id===publication.contentTemplateBindingRef?.id)?.structure??(()=>{throw new SocialProgramError('content_template_analysis_required',409,'模板绑定缺少实际新周编导分析。');})())}:{}),
            materialRequirements: analysis.materialRequirements,
            materialEvidenceRequirements: analysis.materialEvidenceRequirements ? structuredClone(analysis.materialEvidenceRequirements) : undefined,
            materialPlan: {
              canStartWithExistingAssets: false,
              fallback: 'premium_aigc' as const,
              optionalShootTaskIds: [],
              note: '素材就绪由实际核验任务确认。必需企业实拍、产品事实和人物授权不能以 AIGC 默认替代；拍摄任务仅在真实创建后关联。',
            },
            publishWindow: publication.publishWindow || input.package.weekEnd,
            qualityTier: 'premium' as const,
            estimatedProductionMinutes: minutes(analysis.estimatedProductionMinutes),
          };
        });
      });
      const nextVersion = current.version + 1;
      return guardedAppend(input.tenantId, {
        ...current,
        version: nextVersion,
        status: 'awaiting_confirmation',
        detailedSchedule: {
          ref: { type: 'weekly_detailed_content_schedule', id: stableId('detailed_schedule', { planningId: current.planningId, version: nextVersion }), version: 1 },
          mergedBy: 'business_agent',
          coverage,
          items,
          createdAt: now,
        },
        userConfirmation: null,
        dispatch: null,
        updatedAt: now,
      });
    },

    async confirm(input: { tenantId: string; programId: string; packageId: string; packageVersion: number; expectedPlanningVersion: number; userId: string; selectedSlotIds?:string[]; now?: Date }): Promise<WeeklyAgentPlanningState> {
      const current = await this.get(input.tenantId, input.programId, input.packageId, input.packageVersion);
      requirePlanningVersion(current, input.expectedPlanningVersion);
      if (!current.detailedSchedule) throw new SocialProgramError('detailed_schedule_required', 409, '详细内容排期尚未生成。');
      await verifyWeeklyPlanningPlaybooks(dataStore,input.tenantId,input.programId,current.directorAnalyses);
      assertWeeklyDetailedCoverage(current);
      if(current.detailedSchedule.coverage)assertWeeklyPlanningCoverage(current,current.detailedSchedule.coverage,input.selectedSlotIds);
      if (current.status === 'confirmed' || current.status === 'dispatched') return current;
      const now = (input.now ?? new Date()).toISOString();
      return guardedAppend(input.tenantId, {
        ...current,
        version: current.version + 1,
        status: 'confirmed',
        userConfirmation: { confirmedBy: input.userId, confirmedAt: now,...(current.detailedSchedule.coverage?{selectedSlotIds:current.detailedSchedule.coverage.selectedSlotIds}:{}) },
        updatedAt: now,
      });
    },

    async confirmAutomaticTemplate(input:{tenantId:string;programId:string;packageId:string;packageVersion:number;expectedPlanningVersion:number;actorUserId:string;selectedSlotIds:string[];now?:Date}):Promise<WeeklyAgentPlanningState>{
      await assertWeeklyScheduleActor(dataStore,input);
      const row=await latestPackageRow(dataStore,input.tenantId,input.programId,input.packageId);
      if(!row||row.payload.version!==input.packageVersion||!['draft','active'].includes(row.payload.status)||await executionPackageFrozen(dataStore,input))throw new SocialProgramError('weekly_template_planning_scope_invalid',409,'原周包已变化，未自动采用新的范围。');
      const current=await this.get(input.tenantId,input.programId,input.packageId,input.packageVersion);
      requirePlanningVersion(current,input.expectedPlanningVersion);
      if(current.userConfirmation)throw new SocialProgramError('weekly_template_manual_confirmation_preserved',409,'已有人工范围确认，保留原记录。');
      if(current.automaticTemplateAdoption){verifiedWeeklyPlanningTemplateAdoption(current);return current;}
      if(current.status!=='awaiting_confirmation'||!current.detailedSchedule?.coverage)throw new SocialProgramError('weekly_template_real_analysis_required',409,'真实编导分析和详细排期尚未完成。');
      await verifyWeeklyPlanningPlaybooks(dataStore,input.tenantId,input.programId,current.directorAnalyses);
      assertWeeklyDetailedCoverage(current);assertWeeklyPlanningCoverage(current,current.detailedSchedule.coverage,input.selectedSlotIds);
      const adoption=await adoptWeeklyAutomationTemplate(dataStore,input,input.actorUserId);
      const payload={source:'automatic_template' as const,templateVersion:'weekly-automation.v3' as const,adoptedAt:(input.now??new Date()).toISOString(),actorUserId:input.actorUserId,userApproval:null,selectedSlotIds:[...input.selectedSlotIds],analysisEvidenceHash:weeklyPlanningAnalysisHash(current),detailedScheduleHash:socialRequestHash(current.detailedSchedule),authorizesPublishing:false as const,authorizesContentAcceptance:false as const,authorizesCustomerMessages:false as const};
      if(adoption.template.version!==payload.templateVersion)throw new SocialProgramError('weekly_template_version_conflict',409,'默认模板版本已变化。');
      const next={...current,version:current.version+1,status:'confirmed' as const,userConfirmation:null,automaticTemplateAdoption:{...payload,recordHash:socialRequestHash(payload)},updatedAt:payload.adoptedAt};
      verifiedWeeklyPlanningTemplateAdoption(next);return guardedAppend(input.tenantId,next);
    },

    async dispatch(input: { tenantId: string; programId: string; packageId: string; packageVersion: number; expectedPlanningVersion: number; actor: 'business_agent'; selectedSlotIds?:string[]; now?: Date }): Promise<WeeklyAgentPlanningState> {
      if (input.actor !== 'business_agent') throw new SocialProgramError('business_dispatch_authority_required', 403, '只有经营 Agent 可以向内容 Agent 派单。');
      const current = await this.get(input.tenantId, input.programId, input.packageId, input.packageVersion);
      requirePlanningVersion(current, input.expectedPlanningVersion);
      await verifyWeeklyPlanningPlaybooks(dataStore,input.tenantId,input.programId,current.directorAnalyses);
      assertWeeklyDetailedCoverage(current);
      if(current.detailedSchedule?.coverage){assertWeeklyPlanningCoverage(current,current.detailedSchedule.coverage,input.selectedSlotIds);if(current.userConfirmation&&JSON.stringify(current.userConfirmation.selectedSlotIds)!==JSON.stringify(current.detailedSchedule.coverage.selectedSlotIds))throw new SocialProgramError('weekly_partial_confirmation_changed',409,'确认的视频范围与详细排期不一致。');}
      if (current.dispatch) return current;
      const automaticAdoption=verifiedWeeklyPlanningTemplateAdoption(current);
      if(automaticAdoption&&JSON.stringify(weeklyPlanningExecutionSelection(current))!==JSON.stringify(current.detailedSchedule?.coverage?.selectedSlotIds))throw new SocialProgramError('weekly_template_dispatch_range_changed',409,'默认模板采用范围已变化。');
      if (current.status !== 'confirmed' || !current.detailedSchedule || (!current.userConfirmation&&!automaticAdoption)) {
        throw new SocialProgramError('confirmed_detailed_schedule_required', 409, '用户确认详细排期后才能派给内容 Agent。');
      }
      const now = (input.now ?? new Date()).toISOString();
      const dispatch: WeeklyBusinessContentDispatch = {
        dispatchId: `business_dispatch_${randomUUID()}`,
        packageId: current.packageId,
        packageVersion: current.packageVersion,
        issuedBy: 'business_agent',
        assignedTo: 'content_agent',
        detailedScheduleRef: current.detailedSchedule.ref,
        ...(current.detailedSchedule.coverage?{coverage:structuredClone(current.detailedSchedule.coverage)}:{}),
        scheduleItemIds: current.detailedSchedule.items.map(item => item.scheduleItemId),
        scheduleItems: structuredClone(current.detailedSchedule.items),
        issuedAt: now,
      };
      return guardedAppend(input.tenantId, {
        ...current,
        version: current.version + 1,
        status: 'dispatched',
        dispatch,
        updatedAt: now,
      });
    },
  };
}

export const WEEKLY_PLANNING_MUTATION_SCOPE = 'social_weekly_planning_mutation';

/** Database unique lease plus immutable, deterministic version IDs protect independent API processes. */
export function createWeeklyPlanningAuthority(dataStore: DataStore, testPorts?:DirectorTestPorts,
  exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun) {
  const verifiedTestPorts=checkedDirectorTestPorts(testPorts);
  const reader = unguardedPlanningAuthority(dataStore,undefined,verifiedTestPorts,exactAnalysisPortsForRun);
  async function mutate<T>(tenantId: string, programId: string, packageId: string, packageVersion: number, operation: (authority: ReturnType<typeof unguardedPlanningAuthority>) => Promise<T>): Promise<T> {
    const subjectId = createHash('sha256').update(JSON.stringify([programId, packageId, packageVersion])).digest('hex');
    const lease = await acquireDurableOperationLease({ dataStore, tenantId, scope: WEEKLY_PLANNING_MUTATION_SCOPE, subjectId, ownerId: `planning-${randomUUID()}`, leaseDurationMs: 120_000 });
    if (!lease) throw new SocialProgramError('weekly_agent_planning_version_conflict', 409, '本周计划正在被其他请求更新，请刷新后重试；已有计划已保留。');
    try {
      const authority = unguardedPlanningAuthority(dataStore, async () => {
        try { await assertDurableOperationLease({ dataStore, lease, minimumRemainingMs: 5_000 }); }
        catch (error) {
          if (error instanceof DurableOperationLeaseError) throw new SocialProgramError('weekly_agent_planning_lease_lost', 409, '本次规划写入租约已失效，请刷新后重试；已有计划已保留。');
          throw error;
        }
      },verifiedTestPorts,exactAnalysisPortsForRun);
      return await operation(authority);
    } finally { await releaseDurableOperationLease({ dataStore, lease }); }
  }
  return {
    get: reader.get,
    initialize: (tenantId: string, pkg: WeeklyOperatingPackage) => mutate(tenantId, pkg.programId, pkg.packageId, pkg.version, authority => authority.initialize(tenantId, pkg)),
    runDirectorAnalysis: (input: Parameters<typeof reader.runDirectorAnalysis>[0]) => mutate(input.tenantId, input.programId, input.packageId, input.packageVersion, authority => authority.runDirectorAnalysis(input)),
    pinDirectorReference: (input: Parameters<typeof reader.pinDirectorReference>[0]) => mutate(input.tenantId,input.programId,input.packageId,input.packageVersion,authority=>authority.pinDirectorReference(input)),
    mergeDetailedSchedule: (input: Parameters<typeof reader.mergeDetailedSchedule>[0]) => mutate(input.tenantId, input.programId, input.package.packageId, input.package.version, authority => authority.mergeDetailedSchedule(input)),
    confirm: (input: Parameters<typeof reader.confirm>[0]) => mutate(input.tenantId, input.programId, input.packageId, input.packageVersion, authority => authority.confirm(input)),
    confirmAutomaticTemplate: (input: Parameters<typeof reader.confirmAutomaticTemplate>[0]) => withExecutionPackageGate(dataStore,input,()=>mutate(input.tenantId,input.programId,input.packageId,input.packageVersion,authority=>authority.confirmAutomaticTemplate(input))),
    dispatch: (input: Parameters<typeof reader.dispatch>[0]) => mutate(input.tenantId, input.programId, input.packageId, input.packageVersion, authority => authority.dispatch(input)),
  };
}
