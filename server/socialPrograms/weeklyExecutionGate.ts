import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {acquireDurableOperationLease,assertDurableOperationLease,renewDurableOperationLease,releaseDurableOperationLease,type DurableOperationLease} from '../runtime/durableLease.js';
import {SocialProgramError} from './service.js';
export const WEEKLY_EXECUTION_FREEZES='social_weekly_execution_freezes';
export interface ExecutionPackageScope{tenantId:string;programId:string;packageId:string;packageVersion:number;}
const key=(a:ExecutionPackageScope)=>JSON.stringify([a.tenantId,a.programId,a.packageId,a.packageVersion]);
interface GateContext{key:string;store:DataStore;lease:DurableOperationLease;assert:()=>Promise<void>;}
const context=new AsyncLocalStorage<GateContext>();
export async function executionPackageFrozen(store:DataStore,a:ExecutionPackageScope):Promise<boolean>{const r=await store.list<Record_>(WEEKLY_EXECUTION_FREEZES,{where:{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion},perPage:2});if(!Number.isSafeInteger(r.totalItems)||r.totalItems<0||r.totalItems!==r.items.length||r.totalItems>1)throw new SocialProgramError('weekly_execution_freeze_integrity',409,'周版本冻结记录不完整。');return r.items.length>0;}
export async function withExecutionPackageGate<T>(store:DataStore,a:ExecutionPackageScope,operation:(assert:()=>Promise<void>)=>Promise<T>):Promise<T>{
 const current=context.getStore();if(current?.store===store&&current.key===key(a)){await current.assert();return operation(current.assert);}
 if(!a.tenantId||!a.programId||!a.packageId||!Number.isSafeInteger(a.packageVersion)||a.packageVersion<1)throw new SocialProgramError('weekly_execution_gate_scope_invalid',409,'周执行互斥身份不完整。');
 const lease=await acquireDurableOperationLease({dataStore:store,tenantId:a.tenantId,scope:'social-weekly-execution-gate',subjectId:createHash('sha256').update(key(a)).digest('hex'),ownerId:`gate-${randomUUID()}`,leaseDurationMs:120000});if(!lease)throw new SocialProgramError('weekly_execution_package_gate_busy',409,'该周版本正在确认排期或更新执行状态，请重试。');
 let live=lease,lost:unknown,renewing:Promise<void>|null=null;const renew=()=>{if(renewing||lost)return;renewing=renewDurableOperationLease({dataStore:store,lease:live,leaseDurationMs:120000}).then(next=>{live=next;}).catch(e=>{lost=e;}).finally(()=>{renewing=null;});};const timer=setInterval(renew,20000);timer.unref();
 const assert=async()=>{if(renewing)await renewing;if(lost)throw new SocialProgramError('weekly_execution_package_gate_lost',409,'周执行互斥租约已丢失，未继续写入。');await assertDurableOperationLease({dataStore:store,lease:live,minimumRemainingMs:10000});};
 try{return await context.run({key:key(a),store,lease,assert},async()=>{await assert();return operation(assert);});}finally{clearInterval(timer);if(renewing)await renewing;await releaseDurableOperationLease({dataStore:store,lease:live});}
}
export async function assertExecutionPackageGate(store:DataStore,a:ExecutionPackageScope):Promise<boolean>{const c=context.getStore();if(c?.store!==store||c.key!==key(a))return false;await c.assert();return true;}
export async function freezeExecutionPackage(store:DataStore,a:ExecutionPackageScope,input:{snapshotId:string;targetVersion:number;actorUserId:string;inputEvidenceHash:string;confirmedAt:string}){
 if(!await assertExecutionPackageGate(store,a))throw new SocialProgramError('weekly_execution_freeze_gate_required',409,'冻结必须持有周版本共同互斥。');
 const old=await store.list<Record_>(WEEKLY_EXECUTION_FREEZES,{where:{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion},perPage:2});if(old.items.length){if(old.items.length!==1||old.totalItems!==1||old.items[0]!.snapshot_id!==input.snapshotId)throw new SocialProgramError('weekly_execution_freeze_conflict',409,'原周版本已经由另一排期确认冻结。');return;}
 const created=await store.create(WEEKLY_EXECUTION_FREEZES,{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion,snapshot_id:input.snapshotId,target_version:input.targetVersion,created_by:input.actorUserId,input_evidence_hash:input.inputEvidenceHash,confirmed_at:input.confirmedAt});if(!created)throw new SocialProgramError('weekly_execution_freeze_storage_failed',503,'未能冻结原周版本，新草稿尚未创建。');
}
