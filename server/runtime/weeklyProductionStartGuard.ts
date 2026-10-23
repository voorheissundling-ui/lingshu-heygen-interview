import {assertStoredWeeklyProductionCoverage} from './weeklyProductionCoverageAdmission.js';
import type {Starter198Repository} from '../starter198/repository.js';
import {STARTER_COLLECTIONS} from '../starter198/repository.js';
import {requireSocialTask,readSocialTaskDetail} from '../starter198/socialContentRecords.js';
import {socialJson,socialObject,socialText,socialRequestHash,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {parseSocialContentAuthorityLineage} from '../starter198/socialContentLineage.js';
import {withExecutionPackageGate,executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {SocialContentTaskDetail} from '../../shared/contracts/socialContentWorkflow.js';
import {resolveWeeklyCreativeRepairAuthority} from './weeklyCreativeRepairAuthority.js';
import {assertWeeklyCreativeRepairCtaAdmission} from './weeklyCreativeRepairCtaAdmission.js';

const frozenWorkflow=(t:any)=>({taskId:t.taskId,kind:t.kind,taskRef:t.taskRef,dependsOnTaskIds:t.dependsOnTaskIds,subjectRefs:t.subjectRefs,carriedFromTaskId:t.carriedFromTaskId});
const frozenPublication=(t:any)=>{const {status,...rest}=t;return rest;};
/** Scope comes exclusively from the stored creation receipt and durable lineage. */
export async function withWeeklyProductionStartGuard(input:{repository:Starter198Repository;tenantId:string;taskId:string},start:()=>Promise<SocialContentTaskDetail>,ports:{read?:typeof readSocialTaskDetail}={}):Promise<SocialContentTaskDetail>{
 const row=await requireSocialTask(input),brief=socialObject(socialJson(row.brief));let authority=socialObject(brief?._weeklyAuthority),creativeBinding:string|null=null;
 const binding=socialText(row.create_idempotency_key);
 const creative=binding.startsWith('weekly-creative-repair:')||Boolean(brief?._weeklyCreativeRepairProof);
 if(creative){if(!input.repository.dataStore)throw new SocialContentWorkflowError('weekly_creative_repair_authority_invalid',409);const resolved=await resolveWeeklyCreativeRepairAuthority({store:input.repository.dataStore,tenantId:input.tenantId,task:row});if(!resolved)throw new SocialContentWorkflowError('weekly_creative_repair_authority_invalid',409);authority=resolved.authority;creativeBinding=resolved.bindingKey;}
 if(!binding.startsWith('weekly-production:')&&!creative&&!authority)return start();
 const fail=()=>{throw new SocialContentWorkflowError('weekly_production_start_authority_invalid',409);};
 const pkg=authority?.weeklyPackage as WeeklyOperatingPackage|undefined;
 const programRef=socialObject(authority?.programRef),publication=socialObject(authority?.publicationTask),workflow=socialObject(authority?.weeklyWorkflowTask);
 if(!pkg||!programRef||!publication||!workflow||!input.repository.dataStore)return fail();
 const scope={tenantId:input.tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version};
 if(binding!==(creative?creativeBinding:`weekly-production:${pkg.packageId}:${pkg.version}:${publication.publicationTaskId}`)||programRef.id!==pkg.programId)return fail();
 const store=input.repository.dataStore;
 return withExecutionPackageGate(store,scope,async assert=>{
  const programs=await store.list<any>('social_programs',{where:{tenant_id:input.tenantId,program_id:pkg.programId},perPage:2});
  if(programs.totalItems!==1)return fail();
  const packages=await store.list<any>('social_weekly_operating_packages',{where:{tenant_id:input.tenantId,program_id:pkg.programId,package_id:pkg.packageId,version:pkg.version},perPage:2});
  const actual=packages.items[0]?.payload as WeeklyOperatingPackage|undefined;
  if(packages.totalItems!==1||!actual||actual.programId!==pkg.programId||actual.packageId!==pkg.packageId||actual.version!==pkg.version)return fail();
  const lineages=await input.repository.list(STARTER_COLLECTIONS.socialContentLineage,input.tenantId,{where:{weekly_task_id:String(socialObject(workflow.taskRef)?.id??'')},perPage:500});
  if(!Number.isFinite(lineages.totalItems)||lineages.totalItems>lineages.items.length)return fail();
  const valid=lineages.items.some(record=>{const value=parseSocialContentAuthorityLineage(record);return value.invalidation.status==='valid'&&value.packageRef.id===pkg.packageId&&value.packageRef.version===pkg.version&&value.programRef.id===pkg.programId&&value.publicationTaskRef.id===publication.publicationTaskId&&value.weeklyTaskRef.id===socialObject(workflow.taskRef)?.id;});
  if(!valid)return fail();
  const fresh=await requireSocialTask(input);
  if(socialRequestHash(socialJson(fresh.brief))!==socialRequestHash(socialJson(row.brief)))return fail();
  // An existing actual run is observed, never restarted through this entry.
  if(socialText(fresh.run_id)||socialText(fresh.orchestrator_item_id)){const detail=await (ports.read??readSocialTaskDetail)(input);if(!detail)return fail();return detail;}
  if(creative)await assertWeeklyCreativeRepairCtaAdmission({store,tenantId:input.tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:String(publication.publicationTaskId),inheritedCallToAction:brief?.callToAction});
  if(programs.items[0]?.payload?.version!==programRef.version||socialRequestHash(actual.enterpriseProfileRef??null)!==socialRequestHash(pkg.enterpriseProfileRef??null)||socialRequestHash(actual.businessContentGoalRef??null)!==socialRequestHash(pkg.businessContentGoalRef??null)||socialRequestHash(actual.agentPlanning??null)!==socialRequestHash(pkg.agentPlanning??null)
   ||!actual.workflowTasks.some(task=>socialRequestHash(frozenWorkflow(task))===socialRequestHash(frozenWorkflow(workflow)))
   ||!actual.socialContentPackage.publicationTasks.some(task=>socialRequestHash(frozenPublication(task))===socialRequestHash(frozenPublication(publication))))return fail();
  await assertStoredWeeklyProductionCoverage({store,tenantId:input.tenantId,package:actual,publicationTaskId:String(publication.publicationTaskId),frozenPlanning:pkg.agentPlanning});
  if(await executionPackageFrozen(store,scope))throw new SocialContentWorkflowError('weekly_execution_package_frozen',409);
  await assert();const result=await start();await assert();return result;
 });
}
