import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {createWeeklyInventoryReuseService} from '../socialPrograms/weeklyInventoryReuse.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {SocialProgramError} from '../socialPrograms/service.js';
export interface WeeklyInventoryUserApproval {actorUserId:string;confirmedAt:string;bindingRef:VersionedSocialRef;bindingHash:string;sourceHash:string;artifactRef:VersionedSocialRef}
function fail():never{throw new SocialProgramError('inventory_current_user_approval_unverified',409,'库存内容需要本周真人重新验收，旧周审批不能替代。');}
export async function createInventoryUserApproval(store:DataStore,task:WeeklyExecutionTask,userId:string,now:string){
 const user=await store.getById<Record_>('users',userId);if(!user||user.tenantId!==task.tenantId||!organizationRoleOrNull(user.role)||user.disabled===true||user.active===false||user.status==='disabled'||publicationInstant(now)===null)fail();
 const current=await createWeeklyInventoryReuseService(store).readVerifiedBinding(task);if(current.pkg.status!=='active')fail();
 const inventoryUserApproval:WeeklyInventoryUserApproval={actorUserId:userId,confirmedAt:now,bindingRef:current.item.ref,bindingHash:current.item.recordHash,sourceHash:current.item.source.sourceHash,artifactRef:current.item.source.artifactRef};
 return{inventoryUserApproval,resultRefs:[{type:'user_content_approval',id:`${task.taskId}:${userId}`,version:1},current.item.ref] as VersionedSocialRef[]};
}
export async function validateInventoryUserApproval(store:DataStore,task:WeeklyExecutionTask,refs:VersionedSocialRef[]){
 const result=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion,task_id:task.taskId},page:1,perPage:2});
 if(result.totalItems!==1||result.items.length!==1)fail();const raw=result.items[0]!.payload;const stored=(typeof raw==='string'?JSON.parse(raw):raw) as WeeklyExecutionTask&{inventoryUserApproval?:WeeklyInventoryUserApproval};
 const receipt=stored.inventoryUserApproval;if(!receipt||stored.status!=='succeeded'||stored.tenantId!==task.tenantId||stored.programId!==task.programId||stored.packageId!==task.packageId||stored.packageVersion!==task.packageVersion||stored.publicationTaskId!==task.publicationTaskId||stored.schedule.stepKind!=='user_approval'||stored.schedule.responsibleActor!=='user'||socialRequestHash(stored.inputSnapshot)!==socialRequestHash(task.inputSnapshot)||socialRequestHash(stored.resultRefs)!==socialRequestHash(refs)||refs.length!==2||refs[0]?.type!=='user_content_approval'||refs[0].id!==`${stored.taskId}:${receipt.actorUserId}`||refs[0].version!==1||publicationInstant(receipt.confirmedAt)===null||Date.parse(receipt.confirmedAt)>Date.now()||stored.schedule.actualFinishedAt!==receipt.confirmedAt)fail();
 const fresh=await createInventoryUserApproval(store,stored,receipt.actorUserId,receipt.confirmedAt);if(socialRequestHash(fresh.inventoryUserApproval)!==socialRequestHash(receipt)||socialRequestHash(fresh.resultRefs)!==socialRequestHash(refs))fail();
 return fresh;
}
