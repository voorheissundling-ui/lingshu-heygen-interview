import {socialAssetSupplyPlanIdentityHash} from './socialAssetSupplyPlanIdentity.js';
import type {Starter198Repository,StarterRecord} from './repository.js';
import type {SocialContentTaskDetail,SocialTaskSource} from '../../shared/contracts/socialContentWorkflow.js';
import {socialJson,socialObject,socialRequestHash} from './socialContentValidation.js';
export interface WeeklySchedulerMaterialPlanProof {schemaVersion:'weekly-scheduler-material-plan.v1';tenantId:string;taskId:string;originalTaskVersion:string;scheduledTaskVersion:string;commandId:string;plan:NonNullable<SocialContentTaskDetail['assetSupplyPlan']>;inputHash:string;sourceHash:string;recordHash:string}
function sourceHash(sources:SocialTaskSource[]){return socialRequestHash(sources.filter(s=>s.status==='active').slice().sort((a,b)=>a.sourceId.localeCompare(b.sourceId)));}
function inputs(row:Record<string,unknown>){const brief={...socialObject(socialJson(row.brief))};delete brief._weeklyMaterialDemand;return {brief,replicationScript:socialJson(row.replication_script)??null,materialRequirements:socialJson(row.material_requirements)??null,packageSelection:socialJson(row.package_selection)??null};}
export function buildWeeklySchedulerMaterialPlanProof(input:{tenantId:string;taskId:string;commandId:string;row:StarterRecord;detail:SocialContentTaskDetail;sources:SocialTaskSource[]}):WeeklySchedulerMaterialPlanProof|null {
 const authority=socialObject(socialObject(socialJson(input.row.brief))?._weeklyAuthority);
 if(!authority)return null;
 if(input.detail.runId||!input.detail.assetSupplyPlan||input.detail.taskId!==input.taskId||input.detail.version!==String(input.row.version))return null;
 const v=Number(input.detail.version.replace(/^v/,''));if(!Number.isSafeInteger(v)||v<1)return null;
 const payload={schemaVersion:'weekly-scheduler-material-plan.v1' as const,tenantId:input.tenantId,taskId:input.taskId,originalTaskVersion:input.detail.version,scheduledTaskVersion:String(v+1),commandId:input.commandId,plan:structuredClone(input.detail.assetSupplyPlan),inputHash:socialRequestHash(inputs(input.row)),sourceHash:sourceHash(input.sources)};
 return {...payload,recordHash:socialRequestHash(payload)};
}
/** Actual scheduler context, identity and complete current plan must agree; the
 * only mapped field is the documented top-level lifecycle-derived planVersion. */
export async function readWeeklySchedulerMaterialPlan(repository:Starter198Repository,row:Record<string,unknown>,detail:Pick<SocialContentTaskDetail,'taskId'|'runId'|'version'|'sources'|'assetSupplyPlan'>):Promise<NonNullable<SocialContentTaskDetail['assetSupplyPlan']>|null>{
 if(!repository.dataStore||!row.run_id||!detail.assetSupplyPlan)return null;
 const run=await repository.dataStore.getById<Record<string,unknown>>('workflow_runs',String(row.run_id)),context=socialObject(socialJson(run?.starter_context)),proof=context?.weeklyMaterialPlan as WeeklySchedulerMaterialPlanProof|undefined;
 if(!run||run.tenant_id!==row.tenant_id||context?.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==row.task_id||!proof)return null;
 const {recordHash,...payload}=proof;
 if(proof.schemaVersion!=='weekly-scheduler-material-plan.v1'||recordHash!==socialRequestHash(payload)||proof.tenantId!==row.tenant_id||proof.taskId!==row.task_id||proof.originalTaskVersion!==context.socialTaskVersion||String(row.version)!==proof.scheduledTaskVersion||row.last_operation_id!==proof.commandId||detail.runId!==row.run_id||proof.inputHash!==socialRequestHash(inputs(row)))return null;
 const sources=detail.sources.filter(s=>s.status==='active');
 if(proof.sourceHash!==sourceHash(sources))return null;
 const current={...detail.assetSupplyPlan,planVersion:proof.plan.planVersion};
 if(detail.assetSupplyPlan.planVersion!==detail.version||proof.plan.planVersion!==proof.originalTaskVersion||socialAssetSupplyPlanIdentityHash(current)!==socialAssetSupplyPlanIdentityHash(proof.plan))return null;
 return structuredClone(proof.plan);
}
