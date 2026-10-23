import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyMaterialPorts} from '../socialPrograms/weeklyMaterialRequests.js';
import {createWeeklyRequiredMaterialAdmission} from '../socialPrograms/weeklyRequiredMaterialAdmission.js';
import {createWeeklyExecutionTaskService} from '../socialPrograms/executionTasks.js';
import {executionPackageFrozen,withExecutionPackageGate} from '../socialPrograms/weeklyExecutionGate.js';
import {SUPPLEMENT_EVENTS,supplementConsumerHash} from '../socialPrograms/weeklySupplementRequests.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
const reasons=new Set(['weekly_required_materials_missing','weekly_required_material_not_verified_for_consumer','weekly_required_material_review_evidence_missing','weekly_material_hash_changed','weekly_material_revision_changed']);
const parsed=<T>(v:unknown)=>socialObject(socialJson(v)) as unknown as T;
async function rows(store:DataStore,collection:string,where:Record<string,string|number>){const out:Record_[]=[];let total:number|undefined;for(let page=1;page<=10000;page++){const r=await store.list<Record_>(collection,{where,page,perPage:500,sort:'id'});if(!Number.isSafeInteger(r.totalItems)||r.totalItems<0||total!==undefined&&total!==r.totalItems||r.items.some(x=>!x.id||out.some(y=>y.id===x.id)||Object.entries(where).some(([k,v])=>x[k]!==v)))throw Error('human_material_scan_changed');total=r.totalItems;out.push(...r.items);if(out.length===total)return out;if(!r.items.length||out.length>total)throw Error('human_material_scan_incomplete');}throw Error('human_material_scan_limit');}
function identity(task:WeeklyExecutionTask,requirement:unknown){return socialRequestHash({consumer:supplementConsumerHash(task),upstreamVersionRefs:task.upstreamVersionRefs,dueAt:task.schedule.latestStartAt||task.schedule.estimatedStartAt,responsibleActor:task.schedule.responsibleActor,requirement});}
async function writeOnce(store:DataStore,id:string,tenantId:string,exceptionId:string,version:number,value:Record<string,unknown>){const sealed={...value,recordHash:socialRequestHash(value)};const verify=(row:Record_|null)=>{const p=row&&parsed<Record<string,unknown>>(row.payload);if(!row||row.id!==id||row.tenant_id!==tenantId||row.request_id!==exceptionId||row.version!==version||!p)throw Error('human_material_receipt_invalid');const {recordHash,...body}=p;if(recordHash!==socialRequestHash(body))throw Error('human_material_receipt_invalid');const {createdAt:_old,...semantic}=body;const {createdAt:_new,...expected}=value;if(socialRequestHash(semantic)!==socialRequestHash(expected))throw Error('human_material_receipt_conflict');return p;};const old=await store.getById<Record_>(SUPPLEMENT_EVENTS,id);if(old)return verify(old);try{const created=await store.create<Record_>(SUPPLEMENT_EVENTS,{id,tenant_id:tenantId,request_id:exceptionId,version,payload:sealed});if(created)return verify(created);}catch{/* Unknown write outcome: exact readback only, never another create. */}return verify(await store.getById<Record_>(SUPPLEMENT_EVENTS,id));}
/** Durable, per-consumer recovery. It never adds consumers, approves material or completes production. */
export async function runWeeklyHumanMaterialRecoveryScan(input:{store:DataStore;tenantIds?:string[];materialPorts?:WeeklyMaterialPorts;now?:Date;scope?:WeeklyScanScope}){
 const report={status:'no_data' as 'no_data'|'processed',examined:0,materialized:0,resumed:0,blocked:0,failed:0};
 const admission=createWeeklyRequiredMaterialAdmission(input.store,input.materialPorts);
 for(const row of await rows(input.store,'social_weekly_execution_tasks',{})){
  const task=parsed<WeeklyExecutionTask>(row.payload);if(!weeklyScopeMatches(input.scope,task))continue;if(!task||input.tenantIds&&!input.tenantIds.includes(task.tenantId)||task.status!=='blocked'||!reasons.has(task.lastError?.code??'')||task.schedule?.stepKind!=='material_readiness')continue;
  report.status='processed';report.examined++;
  try{await withExecutionPackageGate(input.store,task,async assert=>{
   const fresh=await rows(input.store,'social_weekly_execution_tasks',{tenant_id:task.tenantId,program_id:task.programId,task_id:task.taskId});
   if(fresh.length!==1)throw Error('human_material_consumer_not_unique');const live=parsed<WeeklyExecutionTask>(fresh[0]!.payload);
   if(fresh[0]!.package_id!==task.packageId||fresh[0]!.package_version!==task.packageVersion||live.tenantId!==task.tenantId||live.programId!==task.programId||live.packageId!==task.packageId||live.packageVersion!==task.packageVersion||live.taskId!==task.taskId||live.status!=='blocked'||live.lease||live.lastError?.code!==task.lastError?.code||supplementConsumerHash(live)!==supplementConsumerHash(task))throw Error('human_material_consumer_changed');
   if(await executionPackageFrozen(input.store,live)){report.blocked++;return;}
   const packages=await rows(input.store,'social_weekly_operating_packages',{tenant_id:live.tenantId,program_id:live.programId,package_id:live.packageId,version:live.packageVersion});
   const pkg=parsed<WeeklyOperatingPackage>(packages[0]?.payload);if(packages.length!==1||!pkg||pkg.programId!==live.programId||pkg.packageId!==live.packageId||pkg.version!==live.packageVersion||!['active','draft'].includes(pkg.status)){report.blocked++;return;}
   const pubs=pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===live.publicationTaskId&&p.accountId===live.accountId);if(pubs.length!==1)throw Error('human_material_publication_changed');const requirement=pubs[0]!.materialRequirement;
   if(!requirement?.required||!requirement.requestIds.length){report.blocked++;return;}
   const consumerInputHash=identity(live,requirement),gapCode=live.lastError!.code;
   const exceptionId=socialRequestHash({type:'human_material_exception',consumerInputHash,gapCode}).slice(0,15);
   const priorEvents=await rows(input.store,SUPPLEMENT_EVENTS,{tenant_id:live.tenantId,version:2});for(const event of priorEvents){const old=parsed<Record<string,unknown>>(event.payload);if(old?.type==='human_material_exception'&&old.consumerTaskId===live.taskId&&old.programId===live.programId&&old.consumerInputHash!==consumerInputHash){report.blocked++;return;}}
   const value={type:'human_material_exception',exceptionId,tenantId:live.tenantId,programId:live.programId,packageId:live.packageId,packageVersion:live.packageVersion,consumerTaskId:live.taskId,consumerInputHash,gapCode,requestIds:requirement.requestIds,dueAt:live.schedule.latestStartAt||live.schedule.estimatedStartAt,responsibleActor:live.schedule.responsibleActor,status:'pending_verification',createdAt:(input.now??new Date()).toISOString()};
   await assert();await writeOnce(input.store,socialRequestHash({exceptionId,version:2}).slice(0,15),live.tenantId,exceptionId,2,value);report.materialized++;
   const checked=await admission({tenantId:live.tenantId,programId:live.programId,consumerTaskId:live.taskId,requirement});
   if(checked.status!=='ready'||!checked.materials.length){report.blocked++;return;}
   // The admission reads live bytes and exact consumer review; hold the original package gate throughout.
   await assert();await writeOnce(input.store,socialRequestHash({exceptionId,version:3}).slice(0,15),live.tenantId,exceptionId,3,{...value,status:'resolved',materials:checked.materials,verifiedRequestRefs:checked.verifiedRequestRefs});
   const reread=await rows(input.store,'social_weekly_execution_tasks',{tenant_id:live.tenantId,program_id:live.programId,task_id:live.taskId});const current=parsed<WeeklyExecutionTask>(reread[0]?.payload);
   if(reread.length!==1||current.lease||current.status!=='blocked'||identity(current,requirement)!==consumerInputHash||current.lastError?.code!==gapCode||await executionPackageFrozen(input.store,current))throw Error('human_material_consumer_changed');
   await assert();const changed=await createWeeklyExecutionTaskService(input.store).unblock(live.tenantId,live.programId,live.packageId,live.taskId,gapCode);
   if(!changed.some(t=>t.taskId===live.taskId&&t.packageVersion===live.packageVersion&&!t.ownBlockingReasons.includes(gapCode)))throw Error('human_material_resume_failed');report.resumed++;
  });}catch{report.failed++;}
 }
 return report;
}
/** Authenticated exact-scope readback only: no scanning, verification or task mutation. */
export async function listWeeklyHumanMaterialExceptions(input:{store:DataStore;tenantId:string;programId:string;packageId:string;packageVersion:number}){
 const packages=await rows(input.store,'social_weekly_operating_packages',{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,version:input.packageVersion});const pkg=parsed<WeeklyOperatingPackage>(packages[0]?.payload);
 if(packages.length!==1||!pkg||pkg.programId!==input.programId||pkg.packageId!==input.packageId||pkg.version!==input.packageVersion)throw Error('human_material_package_invalid');
 const result:Array<Record<string,unknown>>=[];
 function receipt(row:Record_,expectedVersion:number,exceptionId:string){const body=parsed<Record<string,unknown>>(row.payload);if(!body)throw Error('human_material_receipt_invalid');const {recordHash,...value}=body;if(row.id!==socialRequestHash({exceptionId,version:expectedVersion}).slice(0,15)||row.tenant_id!==input.tenantId||row.request_id!==exceptionId||row.version!==expectedVersion||value.type!=='human_material_exception'||value.exceptionId!==exceptionId||value.tenantId!==input.tenantId||value.programId!==input.programId||value.packageId!==input.packageId||value.packageVersion!==input.packageVersion||recordHash!==socialRequestHash(value)||value.status!==(expectedVersion===2?'pending_verification':'resolved'))throw Error('human_material_receipt_invalid');return body;}
 for(const row of await rows(input.store,SUPPLEMENT_EVENTS,{tenant_id:input.tenantId,version:2})){
  const value=parsed<Record<string,unknown>>(row.payload);if(value?.type!=='human_material_exception'||value.programId!==input.programId||value.packageId!==input.packageId||value.packageVersion!==input.packageVersion)continue;
  if(typeof value.exceptionId!=='string'||typeof value.consumerTaskId!=='string')throw Error('human_material_receipt_invalid');const pending=receipt(row,2,value.exceptionId);
  const tasks=await rows(input.store,'social_weekly_execution_tasks',{tenant_id:input.tenantId,program_id:input.programId,task_id:value.consumerTaskId});const task=parsed<WeeklyExecutionTask>(tasks[0]?.payload);if(tasks.length!==1||!task||task.tenantId!==input.tenantId||task.programId!==input.programId||task.packageId!==input.packageId||task.packageVersion!==input.packageVersion)throw Error('human_material_consumer_changed');
  const pubs=pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===task.publicationTaskId&&p.accountId===task.accountId);if(pubs.length!==1||identity(task,pubs[0]!.materialRequirement)!==pending.consumerInputHash)throw Error('human_material_consumer_changed');
  const resolved=await input.store.getById<Record_>(SUPPLEMENT_EVENTS,socialRequestHash({exceptionId:value.exceptionId,version:3}).slice(0,15));const current=resolved?receipt(resolved,3,value.exceptionId):pending;if(current.consumerInputHash!==pending.consumerInputHash||current.consumerTaskId!==pending.consumerTaskId||current.gapCode!==pending.gapCode||socialRequestHash(current.requestIds)!==socialRequestHash(pending.requestIds)||resolved&&(!Array.isArray(current.materials)||!current.materials.length||!Array.isArray(current.verifiedRequestRefs)||!current.verifiedRequestRefs.length))throw Error('human_material_receipt_invalid');result.push(current);
 }
 return result;
}
