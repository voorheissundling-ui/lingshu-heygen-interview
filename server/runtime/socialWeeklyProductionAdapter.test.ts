import {buildWeeklySchedulerMaterialPlanProof} from '../starter198/socialWeeklySchedulerMaterialPlan.js';
import {readWeeklyReferenceSources} from './socialWeeklyReferenceSource.js';
import { classifyMaterialEvidence } from '../socialPrograms/materialEvidenceClassification.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataStore, Record_, ListQuery } from '../storage/datastore.js';
import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { createSocialWeeklyProductionAdapter, weeklyProductionBindingKey, weeklySourceBindingIdempotencyKey } from './socialWeeklyProductionAdapter.js';
function memory(): DataStore {
  const data = new Map<string, Record_[]>();
  return {
    async getById<T>(c: string, id: string) { return structuredClone(data.get(c)?.find(r => r.id === id) ?? null) as T | null; },
    async list<T>(c: string, q: ListQuery = {}) { const rows = (data.get(c) ?? []).filter(r => Object.entries(q.where ?? {}).every(([k,v]) => r[k] === v)); return { items: structuredClone(rows) as T[], totalItems: rows.length, totalPages: 1, page: 1, perPage: q.perPage ?? 30 }; },
    async create<T>(c: string, d: Record<string, unknown>) { const rows = data.get(c) ?? []; const row = { id: `${c}-${rows.length}`, ...structuredClone(d) }; data.set(c, [...rows, row]); return structuredClone(row) as T; },
    async update(c: string, id: string, d: Record<string, unknown>) { const row = data.get(c)?.find(r => r.id === id); if (!row) return false; Object.assign(row, structuredClone(d)); return true; },
    async delete(c: string, id: string) { data.set(c,(data.get(c) ?? []).filter(r => r.id !== id)); return true; },
  };
}
async function fixture() {
  const store = memory();
  const task = { tenantId:'tenant', programId:'program', packageId:'package', packageVersion:2, publicationTaskId:'publication', accountId:'account', workflowKind:'content', schedule:{stepKind:'script'} } as WeeklyExecutionTask;
  const pub = {metricTargets:['播放'],accountPositioning:'采购商',motherContentId:'mother', publicationTaskId:'publication', accountId:'account', businessProposition:'真实经营主张', cta:'了解产品', factRefs:[{type:'enterprise_fact',id:'fact',version:1}], platform:'tiktok' };
  const handoff:any={whySelected:['实际受控参考'],taskContext:{},reusableLogic:{hookTypes:[],revealOrder:[],proofPlacement:[],pacing:'简单',emotionalProgression:'清晰',ctaPosition:'结尾'},evidenceRefs:[],source:{sourceUrl:'https://example.test/safe-reference'},inspirationId:'safe-reference',version:'1',analysisVersion:'1',readiness:'production_reference',rights:{mayAnalyze:true,mayAdapt:true},productionImplications:{requiredEvidence:[],likelyAssetNeeds:['AI纯装饰非证据背景']},adaptationBoundary:{reusable:[],mustReplace:[],prohibited:[]}};
  const handoffRef={inspirationId:handoff.inspirationId,version:'1',recordHash:socialRequestHash(handoff)};
  const classification=classifyMaterialEvidence({scope:{packageId:'package',packageVersion:2,slotId:'slot'},handoff,handoffRef});
  await store.create('starter_social_inspiration_handoff_versions',{tenant_id:'tenant',handoff_version:'1',record_hash:handoffRef.recordHash,payload:handoff});
  const planning = { status:'dispatched', userConfirmation:{confirmedBy:'human'},directorAnalyses:[{analysisId:'classification-analysis',packageId:'package',packageVersion:2,slotId:'slot',benchmarkVideoRefs:[{type:'social_discovery_video',id:'safe-reference',version:1}],benchmarkAccountRefs:[{type:'social_benchmark_account',id:'https://www.tiktok.com/@unit_factory',version:1}],benchmarkEvidenceRefs:['safe-evidence'],frozenHandoffRefs:[handoffRef],materialEvidenceRequirements:classification}], dispatch:{packageId:'package',packageVersion:2, scheduleItems:[{slotId:'slot',directorAnalysisRef:{type:'weekly_director_analysis',id:'classification-analysis',version:1},publicationTaskId:'publication',accountId:'account',topic:'真实主题',materialRequirements:classification.items.map(i=>i.description),materialEvidenceRequirements:classification}]}};
  Object.assign(planning,{programId:'program',packageId:'package',packageVersion:2,skeleton:{packageId:'package',packageVersion:2,slots:[{slotId:'slot',publicationTaskIds:['publication']}]},detailedSchedule:{ref:{type:'weekly_detailed_schedule',id:'detail',version:1},items:planning.dispatch.scheduleItems}});Object.assign(planning.userConfirmation,{confirmedAt:'2026-10-09T00:00:00Z'});Object.assign(planning.dispatch,{detailedScheduleRef:{type:'weekly_detailed_schedule',id:'detail',version:1},scheduleItemIds:planning.dispatch.scheduleItems.map(()=> 'item')});Object.assign(planning.dispatch.scheduleItems[0]!,{scheduleItemId:'item'});
  const weeklyWorkflowTask={taskId:'weekly-content',kind:'content',subjectRefs:[{type:'weekly_publication_task',id:pub.publicationTaskId,version:2}],dependsOnTaskIds:[],ownBlockingReasons:[],inheritedBlockingTaskIds:[],status:'planned'};
  const businessGoal={goalId:'goal',programId:'program',version:1,status:'ready',objective:'真实产品说明',products:['产品'],markets:['US'],audiences:['采购商'],languages:['en'],publicFactRefs:pub.factRefs,prohibitedClaims:[],weeklyBudgetCny:10,blockers:[],inputRefs:[],conversionRouteIds:[],accountBoundaries:[],evidence:[]};
  const pkg = {successCriteria:['真实交付'],objective:'产品说明',weekEnd:'2026-10-11',workflowTasks:[weeklyWorkflowTask],businessContentGoalRef:{type:'business_content_goal',id:'goal',version:1},enterpriseProfileRef:{type:'enterprise_profile',id:'enterprise',version:1},agentPlanning:planning,packageId:'package',programId:'program',version:2,status:'draft',socialContentPackage:{publicationTasks:[pub],perItemBudgetCny:10,weeklyBudgetCny:10}};
  await store.create('social_weekly_operating_packages',{tenant_id:'tenant',program_id:'program',package_id:'package',version:2,payload:pkg});
  await store.create('social_weekly_agent_planning',{tenant_id:'tenant',program_id:'program',package_id:'package',package_version:2,planning_version:1,payload:planning});
  await store.create('trend_videos',{id:'safe-reference',tenantId:'tenant',sourceUrl:handoff.source.sourceUrl,title:'受控真实参考',platform:'tiktok',aiAnalysis:{analysisMode:'exact',analysisQuality:'video'}});
  await store.create('social_programs',{tenant_id:'tenant',program_id:'program',payload:{version:1}});
  await store.create('social_discovery_scopes',{tenant_id:'tenant',program_id:'program',status:'active',version:1,keyword_set_id:'unit-keywords',payload:{approval:{status:'approved',scopeVersion:1},keywordSet:{scope:{audienceRole:'brand_buyer'}},graph:{sceneClusters:[]}}});
  await store.create('social_tracked_accounts',{tenant_id:'tenant',accountId:'https://www.tiktok.com/@unit_factory',decision:'track',status:'tracked',accountRole:'brand_factory',reasons:['OEM factory wholesale supplier'],evidenceVideoIds:['safe-reference','unit-2','unit-3'],relatedSceneIds:[],missingEvidence:[],confidence:.95,businessConfirmation:{status:'confirmed',confirmedBy:'business_agent',decisionRef:'unit-decision',reason:null,confirmedAt:'2026-10-01T00:00:00Z'}});
  const authority={weeklyWorkflowTask,businessGoal,enterpriseProfileRef:pkg.enterpriseProfileRef,programRef:{type:'social_program',id:'program',version:1},weeklyPackage:{...pkg,agentPlanning:planning},publicationTask:pub,referenceSelection:{selectionId:'selection',version:1,status:'selected',upstreamTaskRef:'weekly-content',evidenceVersionRefs:['safe-evidence@1'],selected:[{candidateId:'safe-reference',evidenceId:'safe-evidence',evidenceVersion:1}]},selectedHandoffs:[handoff]};
  const references=await readWeeklyReferenceSources(store,'tenant',authority,planning.directorAnalyses[0]!);
  const sources=references.map(reference=>({sourceId:'frozen-reference',kind:'reference_link',status:'active',sourceRef:reference.sourceRef,sourceVersion:reference.sourceVersion}));
  const brief={title:'实际企业内容',objective:'真实产品说明',markets:['US'],languages:['en'],platforms:['tiktok'],formats:['short_video'],restrictions:[],requestedOutputCount:1,_weeklyAuthority:authority};
  await store.create('starter_social_content_tasks',{ tenant_id:'tenant',task_id:'content',version:'4',status:'producing',run_id:'run-existing',created_at:'2026-10-09T00:00:00Z',updated_at:'2026-10-09T00:00:00Z',create_idempotency_key:weeklyProductionBindingKey(task),brief,sources,package_selection:['industry_launch','content_rocket','task_express'].map(kind=>({kind,packageKey:kind,version:'1',name:kind})),source_count:1,knowledge_source_count:0,material_source_count:0,artifact_count:0,approved_artifact_count:0,delivery_package_count:0,publication_count:0,metric_submission_count:0 });
  await store.create('starter_social_task_sources',{tenant_id:'tenant',task_id:'content',source_id:'frozen-reference',source_kind:'reference_link',source_ref:references[0]!.sourceRef,source_version:references[0]!.sourceVersion,status:'active',created_at:'2026-10-09T00:00:00Z',label:'受控冻结参考'});
  let detail = { taskId:'content',version:'4',runId:'run-existing',status:'producing',brief,sources,readiness:{complete:true,missing:[]},artifacts:[] } as unknown as SocialContentTaskDetail;
  const repository=createStarter198Repository(store);
  const persisted=(await store.list<any>('starter_social_content_tasks')).items[0];
  const actual=await (await import('../starter198/socialContentRecords.js')).readSocialTaskDetail({repository,tenantId:'tenant',taskId:'content'});
  assert.ok(actual);
  assert.ok(actual.assetSupplyPlan);
  const proof=buildWeeklySchedulerMaterialPlanProof({tenantId:'tenant',taskId:'content',commandId:'controlled-scheduler',row:{...persisted,version:'3'},detail:{...actual,version:'3',runId:null,assetSupplyPlan:{...actual.assetSupplyPlan!,planVersion:'3'}},sources:actual.sources});
  assert.ok(proof,'actual canonical task must produce scheduler plan proof');
  await store.update('starter_social_content_tasks',persisted.id,{last_operation_id:'controlled-scheduler'});
  await store.create('workflow_runs',{id:'run-existing',tenant_id:'tenant',status:'running',starter_context:{schemaVersion:'starter-social-content.auto-execution.v1',socialTaskId:'content',socialTaskVersion:'3',sourceRefs:actual.sources.map(source=>({id:source.sourceId,version:source.sourceVersion})),packageSelection:actual.packageSelection,weeklyMaterialPlan:proof}});
  detail={...detail,assetSupplyPlan:actual.assetSupplyPlan};
  let starts = 0;
  const adapter = createSocialWeeklyProductionAdapter(store,{repository:createStarter198Repository(store),read:async()=>structuredClone(detail),start:async()=>{starts++;detail={...detail,runId:'run-new',status:'producing'};return detail;},persistResultAuthority:async()=>{}});
  return { store,task,pkg,planning,adapter,starts:()=>starts,sources,authority,brief,refreshAuthority:async(weeklyPackage:any,publication:any)=>{const row=(await store.list<any>('starter_social_content_tasks')).items[0];const nextBrief={...brief,_weeklyAuthority:{...authority,weeklyPackage,publicationTask:publication}};await store.update('starter_social_content_tasks',row.id,{brief:nextBrief});const current=await (await import('../starter198/socialContentRecords.js')).readSocialTaskDetail({repository,tenantId:'tenant',taskId:'content'});assert.ok(current);assert.ok(current.assetSupplyPlan);const next=buildWeeklySchedulerMaterialPlanProof({tenantId:'tenant',taskId:'content',commandId:'controlled-scheduler',row:{...row,brief:nextBrief,version:'3'},detail:{...current,version:'3',runId:null,assetSupplyPlan:{...current.assetSupplyPlan!,planVersion:'3'}},sources:current.sources});assert.ok(next);const run=await store.getById<any>('workflow_runs','run-existing');await store.update('workflow_runs','run-existing',{starter_context:{...run.starter_context,weeklyMaterialPlan:next}});detail={...detail,brief:{...current.brief,...nextBrief},assetSupplyPlan:current.assetSupplyPlan};},set:(value:Partial<SocialContentTaskDetail>)=>{detail={...detail,...value};} };
}

test('existing running identity is polled without starting another paid run; missing artifact never succeeds',async()=>{
  const f=await fixture();
  const actual=await f.adapter.execute(f.task);assert.equal(actual.status,'pending',JSON.stringify(actual));
  assert.equal((await f.adapter.execute(f.task)).status,'pending');
  assert.equal(f.starts(),0);
});
test('four platform nodes consume one real frozen original script without restarting production',async()=>{
 const f=await fixture(),{SOCIAL_SCRIPT_BASELINE_SCHEMA,SOCIAL_SCRIPT_GROUNDING_VERSION}=await import('../starter198/socialContentScriptBaseline.js'),{validateWeeklyExecutionResults}=await import('./socialWeeklyResultValidation.js');
 const pubs=['tiktok','facebook','instagram','youtube'].map((platform,index)=>({...f.pkg.socialContentPackage.publicationTasks[0]!,publicationTaskId:index?`publication-${index}`:'publication',platform,accountId:index?`account-${index}`:'account',adaptationOfPublicationTaskId:index?'publication':null}));
 const plan:any=structuredClone(f.planning);plan.skeleton.slots[0].publicationTaskIds=pubs.map(p=>p.publicationTaskId);plan.dispatch.scheduleItems=pubs.map((pub,index)=>({...plan.dispatch.scheduleItems[0],publicationTaskId:pub.publicationTaskId,accountId:pub.accountId,scheduleItemId:`item-${index}`}));plan.dispatch.scheduleItemIds=plan.dispatch.scheduleItems.map((item:any)=>item.scheduleItemId);plan.detailedSchedule.items=structuredClone(plan.dispatch.scheduleItems);
 const pkg:any={...f.pkg,agentPlanning:plan,socialContentPackage:{...f.pkg.socialContentPackage,productionIdentityVersion:'shared-original.v1',publicationTasks:pubs}};
 const packageRow=(await f.store.list('social_weekly_operating_packages')).items[0]!,planningRow=(await f.store.list('social_weekly_agent_planning')).items[0]!,content=(await f.store.list('starter_social_content_tasks')).items[0]!;
 await f.store.update('social_weekly_operating_packages',packageRow.id,{payload:pkg});await f.store.update('social_weekly_agent_planning',planningRow.id,{payload:plan});
 const baseline={schemaVersion:SOCIAL_SCRIPT_BASELINE_SCHEMA,version:'2',source:'inspiration_script',language:'zh',lockedAt:'2026-10-01T00:00:00Z',createdBeforeMaterialAdaptation:true,groundingVersion:SOCIAL_SCRIPT_GROUNDING_VERSION,match:{strategy:'inspiration',confidence:.9,inspirationReference:{recordId:'safe-reference',confidence:.9},verifiedKnowledgeSource:'enterprise_profile',verifiedFactKeys:['fact'],userTextUsage:'intent_only'},scenes:[{sceneId:'scene',shotFunction:'value',subject:'产品',action:'展示',script:'真实事实',voiceover:'真实事实',caption:'真实事实',narration:'真实事实'}]};
 await f.store.update('starter_social_content_tasks',content.id,{brief:{...f.brief,programRef:{id:'program'},_weeklyAuthority:{...f.authority,weeklyPackage:pkg,publicationTask:pubs[0]}},script_baseline:baseline});
 const ref={type:'starter_social_content_script_baseline',id:'content',version:2};const original={...f.task,taskId:'original-script',status:'succeeded',resultRefs:[ref]} as WeeklyExecutionTask;
 await f.store.create('social_weekly_execution_tasks',{tenant_id:'tenant',program_id:'program',package_id:'package',package_version:2,task_id:original.taskId,payload:original});
 for(const pub of pubs.slice(1)){const task={...f.task,taskId:`script-${pub.platform}`,publicationTaskId:pub.publicationTaskId,accountId:pub.accountId} as WeeklyExecutionTask;const result=await f.adapter.execute(task);assert.equal(result.status,'succeeded',JSON.stringify(result));if(result.status==='succeeded')await validateWeeklyExecutionResults(f.store,task,result.resultRefs);}
 assert.equal((await f.store.list('starter_social_content_tasks')).totalItems,1);assert.equal(f.starts(),0);assert.equal((await f.store.list('social_weekly_content_distribution_bindings')).totalItems,4);
 const alias={...f.task,taskId:'alias',publicationTaskId:pubs[1]!.publicationTaskId,accountId:pubs[1]!.accountId} as WeeklyExecutionTask;
 await assert.rejects(validateWeeklyExecutionResults(f.store,alias,[{...ref,version:3}]));
});
test('adopted per-video template refuses an existing over-cap production instead of restarting it',async()=>{
 const f=await fixture();const {adoptWeeklyAutomationTemplate}=await import('../socialPrograms/weeklyAutomationTemplate.js');
 await adoptWeeklyAutomationTemplate(f.store,f.task,'owner');f.set({brief:{...f.brief,productRef:null,audience:null,aspectRatio:null,cadence:null,dueAt:null,brandNotes:null,callToAction:'Contact us',perItemBudgetCny:10.01}});
 const result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');assert.equal(result.status==='blocked'?result.code:'','weekly_existing_production_budget_exceeds_template');
 if(result.status==='blocked')assert.match(result.message,/10元.*增加预算或采用降级方案/);
 assert.equal(f.starts(),0);
});
test('adopted per-video template admits the exact ten-yuan boundary without another budget confirmation',async()=>{
 const f=await fixture();const {adoptWeeklyAutomationTemplate}=await import('../socialPrograms/weeklyAutomationTemplate.js');
 await adoptWeeklyAutomationTemplate(f.store,f.task,'owner');f.set({brief:{...f.brief,perItemBudgetCny:10} as any});
 const result=await f.adapter.execute(f.task);
 assert.notEqual(result.status==='blocked'?result.code:'','weekly_existing_production_budget_exceeds_template');
});
test('legacy generic readiness cannot prove frozen material admission even with a running identity',async()=>{
  const f=await fixture();f.task.schedule.stepKind='material_readiness';
  const legacy=await f.adapter.execute(f.task);
  assert.equal(legacy.status,'blocked');assert.equal('code' in legacy?legacy.code:null,'weekly_material_contract_required');
  f.set({runId:null,status:'attention'});
  assert.equal((await f.adapter.execute(f.task)).status,'blocked');
});
test('dispatch and same-account authorization gates cannot be bypassed',async()=>{
  const f=await fixture();f.task.accountId='other';assert.equal((await f.adapter.execute(f.task)).status,'blocked');
  f.task.accountId='account';
  const row=(await f.store.list<any>('social_weekly_agent_planning')).items[0];
  await f.store.update('social_weekly_agent_planning',row.id,{payload:{...f.planning,userConfirmation:null}});
  assert.equal((await f.adapter.execute(f.task)).status,'blocked');
});
test('mandatory materials block weekly production even when generic readiness passes, and resume the original identity after verification',async()=>{
  const f=await fixture();
  f.task.schedule.stepKind='material_readiness';
  f.set({materialReadiness:{complete:false,requiredCount:1,satisfiedRequiredCount:0,blockingRequirementIds:['product-real-shot']}});
  let result=await f.adapter.execute(f.task);
  assert.equal(result.status,'blocked');
  assert.equal('code' in result ? result.code : null,'weekly_required_materials_missing');
  assert.equal(f.starts(),0);
  assert.equal(result.status === 'blocked' ? result.progress?.contentTaskId : undefined, 'content');
  f.set({runId:null,status:'draft'});
  result=await f.adapter.execute(f.task);
  assert.equal(result.status,'blocked');
  assert.equal(f.starts(),0,'a mock lifecycle drift cannot start a replacement run');
  assert.equal(f.starts(),0);
  f.set({runId:'run-existing',status:'producing'});
  f.set({materialReadiness:{complete:true,requiredCount:1,satisfiedRequiredCount:1,blockingRequirementIds:[]}});
  result=await f.adapter.execute(f.task);
  assert.equal(result.status,'blocked');assert.equal('code' in result?result.code:null,'weekly_material_contract_required');
  assert.equal(f.starts(),0);
});
test('an unpersisted artifact summary cannot prove generated output or creative quality',async()=>{
  const f=await fixture();
  const artifact:any={artifactId:'artifact',taskId:'content',version:'1',kind:'short_video',origin:'agent',resourceRef:'socialfile:file',status:'review_required',content:{render:{completed:true,selectedAssetIds:['asset']},scriptBaseline:{scenes:[{script:'真实脚本'}]},directorPlan:{sceneCount:1},productionResult:{technicalReview:{approved:true},creativeReview:{approved:false}}}};
  f.set({status:'asset_review',artifacts:[artifact]});
  f.task.schedule.stepKind='asset_generation';
  const rejected=await f.adapter.execute(f.task);assert.equal(rejected.status,'blocked');assert.equal('code'in rejected?rejected.code:null,'weekly_execution_result_unverified');
  for (const stepKind of ['script', 'storyboard'] as const) {
    f.task.schedule.stepKind=stepKind;
    assert.equal((await f.adapter.execute(f.task)).status,'pending','artifact summaries cannot replace a locked handoff');
  }
  for (const stepKind of ['quality_check','rework'] as const) {
    f.task.schedule.stepKind=stepKind;
    assert.equal((await f.adapter.execute(f.task)).status,'blocked');
  }
  artifact.content.productionResult.creativeReview.approved=true;f.set({artifacts:[artifact]});
  f.task.schedule.stepKind='quality_check';
  const reviewed=await f.adapter.execute(f.task);assert.equal(reviewed.status,'blocked');assert.equal('code'in reviewed?reviewed.code:null,'weekly_execution_result_unverified');
  assert.equal(f.starts(),0,'summary review changes must not restart paid production');
  artifact.status='superseded';f.set({artifacts:[artifact]});
  assert.equal((await f.adapter.execute(f.task)).status,'blocked','superseded summaries cannot supply review evidence');
});
test('current quality and conditional rework cards consume only the exact upstream artifact',async()=>{
  const f=await fixture();
  Object.assign(f.pkg,{executionGraphVersion:2});
  const packageRow=(await f.store.list<any>('social_weekly_operating_packages')).items[0]!;
  await f.store.update('social_weekly_operating_packages',packageRow.id,{payload:f.pkg});
  const expected:any={artifactId:'expected-child',taskId:'content',version:'1',kind:'short_video',origin:'agent',resourceRef:'socialfile:expected',status:'review_required',createdAt:'2026-10-09T00:00:00Z',content:{render:{completed:true},productionResult:{technicalReview:{approved:true},creativeReview:{approved:true}}}};
  const sibling:any={...expected,artifactId:'newer-sibling',resourceRef:'socialfile:sibling',createdAt:'2026-10-10T00:00:00Z'};
  f.set({status:'asset_review',artifacts:[expected,sibling]});
  f.task.dependsOnTaskIds=['video-task'];f.task.schedule.stepKind='quality_check';
  await f.store.create('social_weekly_execution_tasks',{tenant_id:'tenant',task_id:'video-task',payload:{...f.task,taskId:'video-task',status:'succeeded',resultRefs:[{type:'starter_social_content_artifact',id:'expected-child',version:1}]}});
  const exact=await f.adapter.execute(f.task);
  assert.notEqual(exact.status,'succeeded','fixture lacks exact persisted quality evidence, but must not accept the newer sibling');
  if(exact.status==='blocked')assert.notEqual(exact.code,'weekly_production_pinned_artifact_missing');
  expected.status='changes_requested';f.set({artifacts:[expected,sibling]});
  const rejected=await f.adapter.execute(f.task);assert.equal(rejected.status,'blocked');
  if(rejected.status==='blocked')assert.equal(rejected.code,'weekly_production_pinned_artifact_missing');
  f.task.dependsOnTaskIds=[];f.set({artifacts:[sibling]});
  const missing=await f.adapter.execute(f.task);assert.equal(missing.status,'blocked');
  if(missing.status==='blocked')assert.equal(missing.code,'weekly_production_quality_artifact_required');
});
test('paused production preserves progress and awaits user action without restarting',async()=>{
  const f=await fixture();f.set({status:'attention',productionProgress:{step:'provider_reconciliation',activity:'供应商回执未知，需对账',estimatedRemainingSeconds:0,updatedAt:new Date().toISOString()}});
  const result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');
  assert.equal(f.starts(),0);
});

test('authoritative production binding freezes real analyzed evidence and rejects changed frozen evidence',async()=>{
  const { bindWeeklyProductionAuthority } = await import('./socialWeeklyProductionAuthority.js');
  const { createSocialAssetSupplyPlan } = await import('../../shared/socialContentAssetSupply.js');
  const { socialRequestHash } = await import('../starter198/socialContentValidation.js');
  const f=await fixture();
  const fact={type:'enterprise_fact',id:'fact',version:1};
  const publication:any={...f.pkg.socialContentPackage.publicationTasks[0],motherContentId:'mother',adaptationOfPublicationTaskId:null,accountPositioning:'采购',metricTargets:['询盘'],publishWindow:'2026-10-08',factRefs:[fact]};
  const weeklyWorkflowTask:any={taskId:'weekly-content',kind:'content',taskRef:{type:'weekly_workflow_task',id:'weekly-content',version:2},subjectRefs:[{type:'weekly_publication_task',id:'publication',version:2}],dependsOnTaskIds:[],ownBlockingReasons:[],inheritedBlockingTaskIds:[],status:'planned'};
  const analysis={analysisId:'analysis',benchmarkVideoRefs:[{type:'social_discovery_video',id:'candidate',version:3}],benchmarkEvidenceRefs:['evidence'],benchmarkAccountRefs:[]};
  const pkg:any={...f.pkg,enterpriseProfileRef:{type:'enterprise_profile',id:'enterprise',version:1},businessContentGoalRef:{type:'business_content_goal',id:'goal',version:1},workflowTasks:[weeklyWorkflowTask],successCriteria:['询盘'],weekEnd:'2026-10-11',socialContentPackage:{...f.pkg.socialContentPackage,publicationTasks:[publication],originalContentTarget:1,adaptationVersionTarget:0,publicationTaskTarget:1},agentPlanning:{...f.planning,directorAnalyses:[analysis],dispatch:{...f.planning.dispatch,issuedAt:'2026-10-07T00:00:00Z',scheduleItems:[{...f.planning.dispatch.scheduleItems[0],directorAnalysisRef:{type:'weekly_director_analysis',id:'analysis',version:1}}]}}};
  const goal={goalId:'goal',programId:'program',version:1,status:'ready',objective:'获得询盘',products:['产品'],markets:['US'],audiences:['采购商'],languages:['zh'],publicFactRefs:[fact],prohibitedClaims:[],weeklyBudgetCny:10,blockers:[],inputRefs:[],conversionRouteIds:[],accountBoundaries:[],evidence:[]};
  await f.store.create('social_business_content_goals',{tenant_id:'tenant',program_id:'program',goal_id:'goal',version:1,payload:goal});
  await f.store.update('social_programs',(await f.store.list<any>('social_programs')).items[0].id,{payload:{version:4}});
  await f.store.create('social_candidate_evidence',{tenant_id:'tenant',tenantId:'tenant',candidateId:'candidate',evidenceId:'evidence',version:3,g1:{sourceUrl:'https://example.com/reference'},evidence:{qualityScore:{dimensions:{relevance:90,transferability:80}}}});
  const handoff:any={inspirationId:'candidate',analysisId:'real-analysis',analysisVersion:'3',version:'3',readiness:'production_reference',source:{platform:'tiktok',sourceUrl:'https://example.com/reference'},taskContext:{},whySelected:['观察到的结构'],referenceRole:'primary_structure',reusableLogic:{hookTypes:[],revealOrder:[],proofPlacement:[],pacing:'',emotionalProgression:'',ctaPosition:''},adaptationBoundary:{reusable:[],mustReplace:[],prohibited:[]},productionImplications:{requiredEvidence:[],likelyAssetNeeds:[],risks:[]},evidenceRefs:[{description:'真实观测',confidence:0.9,needsReview:false}],rights:{mayAnalyze:true,mayUseOriginalMedia:false,mayAdapt:true}};
  await f.store.create('starter_social_inspiration_handoff_versions',{tenant_id:'tenant',handoff_id:'candidate',handoff_version:'3',payload:handoff,record_hash:socialRequestHash(handoff)});
  const brief:any={title:'采购内容',objective:'获得询盘',productRef:'产品',audience:'采购',markets:['US'],languages:['zh'],platforms:['tiktok'],formats:['short_video'],aspectRatio:'9:16',cadence:null,requestedOutputCount:1,weeklyBudgetCny:10,perItemBudgetCny:10,retryReserveCny:null,planningMode:'auto_adjust',shootingWindowMinutes:0,specialRequirements:null,dueAt:null,brandNotes:null,restrictions:[],callToAction:'询盘',creationMode:'material_processing',assetAvailability:'none',managementMode:'one_click_managed',productionMode:'social_ready'};
  const detail:any={taskId:'content',version:'1',status:'plan_review',brief,sources:[],assetSupplyPlan:createSocialAssetSupplyPlan({creationMode:'material_processing',planVersion:'1',confirmedFactRefs:['enterprise_fact:fact@1'],shots:[{shotId:'scene-1',function:'value',requestedDescription:'真实内容'}]}),referenceVideoAnalysis:null,replicationScript:null};
  const repository=createStarter198Repository(f.store);
  const result=await bindWeeklyProductionAuthority({dataStore:f.store,repository,tenantId:'tenant',pkg,publication,detail});
  assert.equal(result.referenceSelection.selected[0].evidenceVersion,3);
  const replay=await bindWeeklyProductionAuthority({dataStore:f.store,repository,tenantId:'tenant',pkg,publication,detail});
  assert.equal(replay.referenceSelection.selectionId,result.referenceSelection.selectionId);
  assert.equal((await f.store.list('starter_social_content_lineage')).totalItems,1);
  assert.equal((await f.store.list('starter_social_director_brief_versions')).totalItems,1);
  pkg.agentPlanning.directorAnalyses[0].frozenHandoffRefs=[{inspirationId:'candidate',version:'3',recordHash:socialRequestHash(handoff)}];
  const newer={...handoff,version:'4',analysisVersion:'4',source:{...handoff.source,sourceUrl:'https://example.com/changed-reference'}};
  await f.store.create('starter_social_inspiration_handoff_versions',{tenant_id:'tenant',handoff_id:'candidate',handoff_version:'4',payload:newer,record_hash:socialRequestHash(newer)});
  const frozen=await bindWeeklyProductionAuthority({dataStore:f.store,repository,tenantId:'tenant',pkg,publication,detail});
  assert.equal(frozen.referenceSelection.selectionId,result.referenceSelection.selectionId,'a newer handoff cannot replace the user-confirmed frozen source');
  pkg.agentPlanning.directorAnalyses[0].frozenHandoffRefs=[{inspirationId:'candidate',version:'3',recordHash:'changed-hash'}];
  await assert.rejects(()=>bindWeeklyProductionAuthority({dataStore:f.store,repository,tenantId:'tenant',pkg,publication,detail}),/weekly_production_analyzed_handoff_required/);
  pkg.agentPlanning.directorAnalyses[0].frozenHandoffRefs=[{inspirationId:'candidate',version:'3',recordHash:socialRequestHash(handoff)}];
  const candidate=(await f.store.list<any>('social_candidate_evidence')).items[0];await f.store.update('social_candidate_evidence',candidate.id,{version:4});
  await assert.rejects(()=>bindWeeklyProductionAuthority({dataStore:f.store,repository,tenantId:'tenant',pkg,publication,detail}),/weekly_production_analyzed_handoff_required/);
});


test('observed production progress is returned while artifacts remain pending, never as completion', async () => {
  const f = await fixture();
  f.set({ productionProgress: { step: 'content_production', activity: '正在合成真实素材', estimatedRemainingSeconds: 90, updatedAt: '2026-10-07T00:00:00Z' } });
  const result = await f.adapter.execute(f.task);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.status === 'pending' ? result.progress : null, { contentTaskId: 'content', runId: 'run-existing', step: 'content_production', activity: '正在合成真实素材', updatedAt: '2026-10-07T00:00:00Z' });
  assert.equal('resultRefs' in result, false);
  assert.equal(f.starts(), 0);
});

async function requiredMaterialFixture() {
 const f=await fixture();
 const pkg:any=structuredClone(f.pkg);pkg.socialContentPackage.publicationTasks[0].materialRequirement={required:true,requestIds:['human-request']};
 const packageRow=(await f.store.list<any>('social_weekly_operating_packages')).items[0];await f.store.update('social_weekly_operating_packages',packageRow.id,{payload:pkg});
 const consumer:any={...f.task,taskId:'real-material-consumer',scope:'content',status:'queued',schedule:{stepKind:'material_readiness'}};
 await f.store.create('social_weekly_execution_tasks',{tenant_id:f.task.tenantId,program_id:f.task.programId,package_id:f.task.packageId,package_version:f.task.packageVersion,task_id:consumer.taskId,payload:consumer});
 let detail:any={taskId:'content',version:'4',runId:null,status:'draft',brief:f.brief,readiness:{complete:true,missing:[]},sources:structuredClone(f.sources),artifacts:[]};
 let starts=0,adds=0;let verified=true;let rawHash='a'.repeat(64);
 const sourceRef=`socialmaterial:${Buffer.from('pb-material0000001').toString('base64url')}`;
 const option:any={kind:'material',sourceRef,sourceVersion:'actual-library-revision-7',label:'真实企业素材'};
 const adapter=createSocialWeeklyProductionAdapter(f.store,{repository:createStarter198Repository(f.store),read:async()=>structuredClone(detail),persistResultAuthority:async()=>{},materialAdmission:async input=>{assert.equal(input.consumerTaskId,'real-material-consumer');return verified?{status:'ready',materials:[{recordId:'material0000001',sha256:'a'.repeat(64),type:'image',byteSize:12}],verifiedRequestRefs:[{requestId:'human-request',submissionVersion:1}],gaps:[]}:{status:'blocked',materials:[],verifiedRequestRefs:[],gaps:[{requestId:'human-request',code:'pending_verification'}]};},materialRecord:async()=>({id:'material0000001',tenantId:'tenant',scope:'own',sha256:rawHash}),sourceOptions:{list:async()=>({items:[option],page:1,perPage:1,totalItems:1,totalPages:1,status:'ready'}),resolve:async()=>option},addSource:async input=>{adds++;assert.equal(detail.runId,null);assert.equal(input.value.sourceVersion,'actual-library-revision-7','persist actual option version, not merely review hash');detail={...detail,version:'5',sources:[...f.sources,{sourceId:'bound-material',taskId:'content',kind:'material',sourceRef:input.value.sourceRef,sourceVersion:input.value.sourceVersion,status:'active'}]};return {source:detail.sources[0],task:detail};},start:async input=>{starts++;assert.equal(adds,1,'canonical source must bind before any paid start');assert.equal(input.expectedVersion,'5');detail={...detail,runId:'run-material',status:'producing'};return detail;}});
 return {...f,adapter,sourceRef,starts:()=>starts,adds:()=>adds,setDetail:(value:any)=>{detail={...detail,...value};},setVerified:(value:boolean)=>{verified=value;},setRawHash:(value:string)=>{rawHash=value;}};
}
test('frozen required material blocks paid admission until checked, then canonical option version binds before start exactly once',async()=> {
 const f=await requiredMaterialFixture();f.setVerified(false);let result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');assert.equal(f.starts(),0);assert.equal(f.adds(),0);
 f.setVerified(true);result=await f.adapter.execute(f.task);assert.equal(result.status,'pending');assert.equal(f.adds(),1);assert.equal(f.starts(),1);
 await f.adapter.execute(f.task);assert.equal(f.adds(),1);assert.equal(f.starts(),1,'polling preserves original paid run');
});
test('running production never edits a missing frozen source; drift blocks without replacement or restart',async()=> {
 const f=await requiredMaterialFixture();f.setDetail({runId:'existing-run',status:'producing'});
 let result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');assert.equal('code' in result?result.code:null,'weekly_running_material_binding_change_required');assert.equal(f.adds(),0);assert.equal(f.starts(),0);
 f.setDetail({sources:[...f.sources,{kind:'material',sourceRef:f.sourceRef,sourceVersion:'actual-library-revision-7',status:'active'}]});f.setRawHash('b'.repeat(64));
 result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');assert.equal('code' in result?result.code:null,'weekly_material_source_revision_invalid');assert.equal(f.adds(),0);assert.equal(f.starts(),0);
});
test('frozen material consumer lookup rejects a wrong package identity without invoking production',async()=> {
 const f=await requiredMaterialFixture();const row=(await f.store.list<any>('social_weekly_execution_tasks')).items[0];await f.store.update('social_weekly_execution_tasks',row.id,{payload:{...row.payload,packageVersion:999}});
 const result=await f.adapter.execute(f.task);assert.equal(result.status,'blocked');assert.equal('code' in result?result.code:null,'weekly_material_consumer_identity_invalid');assert.equal(f.adds(),0);assert.equal(f.starts(),0);
});

test('AI-only legacy production keeps its existing source readiness admission without a fabricated human request',async()=> {
 const f=await fixture();f.set({runId:null,status:'draft'});
 const result=await f.adapter.execute(f.task);assert.equal(result.status,'pending');assert.equal(f.starts(),1);
});

test('weekly source binding keys isolate different target tasks while preserving compatible legacy replay',async()=> {
 const store=memory(),repository=createStarter198Repository(store),legacyKey='weekly-reference:shared-version';
 assert.equal(await weeklySourceBindingIdempotencyKey({repository,tenantId:'tenant',taskId:'content-a',legacyKey}),`${legacyKey}:task:content-a`);
 await store.create('starter_social_content_operations',{tenant_id:'tenant',idempotency_key:legacyKey,operation:'add_social_task_source',target_id:'content-a'});
 assert.equal(await weeklySourceBindingIdempotencyKey({repository,tenantId:'tenant',taskId:'content-a',legacyKey}),legacyKey,'the original target keeps its persisted replay key');
 assert.equal(await weeklySourceBindingIdempotencyKey({repository,tenantId:'tenant',taskId:'content-b',legacyKey}),`${legacyKey}:task:content-b`,'another target receives an isolated key for the same source version');
});

test('legacy keys from another operation are never adopted as source replay authority',async()=> {
 const store=memory(),repository=createStarter198Repository(store),legacyKey='weekly-material:shared-input';
 await store.create('starter_social_content_operations',{tenant_id:'tenant',idempotency_key:legacyKey,operation:'start_social_content_task',target_id:'content-a'});
 assert.equal(await weeklySourceBindingIdempotencyKey({repository,tenantId:'tenant',taskId:'content-a',legacyKey}),`${legacyKey}:task:content-a`);
});
test('indispensable customer evidence promise blocks before paid start even with a safe automatic plan', async () => {
 const {createSocialAssetSupplyPlan}=await import('../../shared/socialContentAssetSupply.js');
 const f=await fixture();
 f.set({runId:null,status:'draft',assetSupplyPlan:createSocialAssetSupplyPlan({creationMode:'material_processing',planVersion:'4',confirmedFactRefs:['enterprise_fact:fact@1'],shots:[{shotId:'fact',function:'proof',requestedDescription:'已确认事实图形卡片'}]})});
 const contentRow=(await f.store.list<any>('starter_social_content_tasks')).items[0];
 await f.store.update('starter_social_content_tasks',contentRow.id,{material_requirements:[]});
 const planningRow=(await f.store.list<any>('social_weekly_agent_planning')).items[0];
 const planning={...structuredClone(f.planning),dispatch:{...f.planning.dispatch,scheduleItems:f.planning.dispatch.scheduleItems.map(item=>({...item,materialRequirements:['不可替代的工厂/产品真实性证据']}))}};(planning as any).detailedSchedule.items=structuredClone(planning.dispatch.scheduleItems);
 await f.store.update('social_weekly_agent_planning',planningRow.id,{payload:planning});
 const result=await f.adapter.execute(f.task);
 assert.equal(result.status,'blocked');
 assert.equal('code' in result?result.code:null,'weekly_material_classification_lineage_invalid');
 assert.equal(f.starts(),0);
 const stored=(await f.store.list<any>('starter_social_content_tasks')).items[0];
 assert.equal(stored.brief._weeklyMaterialDemand,undefined,'automatic visual plan must not overwrite a frozen customer evidence promise');
});
test('real existing source mutation persists the resolved library revision and still respects remaining content input gates',async()=> {
 const f=await requiredMaterialFixture();
 const row=(await f.store.list<any>('starter_social_content_tasks')).items[0];
 await f.store.update('starter_social_content_tasks',row.id,{status:'draft',version:'4',created_at:'2026-10-09T00:00:00Z',updated_at:'2026-10-09T00:00:00Z',brief:{title:'真实企业产品',objective:'采购询盘',productRef:'产品',audience:'采购商',markets:['US'],languages:['zh'],platforms:['tiktok'],formats:['short_video'],requestedOutputCount:1,creationMode:'material_processing',managementMode:'one_click_managed',productionMode:'social_ready',_weeklyAuthority:f.authority},source_count:1,knowledge_source_count:0,material_source_count:0,artifact_count:0,approved_artifact_count:0,delivery_package_count:0,publication_count:0,metric_submission_count:0});
 const option:any={kind:'material',sourceRef:f.sourceRef,sourceVersion:'actual-revision-9',label:'企业产品素材'};let starts=0;
 const adapter=createSocialWeeklyProductionAdapter(f.store,{repository:createStarter198Repository(f.store),read:async()=>({taskId:'content',version:'4',runId:null,status:'draft',brief:f.brief,readiness:{complete:true,missing:[]},sources:structuredClone(f.sources),artifacts:[]} as any),persistResultAuthority:async()=>{},materialAdmission:async()=>({status:'ready',materials:[{recordId:'material0000001',sha256:'a'.repeat(64),type:'image',byteSize:12}],verifiedRequestRefs:[{requestId:'human-request',submissionVersion:1}],gaps:[]}),materialRecord:async()=>({id:'material0000001',tenantId:'tenant',scope:'own',sha256:'a'.repeat(64)}),sourceOptions:{list:async()=>({items:[option],page:1,perPage:1,totalItems:1,totalPages:1,status:'ready'}),resolve:async()=>option},start:async()=>{starts++;throw Error('must not start incomplete actual content');}});
 const result=await adapter.execute(f.task);
 const sources=(await f.store.list<any>('starter_social_task_sources')).items.filter(source=>source.source_kind==='material');
 assert.equal(sources.length,1,JSON.stringify(result));assert.equal(sources[0].source_ref,f.sourceRef);assert.equal(sources[0].source_version,'actual-revision-9');assert.equal(starts,0,'real source mutation rechecks knowledge readiness, not mocked initial readiness');
});

test('AI-only material plans without physical reference analysis evidence cannot start paid production',async()=> {
 const {createSocialAssetSupplyPlan}=await import('../../shared/socialContentAssetSupply.js');
 const f=await fixture();f.task.schedule.stepKind='material_readiness';f.set({runId:null,status:'draft',assetSupplyPlan:createSocialAssetSupplyPlan({creationMode:'material_processing',planVersion:'4',confirmedFactRefs:['enterprise_fact:fact@1'],shots:[{shotId:'fact',function:'proof',requestedDescription:'已确认事实图形卡片'},{shotId:'transition',function:'transition',requestedDescription:'非证据动画'}]})});
 const row=(await f.store.list<any>('starter_social_content_tasks')).items[0];await f.store.update('starter_social_content_tasks',row.id,{material_requirements:[]});
 for(let attempt=0;attempt<2;attempt++){const rejected=await f.adapter.execute(f.task);assert.equal(rejected.status,'blocked');assert.equal('code'in rejected?rejected.code:null,'weekly_reference_source_evidence_required');}
 assert.equal(f.starts(),0);
 const stored=(await f.store.list<any>('starter_social_content_tasks')).items[0];
 assert.equal(stored.run_id,'run-existing','unverified input cannot replace the persisted run identity');
});

test('missing classification and unknown requirements block before any paid start',async()=>{
 const f=await fixture(); f.set({runId:null,status:'draft'});
 const row=(await f.store.list<any>('social_weekly_agent_planning')).items[0];
 const p:any=structuredClone(f.planning);delete p.dispatch.scheduleItems[0].materialEvidenceRequirements;
 await f.store.update('social_weekly_agent_planning',row.id,{payload:p});
 let result=await f.adapter.execute(f.task);assert.equal('code'in result?result.code:null,'weekly_material_classification_required');assert.equal(f.starts(),0);
 const unknown=classifyMaterialEvidence({scope:{packageId:'package',packageVersion:2,slotId:'slot'}});
 p.dispatch.scheduleItems[0].materialEvidenceRequirements=unknown;p.dispatch.scheduleItems[0].materialRequirements=unknown.items.map(i=>i.description);p.directorAnalyses[0].materialEvidenceRequirements=unknown;
 await f.store.update('social_weekly_agent_planning',row.id,{payload:p});
 result=await f.adapter.execute(f.task);assert.equal('code'in result?result.code:null,'weekly_material_classification_configuration_required');assert.equal(f.starts(),0);
});
test('classification source deletion blocks paid admission even when snapshot hashes remain unchanged',async()=>{
 const f=await fixture();f.set({runId:null,status:'draft'});
 const row=(await f.store.list<any>('starter_social_inspiration_handoff_versions')).items[0];await f.store.delete('starter_social_inspiration_handoff_versions',row.id);
 const result=await f.adapter.execute(f.task);assert.equal('code'in result?result.code:null,'weekly_material_classification_source_missing');assert.equal(f.starts(),0);
});
test('human classification requires exact required=true and explicit per-demand mapping',async()=>{
 const {checkWeeklyHumanRequirementBindings}=await import('./socialWeeklyMaterialClassificationAdmission.js');const f=await fixture();
 const handoff:any={inspirationId:'human',version:'1',analysisVersion:'1',readiness:'production_reference',rights:{mayAnalyze:true,mayAdapt:true},productionImplications:{requiredEvidence:['真实产品实拍证据'],likelyAssetNeeds:[]},adaptationBoundary:{reusable:[],mustReplace:[],prohibited:[]}};
 const contract=classifyMaterialEvidence({scope:{packageId:'package',packageVersion:2,slotId:'slot'},handoff,handoffRef:{inspirationId:'human',version:'1',recordHash:socialRequestHash(handoff)}});
 const args:any={store:f.store,tenantId:'tenant',programId:'program',packageId:'package',packageVersion:2,consumerTaskId:'consumer',publication:{materialRequirement:{required:false,requestIds:['req']}},contract};
 assert.equal(await checkWeeklyHumanRequirementBindings(args),'weekly_required_material_contract_missing');
 args.publication.materialRequirement.required=true;assert.equal(await checkWeeklyHumanRequirementBindings(args),'weekly_material_requirement_mapping_required');
 args.publication.materialRequirement.bindings=[{requirementId:contract.items[0]!.requirementId,requestId:'req'}];
 const request:any={requestId:'req',tenantId:'tenant',programId:'program',requirementKey:'stable-cross-week-key',consumers:[{taskId:'consumer',packageId:'package',packageVersion:2,requirement:'笼统素材已审核'}]};
 const row:any=await f.store.create('social_weekly_material_requests',{tenant_id:'tenant',program_id:'program',request_id:'req',payload:request});
 assert.equal(await checkWeeklyHumanRequirementBindings(args),'weekly_material_requirement_consumer_mapping_missing');
 request.consumers[0].requirement=`${contract.items[0]!.requirementId}：${contract.items[0]!.description}`;await f.store.update('social_weekly_material_requests',row.id,{payload:request});assert.equal(await checkWeeklyHumanRequirementBindings(args),null);
 request.consumers[0].packageVersion=1;await f.store.update('social_weekly_material_requests',row.id,{payload:request});assert.equal(await checkWeeklyHumanRequirementBindings(args),'weekly_material_requirement_consumer_missing');
});

test('continuation markers cannot fall through to new version paid production even via direct adapter',async()=>{
 const f=await fixture();let starts=0,creates=0;
 const adapter=createSocialWeeklyProductionAdapter(f.store,{start:async()=>{starts++;throw Error('must not start');},create:async()=>{creates++;throw Error('must not create');}});
 for(const inputSnapshot of [{weeklyContinuationPending:{mode:'running_reserved',sourceTaskId:'source'}},{weeklyContinuationRef:{type:'weekly_execution_continuation',id:'receipt',version:1}}]){
  const result=await adapter.execute({...f.task,inputSnapshot});assert.equal(result.status,'blocked');assert.equal('code'in result?result.code:null,'weekly_execution_continuation_observation_required');
 }
 assert.equal(starts,0);assert.equal(creates,0);
});
test('actual partial dispatch admits selected external publication and refuses pending owned or confirmation drift before start',async()=>{const f=await fixture(),policy={profile:'b2b_existing',allocationUnit:'mother_content',ownedPercent:40,externalPercent:60},coverage={selectedSlotIds:['slot'],pendingSlotIds:['owned'],referenceSourcePolicy:policy};const item={...f.planning.dispatch.scheduleItems[0]!,scheduleItemId:'selected'};const plan:any={...f.planning,programId:'program',packageId:'package',packageVersion:2,referenceSourcePolicy:policy,skeleton:{packageId:'package',packageVersion:2,slots:[{slotId:'slot',motherContentId:'selected-mother',referenceSource:'external',publicationTaskIds:['publication']},{slotId:'owned',motherContentId:'owned-mother',referenceSource:'owned',publicationTaskIds:['pending']}]},userConfirmation:{confirmedBy:'human',confirmedAt:'2026-10-09T00:00:00Z',selectedSlotIds:['slot']},detailedSchedule:{ref:{type:'weekly_detailed_schedule',id:'detailed',version:1},coverage,items:[item]},dispatch:{...f.planning.dispatch,coverage:structuredClone(coverage),scheduleItems:[item],scheduleItemIds:['selected'],detailedScheduleRef:{type:'weekly_detailed_schedule',id:'detailed',version:1}}};const pkgrow=(await f.store.list<any>('social_weekly_operating_packages')).items[0],planrow=(await f.store.list<any>('social_weekly_agent_planning')).items[0];const pending={...f.pkg.socialContentPackage.publicationTasks[0]!,publicationTaskId:'pending',motherContentId:'owned-mother'};await f.store.update('social_weekly_operating_packages',pkgrow.id,{payload:{...f.pkg,agentPlanning:plan,referenceSourcePolicy:policy,socialContentPackage:{...f.pkg.socialContentPackage,publicationTasks:[pending,...f.pkg.socialContentPackage.publicationTasks.map(pub=>({...pub,motherContentId:'selected-mother'}))]}}});await f.store.update('social_weekly_agent_planning',planrow.id,{payload:plan});await f.refreshAuthority((await f.store.getById<any>('social_weekly_operating_packages',pkgrow.id)).payload,{...f.pkg.socialContentPackage.publicationTasks[0],motherContentId:'selected-mother'});const selected=await f.adapter.execute(f.task);assert.equal(selected.status,'pending',JSON.stringify(selected));f.task.publicationTaskId='pending';assert.equal((await f.adapter.execute(f.task)).status,'blocked');f.task.publicationTaskId='publication';plan.userConfirmation.selectedSlotIds=['owned'];await f.store.update('social_weekly_agent_planning',planrow.id,{payload:plan});assert.equal((await f.adapter.execute(f.task)).status,'blocked');assert.equal(f.starts(),0);});

test('stored package payload scope drift blocks before content creation or paid start',async()=>{
 for(const field of ['programId','packageId','version'] as const){
  const f=await fixture();let creates=0,starts=0;
  const row=(await f.store.list<any>('social_weekly_operating_packages')).items[0]!;
  await f.store.update('social_weekly_operating_packages',row.id,{payload:{...f.pkg,[field]:field==='version'?3:'foreign'}});
  const adapter=createSocialWeeklyProductionAdapter(f.store,{create:async()=>{creates++;throw Error('unexpected create');},start:async()=>{starts++;throw Error('unexpected paid start');}});
  const result=await adapter.execute(f.task);
  assert.equal(result.status,'blocked');assert.equal('code'in result?result.code:null,'weekly_production_package_scope_invalid');
  assert.equal(creates,0);assert.equal(starts,0);
 }
});
