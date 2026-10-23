import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyOperatingPackage,SocialWeeklyPublicationTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {publicationInstant} from './publicationDeadlines.js';
import {scheduleHash} from './weeklyScheduleSnapshots.js';
import {assertWeeklyScheduleActor} from './weeklyScheduleActor.js';
import {withExecutionPackageGate} from './weeklyExecutionGate.js';
import {latestPackageRow} from './weeklyOperatingPackageSupport.js';
import {acquireDurableOperationLease,releaseDurableOperationLease} from '../runtime/durableLease.js';
import {SocialProgramError} from './service.js';
import {listWeeklyExecutionTasks,getWeeklyExecutionTaskRow,writeWeeklyExecutionTask} from './executionTasks.js';
import {applyStoredPublicationRecoveryDeadlines} from './publicationDeadlines.js';

export const WEEKLY_PUBLICATION_RECOVERY_SCHEDULES='social_weekly_publication_recovery_schedules';
export interface WeeklyPublicationRecoverySchedule {schemaVersion:1;tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;accountId:string;revision:number;ref:VersionedSocialRef;previousRef:VersionedSocialRef|null;sourceHash:string;originalPublishWindow:string;plannedSendAt:string;source:'automatic_template';templateVersion:'weekly-publication-recovery.v1';adoptedAt:string;actorUserId:string;userApproval:null;outboundAuthorization:false;previousTaskSchedules:Array<{taskId:string;schedule:unknown;nextAttemptAt:string|null}>;}
type Scope={tenantId:string;programId:string;packageId:string;packageVersion:number;actorUserId:string};
const fail=(code:string):never=>{throw new SocialProgramError(code,409,code);};
const sourceHash=(pub:SocialWeeklyPublicationTask)=>{const {status,...frozen}=pub;return scheduleHash(frozen);};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Template slots are only distribution intentions, never provider capacity or
 * permission. Weekend recovery is preferred, within the existing natural week. */
export function automaticPublicationRecoveryWindow(pkg:WeeklyOperatingPackage,publication:SocialWeeklyPublicationTask,now:string,occupied:string[]=[]){
 const today=new Date(Date.parse(now)+8*3600000).toISOString().slice(0,10),days:string[]=[];
 for(let day=today<pkg.weekStart?pkg.weekStart:today;day<=pkg.weekEnd;day=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10))days.push(day);
 days.sort((a,b)=>{const weekend=(day:string)=>[0,6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())?0:1;return weekend(a)-weekend(b)||a.localeCompare(b);});
 const occupiedTimes=new Set([...occupied,...pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId!==publication.publicationTaskId&&p.accountId===publication.accountId).map(p=>p.publishWindow).filter((v):v is string=>Boolean(v))].map(Date.parse));
 for(let minutes=18*60;minutes<=22*60;minutes+=30)for(const day of days){const slot=`${day}T${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}:00+08:00`;if(Date.parse(slot)>Date.parse(now)+30*60000&&!occupiedTimes.has(Date.parse(slot)))return slot;}
 return fail('weekly_publication_recovery_no_remaining_slot');
}
const scopeWhere=(tenantId:string,pkg:WeeklyOperatingPackage,publicationId:string)=>({tenant_id:tenantId,program_id:pkg.programId,package_id:pkg.packageId,package_version:pkg.version,publication_task_id:publicationId});

/** Latest immutable revision; original publication and production dates never change. */
export async function readWeeklyPublicationRecoverySchedule(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,publication:SocialWeeklyPublicationTask){
 const rows=await store.list<Record_>(WEEKLY_PUBLICATION_RECOVERY_SCHEDULES,{where:scopeWhere(tenantId,pkg,publication.publicationTaskId),sort:'-revision',perPage:2});
 if(!rows.totalItems)return null;
 const row=rows.items[0],p=row?.payload as WeeklyPublicationRecoverySchedule;
 if(!row||rows.items.length<Math.min(2,rows.totalItems)||row.content_hash!==scheduleHash(p)||p.schemaVersion!==1||p.tenantId!==tenantId||p.programId!==pkg.programId||p.packageId!==pkg.packageId||p.packageVersion!==pkg.version||p.publicationTaskId!==publication.publicationTaskId||p.accountId!==publication.accountId||p.sourceHash!==sourceHash(publication)||p.originalPublishWindow!==publication.publishWindow||p.ref.id!==row.id||p.ref.type!=='weekly_publication_recovery_schedule'||p.ref.version!==p.revision||p.revision!==row.revision||!Number.isSafeInteger(p.revision)||p.revision<1||p.source!=='automatic_template'||p.userApproval!==null||p.outboundAuthorization!==false||publicationInstant(p.plannedSendAt)===null||!Number.isFinite(Date.parse(p.adoptedAt))||rows.items[1]?.revision===p.revision)fail('weekly_publication_recovery_schedule_invalid');
 const day=new Date(Date.parse(p.plannedSendAt)+8*3600000).toISOString().slice(0,10);
 if(day<pkg.weekStart||day>pkg.weekEnd)fail('weekly_publication_recovery_outside_week');
 if(p.revision===1?p.previousRef!==null:(!rows.items[1]||rows.items[1].revision!==p.revision-1||rows.items[1].content_hash!==scheduleHash(rows.items[1].payload)||scheduleHash((rows.items[1].payload as WeeklyPublicationRecoverySchedule).ref)!==scheduleHash(p.previousRef)))fail('weekly_publication_recovery_history_invalid');
 return p;
}
export async function resolveWeeklyPublicationSchedule(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,publication:SocialWeeklyPublicationTask){
 const recovery=await readWeeklyPublicationRecoverySchedule(store,tenantId,pkg,publication);
 return {plannedSendAt:recovery?.plannedSendAt??publication.publishWindow,recoveryRef:recovery?.ref??null,originalPublishWindow:publication.publishWindow};
}
/** Final submission gate shared by direct adapter and background publication
 * execution. Existing receipts are observed before calling this gate. */
export async function assertWeeklyPublicationRecoveryDue(store:DataStore,assignment:{tenantId:string;publicationTaskId:string;accountId:string;publishWindow:string|null;lineage:{programRef:{id:string};operatingPackageRef:{id:string;version:number}}},now:Date){
 const ref=assignment.lineage.operatingPackageRef;
 const rows=await store.list<Record_>(WEEKLY_PUBLICATION_RECOVERY_SCHEDULES,{where:{tenant_id:assignment.tenantId,program_id:assignment.lineage.programRef.id,package_id:ref.id,package_version:ref.version,publication_task_id:assignment.publicationTaskId},perPage:1});
 if(!rows.totalItems)return null;
 const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:assignment.tenantId,program_id:assignment.lineage.programRef.id,package_id:ref.id,version:ref.version},perPage:2});
 if(packages.totalItems!==1||packages.items.length!==1)fail('weekly_publication_recovery_package_missing');
 const pkg=packages.items[0].payload as WeeklyOperatingPackage;
 const pub=pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===assignment.publicationTaskId&&p.accountId===assignment.accountId&&p.publishWindow===assignment.publishWindow);
 if(!pub)fail('weekly_publication_recovery_assignment_changed');
 const schedule=await resolveWeeklyPublicationSchedule(store,assignment.tenantId,pkg,pub!);
 if(publicationInstant(schedule.plannedSendAt)===null||now.getTime()<Date.parse(schedule.plannedSendAt!))fail('weekly_publication_recovery_not_due');
 return schedule;
}
export async function refreshWeeklyPublicationRecoveryTaskSchedules(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage){
 const tasks=await listWeeklyExecutionTasks(store,tenantId,pkg.programId,pkg.packageId,pkg.version);
 const projected=await applyStoredPublicationRecoveryDeadlines(store,tenantId,pkg,tasks);
 for(const task of projected){const old=tasks.find(t=>t.taskId===task.taskId)!;if(scheduleHash(old)===scheduleHash(task))continue;const row=await getWeeklyExecutionTaskRow(store,tenantId,task.taskId);if(scheduleHash(row.payload)!==scheduleHash(old))fail('weekly_publication_recovery_task_changed');await writeWeeklyExecutionTask(store,row,task);}
 return projected;
}
async function assertUnattempted(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,publication:SocialWeeklyPublicationTask){
 const tasks=await listWeeklyExecutionTasks(store,tenantId,pkg.programId,pkg.packageId,pkg.version);
 if(publication.status==='cancelled'||tasks.some(task=>task.publicationTaskId===publication.publicationTaskId&&task.schedule.stepKind==='publishing'&&(task.lease||task.attempt||task.resultRefs.length||task.schedule.actualStartedAt||task.schedule.actualFinishedAt||['succeeded','cancelled','dead_letter'].includes(task.status))))fail('weekly_publication_recovery_task_already_started');
 const assignments=await store.list<Record_>('social_publication_assignments',{where:{tenant_id:tenantId,operating_package_id:pkg.packageId,operating_package_version:pkg.version,publication_task_id:publication.publicationTaskId},perPage:2});
 if(assignments.totalItems!==assignments.items.length||assignments.totalItems>1)fail('weekly_publication_recovery_assignment_ambiguous');
 for(const assignment of assignments.items){
  const attempts=await store.list<Record_>('social_publication_attempts',{where:{tenant_id:tenantId,assignment_id:String(assignment.assignment_id)},perPage:1});
  if(attempts.totalItems)fail('weekly_publication_recovery_existing_receipt');
  if(assignment.status==='revoked')fail('weekly_publication_recovery_assignment_revoked');
 }
 // Canonical receipts may exist before the assignment projection was repaired.
 const packages=await store.list<Record_>('starter_publication_packages',{where:{tenant_id:tenantId,account_id:publication.accountId},perPage:1000});
 if(packages.totalItems!==packages.items.length)fail('weekly_publication_recovery_receipt_scan_truncated');
 for(const row of packages.items){
  if(!['published','publishing','unknown','in_flight'].includes(String(row.status)))continue;
  let manifest:Record<string,any>;
  try{manifest=typeof row.manifest==='string'?JSON.parse(row.manifest):row.manifest as Record<string,any>;}catch{fail('weekly_publication_recovery_receipt_unverified');}
  if(!manifest!)fail('weekly_publication_recovery_receipt_unverified');
  const lineage=manifest!.operatingLineage;
  if(!lineage)fail('weekly_publication_recovery_receipt_unverified');
  if(lineage?.weeklyPublicationTaskRef?.id===publication.publicationTaskId||lineage?.publicationTaskId===publication.publicationTaskId)fail('weekly_publication_recovery_existing_receipt');
 }
}
export function createWeeklyPublicationRecoveryScheduleService(store:DataStore,ports:{now?:()=>string}={}){
 const adopt=async(a:Scope,publicationTaskId:string,requestedSendAt?:string)=>{
  await assertWeeklyScheduleActor(store,a);
  const now=ports.now?.()??new Date().toISOString();
  return withExecutionPackageGate(store,a,async()=>{
   const row=await latestPackageRow(store,a.tenantId,a.programId,a.packageId);
   if(!row||row.payload.version!==a.packageVersion||!['draft','active'].includes(row.payload.status))fail('weekly_publication_recovery_package_inactive');
   const pkg=row!.payload,pubs=pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===publicationTaskId);
   if(pubs.length!==1)fail('weekly_publication_recovery_publication_missing');
   const pub=pubs[0],original=publicationInstant(pub.publishWindow);
   if(original===null||original>=Date.parse(now))fail('weekly_publication_recovery_not_overdue');
   const lease=await acquireDurableOperationLease({dataStore:store,tenantId:a.tenantId,scope:'weekly_publication_quota',subjectId:digest(`${pkg.packageId}:${pkg.version}`),ownerId:`schedule:${a.actorUserId}`,leaseDurationMs:30000});
   if(!lease)fail('weekly_publication_recovery_busy');
   try{
    const previous=await readWeeklyPublicationRecoverySchedule(store,a.tenantId,pkg,pub);
    const occupied:string[]=[];
    for(const sibling of pkg.socialContentPackage.publicationTasks.filter(p=>p.accountId===pub.accountId&&p.publicationTaskId!==pub.publicationTaskId)){const recovery=await readWeeklyPublicationRecoverySchedule(store,a.tenantId,pkg,sibling);if(recovery)occupied.push(recovery.plannedSendAt);}
    const plannedSendAt=requestedSendAt??previous?.plannedSendAt??automaticPublicationRecoveryWindow(pkg,pub,now,occupied),send=publicationInstant(plannedSendAt);
    if(send===null||send<=Date.parse(now))fail('weekly_publication_recovery_future_time_required');
    const day=new Date(send!+8*3600000).toISOString().slice(0,10);
    if(day<pkg.weekStart||day>pkg.weekEnd)fail('weekly_publication_recovery_outside_week');
    if(previous?.plannedSendAt===plannedSendAt){await refreshWeeklyPublicationRecoveryTaskSchedules(store,a.tenantId,pkg);return previous;}
    await assertUnattempted(store,a.tenantId,pkg,pub);
    const revision=(previous?.revision??0)+1,id=digest(scheduleHash([a.tenantId,pkg.packageId,pkg.version,pub.publicationTaskId,revision]));
    const tasks=await listWeeklyExecutionTasks(store,a.tenantId,pkg.programId,pkg.packageId,pkg.version);
    const payload:WeeklyPublicationRecoverySchedule={schemaVersion:1,tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion,publicationTaskId,accountId:pub.accountId,revision,ref:{type:'weekly_publication_recovery_schedule',id,version:revision},previousRef:previous?.ref??null,sourceHash:sourceHash(pub),originalPublishWindow:pub.publishWindow!,plannedSendAt,source:'automatic_template',templateVersion:'weekly-publication-recovery.v1',adoptedAt:now,actorUserId:a.actorUserId,userApproval:null,outboundAuthorization:false,previousTaskSchedules:tasks.map(task=>({taskId:task.taskId,schedule:structuredClone(task.schedule),nextAttemptAt:task.nextAttemptAt}))};
    if(!await store.create(WEEKLY_PUBLICATION_RECOVERY_SCHEDULES,{id,...scopeWhere(a.tenantId,pkg,publicationTaskId),revision,payload,content_hash:scheduleHash(payload)}))fail('weekly_publication_recovery_write_failed');
    await refreshWeeklyPublicationRecoveryTaskSchedules(store,a.tenantId,pkg);
    return payload;
   }finally{await releaseDurableOperationLease({dataStore:store,lease:lease!});}
  });
 };
 return {adopt};
}
