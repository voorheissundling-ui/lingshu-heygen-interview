import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import type {MaterialConsumer} from './weeklyMaterialRequests.js';
import {publicationInstant} from './publicationDeadlines.js';
import {SocialProgramError} from './service.js';

export interface WeeklyMaterialPreparationAssessment {
 earliestRequiredAt:string|null;
 productionTaskIds:string[];
 consumerTaskIds:string[];
 excludedAcceptedConsumerIds:string[];
 missingScheduleConsumerIds:string[];
 verificationDeadlineMissing:boolean;
 uploadDeadlineAfterRequiredStart:boolean;
 verificationDeadlineAfterRequiredStart:boolean;
}
function error(code:string,message:string):never{throw new SocialProgramError(code,409,message);}
const parse=(value:unknown):WeeklyExecutionTask=>{try{const parsed=typeof value==='string'?JSON.parse(value):value;if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed as WeeklyExecutionTask;}catch{return error('weekly_material_schedule_identity_invalid','素材前置任务持久证据格式无效。');}};
const requiredAt=(t:WeeklyExecutionTask):number|null=>{const times=[publicationInstant(t.schedule.actualStartedAt??''),publicationInstant(t.schedule.estimatedStartAt??'')].filter((value):value is number=>value!==null);return times.length?Math.min(...times):null;};
/** The monolithic content executor admits shared human evidence before script production. */
export async function assessWeeklyMaterialPreparation(input:{store:DataStore;tenantId:string;programId:string;consumers:MaterialConsumer[];dueAt:string;verificationDueAt?:string|null;excludedAcceptedConsumerIds?:string[]}):Promise<WeeklyMaterialPreparationAssessment>{
 const excluded=new Set(input.excludedAcceptedConsumerIds??[]),consumerTaskIds:string[]=[],missingScheduleConsumerIds:string[]=[],productionTaskIds:string[]=[];let earliest:number|null=null;
 const cached=new Map<string,WeeklyExecutionTask[]>();
 for(const consumer of input.consumers){
  if(excluded.has(consumer.taskId))continue;consumerTaskIds.push(consumer.taskId);
  const key=JSON.stringify([consumer.packageId,consumer.packageVersion]);let tasks=cached.get(key);
  if(!tasks){tasks=[];const seen=new Set<string>();let total:number|undefined;for(let page=1;;page++){
   const rows=await input.store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:consumer.packageId,package_version:consumer.packageVersion},page,perPage:500,sort:'id'});
   if(!Number.isSafeInteger(rows.totalItems)||!Number.isSafeInteger(rows.totalPages)||total!==undefined&&total!==rows.totalItems)error('weekly_material_schedule_pagination_invalid','素材前置排期证据分页不完整。');total=rows.totalItems;
   for(const row of rows.items){if(seen.has(row.id))error('weekly_material_schedule_pagination_invalid','素材前置排期证据分页重复。');seen.add(row.id);const task=parse(row.payload);if(row.tenant_id!==input.tenantId||row.program_id!==input.programId||row.package_id!==consumer.packageId||row.package_version!==consumer.packageVersion||task.tenantId!==input.tenantId||task.programId!==input.programId||task.packageId!==consumer.packageId||task.packageVersion!==consumer.packageVersion)error('weekly_material_schedule_identity_invalid','素材前置任务必须来自准确租户和冻结周版本。');tasks.push(task);}
   if(page>=rows.totalPages){if(tasks.length!==rows.totalItems)error('weekly_material_schedule_pagination_invalid','素材前置排期证据被截断。');break;}if(!rows.items.length)error('weekly_material_schedule_pagination_invalid','素材前置排期证据被截断。');
  }cached.set(key,tasks);}
  const actual=tasks.find(t=>t.taskId===consumer.taskId);if(!actual?.publicationTaskId)error('weekly_material_consumer_missing','素材消费者真实身份缺失。');
  const candidates=tasks.filter(t=>t.publicationTaskId===actual.publicationTaskId&&['script','storyboard','material_readiness','asset_generation','video_generation','quality_check','rework'].includes(t.schedule?.stepKind));
  // A downstream consumer estimate cannot establish an absent upstream script start.
  const scripts=candidates.filter(t=>t.schedule.stepKind==='script');
  if(!scripts.length||scripts.some(t=>requiredAt(t)===null)){missingScheduleConsumerIds.push(consumer.taskId);continue;}
  for(const task of candidates){const time=requiredAt(task);if(time===null)continue;if(earliest===null||time<earliest){earliest=time;productionTaskIds.splice(0,productionTaskIds.length,task.taskId);}else if(time===earliest&&!productionTaskIds.includes(task.taskId))productionTaskIds.push(task.taskId);}
 }
 return {earliestRequiredAt:earliest===null?null:new Date(earliest).toISOString(),productionTaskIds,consumerTaskIds,excludedAcceptedConsumerIds:input.consumers.filter(c=>excluded.has(c.taskId)).map(c=>c.taskId),missingScheduleConsumerIds,verificationDeadlineMissing:!input.verificationDueAt,uploadDeadlineAfterRequiredStart:earliest!==null&&Date.parse(input.dueAt)>earliest,verificationDeadlineAfterRequiredStart:earliest!==null&&Boolean(input.verificationDueAt&&Date.parse(input.verificationDueAt)>earliest)};
}
export function assertWeeklyMaterialPreparation(assessment:WeeklyMaterialPreparationAssessment):void{
 if(assessment.uploadDeadlineAfterRequiredStart||assessment.verificationDeadlineAfterRequiredStart)error('weekly_material_deadline_after_first_production','上传和核验必须在最早需要素材的脚本或内容生产开始前完成，不能按下游素材消费者的较晚时间排期。');
}
