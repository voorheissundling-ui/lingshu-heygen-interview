import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import {prepareDirectorG5Fixture} from '../starter198/socialDirectorG5ReviewService.fixture.js';
import type {SocialDirectorG5Ports} from '../starter198/socialDirectorG5ReviewService.js';
import {SOCIAL_WORK_PACKAGE_KINDS} from '../../shared/contracts/socialContentReplication.js';
import {classifyMaterialEvidence} from '../socialPrograms/materialEvidenceClassification.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import type {SocialInspirationHandoff} from '../../shared/contracts/socialContentDiscovery.js';
/** Actual local media/cache/G4, full frozen weekly context, and persisted dispatch.
 * No mocked authority/audit/persistence or provider execution. G5 and final approval
 * remain explicit caller actions. Caller must always invoke cleanup(). */
export async function prepareWeeklyQualityAuditFixture(media?:{width:number;height:number;fps:number;registeredOwnedMedia?:boolean},options:Parameters<typeof prepareDirectorG5Fixture>[3]={},ports:SocialDirectorG5Ports={}){
 const f=await prepareDirectorG5Fixture(ports,media,undefined,options);
 const contentTask=f.tables.starter_social_content_tasks![0]!;
 contentTask.brief={...(contentTask.brief as object),programRef:{objectType:'social_program',id:'p',version:'1'},title:'实际成片审批',objective:'核验同一条企业产品视频',markets:['US'],languages:['en'],platforms:['tiktok'],formats:['short_video'],restrictions:[]};
 Object.assign(contentTask,{status:'asset_review',version:'1',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',source_count:0,knowledge_source_count:0,material_source_count:0,artifact_count:1,approved_artifact_count:0,delivery_package_count:0,publication_count:0,metric_submission_count:0});
 contentTask.package_selection=SOCIAL_WORK_PACKAGE_KINDS.map(kind=>({kind,packageKey:`fixture-${kind}`,version:'1',name:`实际 ${kind} 配置`}));
 const pkg=f.tables.social_weekly_operating_packages![0]!.payload as import('../../shared/contracts/socialProgram.js').WeeklyOperatingPackage;
 const factRef={type:'enterprise_fact',id:f.profile.factVersion!.id,version:f.profile.factVersion!.revision};
 pkg.socialContentPackage.publicationTasks[0]!.factRefs=[factRef];
 pkg.socialContentPackage.publicationTasks[0]!.metricTargets=[];
 Object.assign(pkg.socialContentPackage,{weeklyBudgetCny:10,perItemBudgetCny:10});
 Object.assign(pkg.socialContentPackage.publicationTasks[0]!,{businessProposition:'实际企业产品说明',cta:'询问产品信息'});
 const brief=contentTask.brief as Record<string,unknown>;
 const workflowTask={taskId:'content-workflow',taskRef:{type:'weekly_workflow_task',id:'content-workflow',version:1},kind:'content',subjectRefs:[{type:'weekly_publication_task',id:'pub',version:1}]};
 Object.assign(pkg,{status:'active',objective:'企业产品视频审核',workflowTasks:[workflowTask],successCriteria:[],businessContentGoalRef:{id:'goal',version:1},enterpriseProfileRef:{id:'profile',version:1}});
 brief._weeklyAuthority={weeklyPackage:structuredClone(pkg),publicationTask:structuredClone(pkg.socialContentPackage.publicationTasks[0]),weeklyWorkflowTask:workflowTask,programRef:{type:'social_program',id:'p',version:1},businessGoal:{programId:'p',goalId:'goal',version:1,objective:'企业产品视频审核',products:[],audiences:[],markets:['US'],languages:['en'],publicFactRefs:[factRef]},enterpriseProfileRef:{type:'enterprise_profile',id:'profile',version:1},selectedHandoffs:[],referenceSelection:{selectionId:'selection',version:1,status:'selected',upstreamTaskRef:'content-workflow',selected:[],evidenceVersionRefs:[]}};
 const materialHandoff:SocialInspirationHandoff={inspirationId:'decorative-reference',analysisId:'decorative-analysis',version:'1',analysisVersion:'1',readiness:'production_reference',source:{platform:'tiktok',sourceUrl:'https://www.tiktok.com/@fixture/video/1'},taskContext:{taskId:'content-workflow',market:'US',audience:'企业采购'},whySelected:['只分析视觉节奏，禁止作为企业证据'],referenceRole:'visual_rhythm',reusableLogic:{hookTypes:[],revealOrder:[],proofPlacement:[],pacing:'短转场',emotionalProgression:'平稳',ctaPosition:'结尾'},rights:{mayAnalyze:true,mayUseOriginalMedia:false,mayAdapt:true},productionImplications:{requiredEvidence:[],likelyAssetNeeds:['AI纯装饰非证据背景'],risks:[]},adaptationBoundary:{reusable:['非证据视觉节奏'],mustReplace:['原作者身份和画面'],prohibited:['把装饰画面当产品实证']},evidenceRefs:[{description:'仅非证据视觉节奏',confidence:1,needsReview:false}]};
 const handoffRef={inspirationId:materialHandoff.inspirationId,version:'1',recordHash:socialRequestHash(materialHandoff)};
 const classification=classifyMaterialEvidence({scope:{packageId:'week1',packageVersion:1,slotId:'slot'},handoff:materialHandoff,handoffRef});
 await f.store.create('starter_social_inspiration_handoff_versions',{tenant_id:'t',handoff_version:'1',record_hash:handoffRef.recordHash,payload:materialHandoff});
 const scheduleItem={scheduleItemId:'item',slotId:'slot',publicationTaskId:'pub',accountId:'account',topic:'实际企业产品说明',materialRequirements:classification.items.map(item=>item.description),materialEvidenceRequirements:classification,directorAnalysisRef:{type:'weekly_director_analysis',id:'analysis',version:1}};
 await f.store.create('social_weekly_agent_planning',{tenant_id:'t',program_id:'p',package_id:'week1',package_version:1,planning_version:1,payload:{programId:'p',packageId:'week1',packageVersion:1,status:'dispatched',skeleton:{packageId:'week1',packageVersion:1,slots:[{slotId:'slot',publicationTaskIds:['pub']}]},directorAnalyses:[{analysisId:'analysis',packageId:'week1',packageVersion:1,slotId:'slot',frozenHandoffRefs:[handoffRef],materialEvidenceRequirements:classification}],detailedSchedule:{ref:{type:'weekly_detailed_schedule',id:'detail',version:1},items:[scheduleItem]},userConfirmation:{confirmedBy:'owner',confirmedAt:'2026-10-01T00:00:00Z'},dispatch:{packageId:'week1',packageVersion:1,detailedScheduleRef:{type:'weekly_detailed_schedule',id:'detail',version:1},scheduleItemIds:['item'],scheduleItems:[scheduleItem]}}});
 const artifact=f.tables.starter_social_content_artifacts![0]!;artifact.status='review_required';
 const originalHash=artifact.content_hash;
 const source=f.tables.social_weekly_execution_tasks![0]!.payload as WeeklyExecutionTask;
 const task={...source,tenantId:'t',programId:'p',packageId:'week1',packageVersion:1,publicationTaskId:'pub',accountId:'account',workflowKind:'content' as const,schedule:{...source.schedule,stepKind:'quality_check' as const}};
 Object.assign(artifact,{created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'});
 const ref={type:'starter_social_content_artifact',id:'artifact',version:1};
 return {...f,task,ref,pkg,artifact,originalHash};
}
