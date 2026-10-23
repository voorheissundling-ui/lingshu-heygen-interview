import {STARTER_COLLECTIONS,type Starter198Repository,type StarterRecord} from './repository.js';
import {socialTaskSource} from './socialContentRecords.js';
import {readWeeklyReplicationContext} from './weeklyReplicationContext.js';
import type {SocialContentTaskDetail,SocialReplicationJob,SocialReplicationJobContext} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyOperatingPackage,WeeklyTargetAccountPlaybook} from '../../shared/contracts/socialProgram.js';
import {verifyWeeklyTargetAccountPlaybook} from '../socialPrograms/weeklyTargetAccountPlaybook.js';
import {socialJson,socialObject,socialRequestHash,SocialContentWorkflowError,parseSocialReplicationContext} from './socialContentValidation.js';
export interface WeeklyReplicationAuthorityProof {schemaVersion:'weekly-replication-authority.v1';tenantId:string;taskId:string;originalTaskVersion:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;playbook:WeeklyTargetAccountPlaybook;context:SocialReplicationJobContext;contextHash:string;briefContextHash:string;referenceAnalysisHash:string;job:SocialReplicationJob;recordHash:string}
function fail():never{throw new SocialContentWorkflowError('weekly_replication_authority_unverified',409);}
function inputs(row:Record<string,unknown>){const brief=socialObject(socialJson(row.brief));if(!brief)return fail();return {briefContextHash:socialRequestHash(parseSocialReplicationContext(brief)),referenceAnalysisHash:socialRequestHash(socialJson(row.reference_video_analysis)??null)};}
export async function freezeWeeklyReplicationAuthority(repository:Starter198Repository,row:StarterRecord,detail:SocialContentTaskDetail):Promise<WeeklyReplicationAuthorityProof|null>{
 const brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority);
 if(!authority||detail.brief.creationMode!=='viral_replication')return null;
 const pkg=authority.weeklyPackage as WeeklyOperatingPackage,pub=socialObject(authority.publicationTask),job=detail.agentWorkflow?.replicationJob;
 if(!repository.dataStore||!pkg||!pub||detail.runId||detail.taskId!==row.task_id||detail.version!==String(row.version)||!job||job.contentTaskId!==detail.taskId)return fail();
 const item=pkg.agentPlanning?.dispatch?.scheduleItems.find(item=>item.publicationTaskId===pub.publicationTaskId),analysis=pkg.agentPlanning?.directorAnalyses.find(analysis=>analysis.analysisId===item?.directorAnalysisRef.id),playbook=item?.targetAccountPlaybook;
 if(!playbook||analysis?.targetAccountPlaybooks?.filter(candidate=>socialRequestHash(candidate)===socialRequestHash(playbook)).length!==1)return fail();
 await verifyWeeklyTargetAccountPlaybook(repository.dataStore,String(row.tenant_id),pkg.programId,playbook);
 const ref=job.target.accountPlaybookRef,account=job.target.accountRef;
 if(!ref||ref.id!==playbook.playbookRef.id||String(ref.version)!==String(playbook.playbookRef.version)||ref.accountRef!==playbook.accountId||!account||account.id!==playbook.accountId||String(account.version)!==String(playbook.accountRef.version)||job.referenceChain.targetAccountPlaybook?.id!==ref.id||job.referenceChain.targetAccountPlaybook?.version!==ref.version||!job.referenceAssignments.length||!job.factorSpecs.length)return fail();
 const context=await readWeeklyReplicationContext({store:repository.dataStore,tenantId:String(row.tenant_id),task:row,sources:detail.sources});if(!context)return fail();
 const payload={context:structuredClone(context),contextHash:socialRequestHash(context),schemaVersion:'weekly-replication-authority.v1' as const,tenantId:String(row.tenant_id),taskId:detail.taskId,originalTaskVersion:detail.version,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:String(pub.publicationTaskId),playbook:structuredClone(playbook),...inputs(row),job:structuredClone(job)};
 return {...payload,recordHash:socialRequestHash(payload)};
}
/** Read original scheduler proof. Never reconstruct a missing proof from latest rules. */
export async function readWeeklyReplicationAuthority(repository:Starter198Repository,row:StarterRecord):Promise<WeeklyReplicationAuthorityProof|null>{
 const brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority);
 if(!authority||brief?.creationMode!=='viral_replication')return null;
 if(!repository.dataStore||!row.run_id)return fail();
 const run=await repository.dataStore.getById<Record<string,unknown>>('workflow_runs',String(row.run_id)),context=socialObject(socialJson(run?.starter_context)),proof=context?.weeklyReplicationAuthority as WeeklyReplicationAuthorityProof|undefined,pkg=authority.weeklyPackage as WeeklyOperatingPackage,pub=socialObject(authority.publicationTask);
 if(!proof||!run||run.tenant_id!==row.tenant_id||context?.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==row.task_id)return fail();
 const material=context.weeklyMaterialPlan as import('./socialWeeklySchedulerMaterialPlan.js').WeeklySchedulerMaterialPlanProof|undefined;
 if(!material)return fail();const {recordHash:materialHash,...materialPayload}=material;
 if(materialHash!==socialRequestHash(materialPayload)||material.schemaVersion!=='weekly-scheduler-material-plan.v1'||material.tenantId!==row.tenant_id||material.taskId!==row.task_id||material.originalTaskVersion!==proof.originalTaskVersion||String(row.version)!==material.scheduledTaskVersion||row.last_operation_id!==material.commandId)return fail();
 const {recordHash,...payload}=proof,current=inputs(row);
 if(!proof.context||proof.contextHash!==socialRequestHash(proof.context)||recordHash!==socialRequestHash(payload)||proof.schemaVersion!=='weekly-replication-authority.v1'||proof.tenantId!==row.tenant_id||proof.taskId!==row.task_id||proof.originalTaskVersion!==context.socialTaskVersion||proof.programId!==pkg.programId||proof.packageId!==pkg.packageId||proof.packageVersion!==pkg.version||proof.publicationTaskId!==pub?.publicationTaskId||proof.briefContextHash!==current.briefContextHash||proof.referenceAnalysisHash!==current.referenceAnalysisHash||proof.job.contentTaskId!==row.task_id)return fail();
 const item=pkg.agentPlanning?.dispatch?.scheduleItems.find(item=>item.publicationTaskId===proof.publicationTaskId);
 if(socialRequestHash(item?.targetAccountPlaybook)!==socialRequestHash(proof.playbook))return fail();
 const sourceRows=await repository.list(STARTER_COLLECTIONS.socialTaskSources,String(row.tenant_id),{where:{task_id:String(row.task_id)},perPage:500});if(sourceRows.totalItems!==sourceRows.items.length)return fail();
 const actualContext=await readWeeklyReplicationContext({store:repository.dataStore,tenantId:String(row.tenant_id),task:row,sources:sourceRows.items.map(socialTaskSource)});if(!actualContext||socialRequestHash(actualContext)!==proof.contextHash)return fail();
 await verifyWeeklyTargetAccountPlaybook(repository.dataStore,String(row.tenant_id),pkg.programId,proof.playbook);
 return structuredClone(proof);
}
