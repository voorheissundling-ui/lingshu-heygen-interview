import {readMaterialLibrary} from '../lib/materialLibrary.js';
import {objectStorageGetObject} from '../storage/objectStorage.js';
import {isTenantPrivateObjectKey} from '../storage/materialAssets.js';
import {readMaterialBytes} from '../digitalEmployees/productionMaterialAnalysis.js';
import {qualityAllowsReuse} from '../../shared/contracts/generatedMaterial.js';
import {checkWeeklyMaterialAutomatically,weeklyAssetRequirementIdentity,type WeeklyAssetRequirement,type AutomaticMaterialEvidence} from '../../shared/weeklyAutomaticMaterial.js';
import {assessWeeklyMaterialPreparation,assertWeeklyMaterialPreparation,type WeeklyMaterialPreparationAssessment} from './weeklyMaterialPreparationDeadline.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import { getOwnedCloudMaterialRecord, cloudMaterialView } from '../lib/cloudMaterials.js';
import { isSyntheticMaterial } from '../lib/materialTruthfulness.js';
import { isReferenceOnlyMaterial } from '../lib/materialPolicy.js';
import { materializeSocialContentCloudMaterial, type SocialContentCloudMaterialPort } from '../starter198/socialContentMaterialAccess.js';
import { acquireDurableOperationLease, assertDurableOperationLease, releaseDurableOperationLease } from '../runtime/durableLease.js';
import { publicationInstant } from './publicationDeadlines.js';
import { organizationRoleOrNull,localTenantMember } from '../lib/organizationRole.js';
import { SocialProgramError } from './service.js';

export const WEEKLY_MATERIAL_REQUESTS='social_weekly_material_requests';
export interface MaterialConsumer { taskId:string; packageId:string; packageVersion:number; requirement:string; assetRequirement?:WeeklyAssetRequirement }
export interface MaterialSubmission {
  version:number; submittedAt:string; submittedBy:string;
  materials:Array<{recordId:string;sha256:string;type:'image'|'video';byteSize:number}>;
  verification:null|{reviewedAt:string;reviewedBy:string;decision:'accepted'|'rejected';consumerDecisions:Array<{taskId:string;accepted:boolean;factCheck:string;rightsCheck:string;visualCheck:string}>};
}
export interface WeeklyMaterialRequest {
  requestId:string;tenantId:string;programId:string;requirementKey:string;requirements:string;
  assigneeUserId:string;reviewerUserId:string;dueAt:string;verificationDueAt?:string|null;timeZone:string;
  preparation?:WeeklyMaterialPreparationAssessment;
  status:'missing'|'pending_verification'|'accepted'|'rejected'|'cancelled';
  consumers:MaterialConsumer[];submissions:MaterialSubmission[];
  history:Array<{at:string;actor:string;action:string;previousDueAt?:string;previousVerificationDueAt?:string|null;reason?:string;verification?:MaterialSubmission['verification'];consumerTaskId?:string;previousRequirement?:string;nextRequirement?:string}>;
  createdAt:string;updatedAt:string;
}
export interface WeeklyMaterialPorts {
  /** Use authenticated tenant membership; mere existence of a global user is insufficient. */
  isTenantUser?:(tenantId:string,userId:string)=>Promise<boolean>;
  allowSelfReview?:boolean;
  getMaterial?:(tenantId:string,recordId:string)=>Promise<Record<string,unknown>|null>;
  materialBytes?:SocialContentCloudMaterialPort;
  listMaterials?:(tenantId:string)=>Promise<Array<Record<string,any>&{id:string}>>;
  automaticEvidence?:(tenantId:string,recordId:string,sha256:string)=>Promise<AutomaticMaterialEvidence|AutomaticMaterialEvidence[]|null>;
  now?:()=>string;
}
const fail=(code:string,message:string,status=409):never=>{throw new SocialProgramError(code,status,message);};
const text=(value:string,label:string)=>{if(typeof value!=='string'||!value.trim())fail('weekly_material_input_invalid',`请填写${label}。`,400);return value.trim();};
const zoned=(value:string)=>{if(publicationInstant(value)===null)fail('weekly_material_deadline_invalid','截止时间必须是包含明确时区的有效具体时间。',400);return value;};
function timezone(value:string){try{new Intl.DateTimeFormat('en',{timeZone:value}).format();}catch{fail('weekly_material_timezone_invalid','请输入有效的 IANA 时区。',400);}return value;}
const parse=(value:unknown):WeeklyMaterialRequest=>{try{const result=typeof value==='string'?JSON.parse(value):structuredClone(value);if(!result||typeof result!=='object'||!Array.isArray(result.consumers)||!Array.isArray(result.submissions)||!Array.isArray(result.history)||!['missing','pending_verification','accepted','rejected','cancelled'].includes(result.status)||publicationInstant(result.dueAt)===null||(result.verificationDueAt!=null&&publicationInstant(result.verificationDueAt)===null)||!result.assigneeUserId||!result.reviewerUserId)throw Error();return result as WeeklyMaterialRequest;}catch{return fail('weekly_material_identity_invalid','素材任务持久内容无效。');}};
export function materialRequestNotice(request:WeeklyMaterialRequest,now:string) {
  const late=Date.parse(now)>Date.parse(request.dueAt);
  return {uploadOverdue:late&&['missing','rejected'].includes(request.status),verificationDelayed:Boolean(request.verificationDueAt&&Date.parse(now)>Date.parse(request.verificationDueAt)&&request.status==='pending_verification'),verificationDeadlineMissing:request.status==='pending_verification'&&!request.verificationDueAt,pendingVerification:request.status==='pending_verification'};
}
export function materialRequestAcceptedConsumers(request:WeeklyMaterialRequest):string[] {
  const latest=request.submissions.at(-1);
  if (!latest?.verification||request.status==='cancelled')return [];
  return latest.verification.consumerDecisions.filter(item=>item.accepted).map(item=>item.taskId);
}
export function createWeeklyMaterialRequestService(store:DataStore,ports:WeeklyMaterialPorts={}) {
  const now=()=>zoned(ports.now?.()??new Date().toISOString());
  const assertUser=async(tenantId:string,userId:string)=>{text(userId,'指定真人');const local=localTenantMember(tenantId,userId);const user=ports.isTenantUser ? await ports.isTenantUser(tenantId,userId) : local!==undefined?Boolean(local):await store.getById<Record_>('users',userId).then(row=>Boolean(row&&row.tenantId===tenantId&&organizationRoleOrNull(row.role)&&row.disabled!==true&&row.active!==false&&!['disabled','suspended'].includes(String(row.status||''))));if(!user)fail('weekly_material_user_invalid','指定真人不属于当前租户。',403);};
  const read=async(tenantId:string,programId:string,id:string)=> {
    const row=await store.getById<Record_>(WEEKLY_MATERIAL_REQUESTS,id);
    if(!row||row.tenant_id!==tenantId||row.program_id!==programId)fail('weekly_material_not_found','素材任务不存在。',404);
    const request=parse(row!.payload);
    if(request.requestId!==id||request.tenantId!==tenantId||request.programId!==programId||row!.status!==request.status)fail('weekly_material_identity_invalid','素材任务身份异常。');
    request.preparation=await assessWeeklyMaterialPreparation({store,tenantId,programId,consumers:request.consumers,dueAt:request.dueAt,verificationDueAt:request.verificationDueAt,excludedAcceptedConsumerIds:materialRequestAcceptedConsumers(request)});
    return request;
  };
  const save=async(request:WeeklyMaterialRequest,guard:()=>Promise<void>)=> {
    request.preparation=await assessWeeklyMaterialPreparation({store,tenantId:request.tenantId,programId:request.programId,consumers:request.consumers,dueAt:request.dueAt,verificationDueAt:request.verificationDueAt,excludedAcceptedConsumerIds:materialRequestAcceptedConsumers(request)});
    await guard();
    request.updatedAt=now();
    if(!await store.update(WEEKLY_MATERIAL_REQUESTS,request.requestId,{payload:request,status:request.status,updated_at:request.updatedAt}))fail('weekly_material_save_failed','素材任务保存失败。',503);
    return request;
  };
  const locked=async<T>(tenantId:string,id:string,action:(guard:()=>Promise<void>)=>Promise<T>)=> {
    const lease=await acquireDurableOperationLease({dataStore:store,tenantId,scope:'weekly-material-request',subjectId:id,ownerId:`material:${process.pid}`,leaseDurationMs:120_000});
    if(!lease)fail('weekly_material_busy','素材任务正在更新，请稍后重试。');
    try { const result=await action(()=>assertDurableOperationLease({dataStore:store,lease:lease!}));await assertDurableOperationLease({dataStore:store,lease:lease!});return result; }
    finally {await releaseDurableOperationLease({dataStore:store,lease:lease!});}
  };
  const consumers=async(tenantId:string,programId:string,items:MaterialConsumer[])=> {
    if(!Array.isArray(items)||!items.length||new Set(items.map(item=>item.taskId)).size!==items.length)fail('weekly_material_consumers_invalid','需要真实、去重的素材消费者。',400);
    for(const consumer of items) {
      text(consumer.requirement,'该视频的镜头要求');
      if(consumer.assetRequirement)weeklyAssetRequirementIdentity(consumer.assetRequirement);
      const result=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:tenantId,task_id:consumer.taskId},page:1,perPage:2});
      if(result.items.length!==1||result.totalItems!==1)fail('weekly_material_consumer_missing','消费者执行任务不存在或不唯一。');
      const row=result.items[0]!;
      let task:WeeklyExecutionTask={} as WeeklyExecutionTask;try{task=(typeof row.payload==='string'?JSON.parse(row.payload):row.payload) as WeeklyExecutionTask;}catch{fail('weekly_material_consumer_identity_invalid','消费者持久内容无效。');}
      if(!task!?.publicationTaskId||!['content','adaptation'].includes(task!?.scope)||!['material_readiness','asset_generation','storyboard','video_generation'].includes(task!?.schedule?.stepKind))fail('weekly_material_consumer_step_invalid','素材消费者必须是视频的具体生产步骤。');
      if(row.tenant_id!==tenantId||row.program_id!==programId||row.package_id!==consumer.packageId||row.package_version!==consumer.packageVersion||task.tenantId!==tenantId||task.programId!==programId||task.packageId!==consumer.packageId||task.packageVersion!==consumer.packageVersion||task.taskId!==consumer.taskId)fail('weekly_material_consumer_identity_invalid','消费者必须属于当前经营项目的准确任务版本。');
    }
    return structuredClone(items);
  };
  const material=async(tenantId:string,recordId:string,expectedHash?:string,allowGenerated=false)=> {
    if(/^generated-[a-f0-9]{24}$/.test(recordId)){
      if(!allowGenerated)fail('weekly_material_generated_evidence_forbidden','生成素材不能用于未经结构化确认的真实事实证明。');
      const raw=ports.getMaterial?await ports.getMaterial(tenantId,recordId):(await readMaterialLibrary(tenantId)).items.find(r=>r.id===recordId);
      if(!raw||raw.tenantId!==tenantId||raw.generationState!=='archived'||!qualityAllowsReuse(raw.quality as any)||!['image','video'].includes(String(raw.type)))fail('weekly_material_generated_quality_missing','生成素材缺少当前租户的归档质量证据。');
      const hash=String(raw!.contentSha256||'');if(!/^[a-f0-9]{64}$/.test(hash)||expectedHash&&hash!==expectedHash)fail('weekly_material_revision_changed','生成素材字节版本已变化。');
      let bytes:Buffer;
      if(ports.materialBytes){const response=await ports.materialBytes.fetch({tenantId,recordId});if(!response?.ok||!response.body)fail('weekly_material_record_missing','生成素材字节不可读取。');const reader=response!.body!.getReader();try{bytes=await readMaterialBytes({[Symbol.asyncIterator]:()=>({next:()=>reader.read() as Promise<IteratorResult<Uint8Array>>})},{cancel:()=>reader.cancel()});}finally{reader.releaseLock();}}
      else{const key=String(raw!.objectKey||'');if(!isTenantPrivateObjectKey(key,tenantId))fail('weekly_material_generated_object_invalid','生成素材对象不属于当前租户。');const object=await objectStorageGetObject(key);if(!object)fail('weekly_material_record_missing','生成素材字节不存在。');bytes=await readMaterialBytes(object!.body);}
      if(!bytes!.length||createHash('sha256').update(bytes!).digest('hex')!==hash)fail('weekly_material_revision_changed','生成素材实际字节与归档证据不一致。');
      return {recordId,sha256:hash,type:raw!.type as 'image'|'video',byteSize:bytes!.length};
    }
    if(!/^[a-z0-9]{15}$/.test(recordId))fail('weekly_material_record_invalid','请引用真实上传素材的 canonical record ID。',400);
    const raw=await (ports.getMaterial??((tenant,id)=>getOwnedCloudMaterialRecord(id,tenant)))(tenantId,recordId);
    if(!raw||String(raw.tenantId||raw.tenant_id||'')!==tenantId||String(raw.scope||'own')==='shared')fail('weekly_material_record_missing','素材不存在或不属于当前租户。',404);
    const record=cloudMaterialView(raw as any) as any;
    if(record.cloudRecordId!==recordId||isSyntheticMaterial(record)||isReferenceOnlyMaterial(record)||!['image','video'].includes(record.type))fail('weekly_material_not_production_input','该素材不是可用于生产的真实自有图片或视频。');
    const hash=String(record.contentSha256||'');
    if(!/^[a-f0-9]{64}$/.test(hash)||expectedHash&&hash!==expectedHash)fail('weekly_material_revision_changed','素材版本缺失或已改变，请重新提交。');
    const directory=await mkdtemp(path.join(os.tmpdir(),'weekly-material-verification-'));
    try {
      const verified=await materializeSocialContentCloudMaterial({tenantId,record,type:record.type,outputDirectory:directory,index:0,port:ports.materialBytes});
      return {recordId,sha256:verified.sha256,type:record.type as 'image'|'video',byteSize:verified.byteSize};
    } finally {await rm(directory,{recursive:true,force:true});}
  };
  const checkAutomatic=async(request:WeeklyMaterialRequest)=>{
    if(!request.submissions.length || !request.consumers.every(c=>c.assetRequirement))return;
    const materials=request.submissions.at(-1)!.materials;
    for(const m of materials)await material(request.tenantId,m.recordId,m.sha256,request.consumers.every(c=>Boolean(c.assetRequirement)));
    {
          const evidence=await Promise.all(materials.map(async m=>{
            if(ports.automaticEvidence)return ports.automaticEvidence(request.tenantId,m.recordId,m.sha256);
            const raw=ports.getMaterial?await ports.getMaterial(request.tenantId,m.recordId):/^generated-/.test(m.recordId)?(await readMaterialLibrary(request.tenantId)).items.find(r=>r.id===m.recordId):await getOwnedCloudMaterialRecord(m.recordId,request.tenantId);
            let provenance:Record<string,unknown>={};try{provenance=typeof raw?.provenance==='string'?JSON.parse(raw.provenance):raw?.provenance as Record<string,unknown>??{};}catch{}
            return provenance.weeklyAutomaticMaterialEvidence as AutomaticMaterialEvidence|AutomaticMaterialEvidence[]|null??null;
          }));
          const decisions=request.consumers.map(c=>{const checks=materials.flatMap((m,index)=>(Array.isArray(evidence[index])?evidence[index] as AutomaticMaterialEvidence[]:[evidence[index] as AutomaticMaterialEvidence|null]).map(value=>checkWeeklyMaterialAutomatically(c.assetRequirement!,m.sha256,value)));if(!checks.length)checks.push(checkWeeklyMaterialAutomatically(c.assetRequirement!,materials[0]!.sha256,null));return {taskId:c.taskId,...(checks.find(check=>check.accepted)??checks[0]!)};});
          const latest=request.submissions.at(-1)!;const decision=decisions.every(d=>d.accepted)?'accepted':'rejected';if(latest.verification?.reviewedBy==='content_agent'&&latest.verification.decision===decision&&JSON.stringify(latest.verification.consumerDecisions)===JSON.stringify(decisions))return;latest.verification={reviewedAt:now(),reviewedBy:'content_agent',decision,consumerDecisions:decisions};
          request.status=latest.verification.decision;request.history.push({at:now(),actor:'content_agent',action:'automatic_checked',verification:structuredClone(latest.verification)});
        }
  };
  return {
    /** Internal, CAS-guarded refinement of an existing consumer. The old signed
     * submission stays in history; exact new terms require a fresh decision. */
    async reviseConsumerRequirement(input:{tenantId:string;programId:string;requestId:string;actorUserId:string;consumerTaskId:string;packageId:string;packageVersion:number;expectedUpdatedAt:string;expectedRequirement:string;nextRequirement:string;reason:string}){
      return locked(input.tenantId,input.requestId,async guard=>{
        const request=await read(input.tenantId,input.programId,input.requestId);
        await assertUser(input.tenantId,input.actorUserId);
        const issuer=request.history.find(item=>item.action==='created')?.actor;
        if(![request.assigneeUserId,request.reviewerUserId,issuer].includes(input.actorUserId))fail('weekly_material_revision_forbidden','仅原发起人、指定提交人或核验人可以提交调整。',403);
        if(request.status==='cancelled')fail('weekly_material_revision_closed','已取消任务不能静默恢复。');
        if(request.updatedAt!==input.expectedUpdatedAt)fail('weekly_material_revision_version_conflict','素材任务已变化，请重新读取。');
        const matches=request.consumers.filter(c=>c.taskId===input.consumerTaskId&&c.packageId===input.packageId&&c.packageVersion===input.packageVersion);
        if(matches.length!==1||matches[0]!.requirement!==input.expectedRequirement)fail('weekly_material_consumer_identity_invalid','仅能修订当前准确版本的原消费者。');
        const next=text(input.nextRequirement,'当前镜头精确需求'),reason=text(input.reason,'调整原因');
        if(next===input.expectedRequirement)return request;
        const prior=matches[0]!.requirement;
        matches[0]!.requirement=next;
        await consumers(input.tenantId,input.programId,request.consumers);
        if(request.submissions.length){
          const last=request.submissions.at(-1)!;
          for(const item of last.materials)await material(input.tenantId,item.recordId,item.sha256,request.consumers.every(c=>Boolean(c.assetRequirement)));
          request.submissions.push({version:last.version+1,submittedAt:now(),submittedBy:last.submittedBy,materials:structuredClone(last.materials),verification:null});
          request.status='pending_verification';
        }
        request.history.push({at:now(),actor:input.actorUserId,action:'consumer_requirement_refined',reason,consumerTaskId:input.consumerTaskId,previousRequirement:prior,nextRequirement:next});
        return save(request,guard);
      });
    },
    async get(tenantId:string,programId:string,id:string,actorUserId:string){await assertUser(tenantId,actorUserId);return read(tenantId,programId,id);},
    async list(tenantId:string,programId:string,actorUserId:string){
      await assertUser(tenantId,actorUserId);const result:WeeklyMaterialRequest[]=[];
      for(let page=1;;page++){const batch=await store.list<Record_>(WEEKLY_MATERIAL_REQUESTS,{where:{tenant_id:tenantId,program_id:programId},sort:'id',page,perPage:500});for(const row of batch.items)result.push(await read(tenantId,programId,row.id));if(page>=batch.totalPages)return result;if(!batch.items.length)fail('weekly_material_listing_incomplete','素材任务列表读取不完整。',503);}
    },
    async create(input:{tenantId:string;programId:string;requirementKey:string;requirements:string;assigneeUserId:string;reviewerUserId:string;dueAt:string;verificationDueAt?:string|null;timeZone:string;consumers:MaterialConsumer[];actorUserId:string}) {
      const {tenantId,programId}=input;
      await assertUser(tenantId,input.actorUserId);await assertUser(tenantId,input.assigneeUserId);await assertUser(tenantId,input.reviewerUserId);
      if(input.assigneeUserId===input.reviewerUserId&&ports.allowSelfReview===false&&!input.consumers.every(c=>c.assetRequirement))fail('weekly_material_self_review_forbidden','当前策略要求提交人与核验人为不同真人。',403);
      text(programId,'经营项目');text(input.requirements,'素材要求');text(input.requirementKey,'共享素材身份');zoned(input.dueAt);if(input.verificationDueAt)zoned(input.verificationDueAt);timezone(input.timeZone);
      const identities=input.consumers.flatMap(c=>c.assetRequirement?[weeklyAssetRequirementIdentity(c.assetRequirement)]:[]);
      if(identities.length&& (identities.length!==input.consumers.length||new Set(identities).size!==1))fail('weekly_material_shared_identity_mismatch','共享素材的主体、动作、场景、证据、规格和授权范围必须一致。',400);
      const id=createHash('sha256').update(JSON.stringify([tenantId,programId,identities[0]??input.requirementKey])).digest('hex').slice(0,15);
      return locked(tenantId,id,async(guard)=> {
        const existing=await store.getById<Record_>(WEEKLY_MATERIAL_REQUESTS,id);
        if(existing) {const prior=await read(tenantId,programId,id);if(prior.requirements!==input.requirements||prior.assigneeUserId!==input.assigneeUserId||prior.reviewerUserId!==input.reviewerUserId||prior.dueAt!==input.dueAt||prior.timeZone!==input.timeZone||(prior.verificationDueAt??null)!==(input.verificationDueAt??null)||JSON.stringify(prior.consumers)!==JSON.stringify(input.consumers))fail('weekly_material_request_conflict','共享任务已存在；新增消费者或调整截止需显式操作。');return prior;}
        const timestamp=now();
        const actualConsumers=await consumers(tenantId,programId,input.consumers);
        if(input.verificationDueAt&&Date.parse(input.dueAt)>Date.parse(input.verificationDueAt))fail('weekly_material_deadline_order_invalid','上传必须先于或等于核验截止。',400);
        const preparation=await assessWeeklyMaterialPreparation({store,tenantId,programId,consumers:actualConsumers,dueAt:input.dueAt,verificationDueAt:input.verificationDueAt});assertWeeklyMaterialPreparation(preparation);
        const request:WeeklyMaterialRequest={requestId:id,tenantId,programId,requirementKey:input.requirementKey,requirements:input.requirements,assigneeUserId:input.assigneeUserId,reviewerUserId:input.reviewerUserId,dueAt:input.dueAt,verificationDueAt:input.verificationDueAt??null,timeZone:input.timeZone,status:'missing',preparation,consumers:actualConsumers,submissions:[],history:[{at:timestamp,actor:input.actorUserId,action:'created'}],createdAt:timestamp,updatedAt:timestamp};
        await guard();
        const created=await store.create<Record_>(WEEKLY_MATERIAL_REQUESTS,{id,tenant_id:tenantId,program_id:programId,requirement_key:input.requirementKey,status:request.status,payload:request,created_at:timestamp,updated_at:timestamp});
        if(!created)fail('weekly_material_save_failed','素材任务保存失败。',503);
        return read(tenantId,programId,id);
      });
    },
    async submit(input:{tenantId:string;programId:string;requestId:string;actorUserId:string;materialRecordIds:string[];expectedSubmissionVersion:number}) {
      return locked(input.tenantId,input.requestId,async(guard)=> {
        const request=await read(input.tenantId,input.programId,input.requestId);
        await assertUser(input.tenantId,input.actorUserId);
        if(request.assigneeUserId!==input.actorUserId)fail('weekly_material_submit_forbidden','仅指定真人可以提交该任务。',403);
        if(['cancelled','accepted'].includes(request.status))fail('weekly_material_submission_closed','该素材任务当前不接受新提交。');
        const previous=request.submissions.at(-1)?.version??0;
        if(previous!==input.expectedSubmissionVersion)fail('weekly_material_submission_version_conflict','提交版本已变化，请重新读取。');
        if(!input.materialRecordIds.length||new Set(input.materialRecordIds).size!==input.materialRecordIds.length)fail('weekly_material_submission_empty','请提交去重后的真实素材。',400);
        const materials:MaterialSubmission['materials']=[];
        for(const id of input.materialRecordIds)materials.push(await material(input.tenantId,id,undefined,request.consumers.every(c=>Boolean(c.assetRequirement))));
        if(new Set(materials.map(item=>item.sha256)).size!==materials.length)fail('weekly_material_duplicate_bytes','重复素材字节不能充当多个独立素材。');
        request.submissions.push({version:previous+1,submittedBy:input.actorUserId,submittedAt:now(),materials,verification:null});
        request.status='pending_verification';
        await checkAutomatic(request);
        request.history.push({at:now(),actor:input.actorUserId,action:'submitted'});
        return save(request,guard);
      });
    },
    async review(input:{tenantId:string;programId:string;requestId:string;actorUserId:string;submissionVersion:number;consumerDecisions:Array<{taskId:string;accepted:boolean;factCheck:string;rightsCheck:string;visualCheck:string}>}) {
      return locked(input.tenantId,input.requestId,async(guard)=> {
        const request=await read(input.tenantId,input.programId,input.requestId);
        await assertUser(input.tenantId,input.actorUserId);
        if(request.assigneeUserId===request.reviewerUserId&&ports.allowSelfReview===false)fail('weekly_material_self_review_forbidden','当前策略要求提交人与核验人为不同真人。',403);
        if(request.reviewerUserId!==input.actorUserId)fail('weekly_material_review_forbidden','仅指定核验人可以确认素材。',403);
        const latest=request.submissions.at(-1);
        if(request.status!=='pending_verification'||!latest||latest.version!==input.submissionVersion)fail('weekly_material_review_version_conflict','仅可核验当前待核验提交版本。');
        const decisions=input.consumerDecisions;
        if(decisions.length!==request.consumers.length||new Set(decisions.map(item=>item.taskId)).size!==decisions.length||decisions.some(item=>!request.consumers.some(c=>c.taskId===item.taskId)||typeof item.accepted!=='boolean'))fail('weekly_material_verification_incomplete','请逐一核验全部消费者的镜头要求。',400);
        for(const decision of decisions){text(decision.factCheck,'产品事实核验结论');text(decision.rightsCheck,'素材权利核验结论');text(decision.visualCheck,'镜头质量核验结论');}
        await consumers(input.tenantId,input.programId,request.consumers);
        for(const evidence of latest!.materials)await material(input.tenantId,evidence.recordId,evidence.sha256,request.consumers.every(c=>Boolean(c.assetRequirement)));
        latest!.verification={reviewedAt:now(),reviewedBy:input.actorUserId,decision:decisions.every(item=>item.accepted)?'accepted':'rejected',consumerDecisions:structuredClone(decisions)};
        request.status=latest!.verification.decision;request.history.push({at:now(),actor:input.actorUserId,action:request.status,verification:structuredClone(latest!.verification)});
        return save(request,guard);
      });
    },
    async acceptedForConsumer(input:{tenantId:string;programId:string;requestId:string;consumerTaskId:string}) {
      let request=await read(input.tenantId,input.programId,input.requestId);
      if(request.status!=='cancelled'&&request.consumers.every(c=>c.assetRequirement)){
        await locked(input.tenantId,input.requestId,async guard=>{
          const current=await read(input.tenantId,input.programId,input.requestId);
          if(current.status==='cancelled')return;
          if(!current.submissions.length){
            const inventory=ports.listMaterials?await ports.listMaterials(input.tenantId):(await readMaterialLibrary(input.tenantId)).items;
            const candidates=inventory.filter(r=>r.tenantId===input.tenantId&&/^generated-[a-f0-9]{24}$/.test(r.id)).sort((a,b)=>a.id.localeCompare(b.id));
            for(const record of candidates){
              const value=record.provenance?.weeklyAutomaticMaterialEvidence;const receipts=Array.isArray(value)?value:[value];
              if(!current.consumers.every(c=>receipts.some(e=>checkWeeklyMaterialAutomatically(c.assetRequirement!,String(record.contentSha256||''),e??null).accepted)))continue;
              const verified=await material(input.tenantId,record.id,undefined,true);
              current.submissions.push({version:1,submittedAt:now(),submittedBy:'content_agent',materials:[verified],verification:null});
              current.history.push({at:now(),actor:'content_agent',action:'generated_material_adopted'});break;
            }
          }
          if(current.submissions.length){await checkAutomatic(current);await save(current,guard);}
        });
        request=await read(input.tenantId,input.programId,input.requestId);
      }
      if(!materialRequestAcceptedConsumers(request).includes(input.consumerTaskId))return null;
      const consumer=request.consumers.find(item=>item.taskId===input.consumerTaskId);
      if(!consumer)return fail('weekly_material_consumer_identity_invalid','消费者身份异常。');
      await consumers(input.tenantId,input.programId,[consumer]);
      const submission=request.submissions.at(-1)!;
      for(const evidence of submission.materials)await material(input.tenantId,evidence.recordId,evidence.sha256,request.consumers.every(c=>Boolean(c.assetRequirement)));
      // The caller must still bind these exact versions to production and verify its remaining requirements.
      return {requestId:request.requestId,submissionVersion:submission.version,consumer:structuredClone(consumer),materials:structuredClone(submission.materials),verification:structuredClone(submission.verification)};
    },
    async cancel(input:{tenantId:string;programId:string;requestId:string;actorUserId:string;reason:string}){
      return locked(input.tenantId,input.requestId,async(guard)=>{const request=await read(input.tenantId,input.programId,input.requestId);await assertUser(input.tenantId,input.actorUserId);if(request.reviewerUserId!==input.actorUserId)fail('weekly_material_cancel_forbidden','仅指定核验人可以取消素材任务。',403);if(request.status==='cancelled')return request;request.status='cancelled';request.history.push({at:now(),actor:input.actorUserId,action:'cancelled',reason:text(input.reason,'取消原因')});return save(request,guard);});
    },
    async revise(input:{tenantId:string;programId:string;requestId:string;actorUserId:string;reason:string;dueAt?:string;verificationDueAt?:string;timeZone?:string;addConsumers?:MaterialConsumer[]}) {
      return locked(input.tenantId,input.requestId,async(guard)=> {
        const request=await read(input.tenantId,input.programId,input.requestId);
        await assertUser(input.tenantId,input.actorUserId);
        const issuer=request.history.find(item=>item.action==='created')?.actor;
        if(![request.assigneeUserId,request.reviewerUserId,issuer].includes(input.actorUserId))fail('weekly_material_revision_forbidden','仅原发起人、指定提交人或核验人可以提交调整。',403);
        const reason=text(input.reason,'调整原因');
        if(request.status==='cancelled')fail('weekly_material_revision_closed','已取消任务不能静默恢复。');
        const previousDueAt=request.dueAt;const previousVerificationDueAt=request.verificationDueAt??null;
        if(input.verificationDueAt)request.verificationDueAt=zoned(input.verificationDueAt);
        if(input.dueAt){request.dueAt=zoned(input.dueAt);request.timeZone=timezone(input.timeZone??request.timeZone);}
        if(input.addConsumers?.length){const added=await consumers(input.tenantId,input.programId,input.addConsumers);const identities=[...request.consumers,...added].flatMap(c=>c.assetRequirement?[weeklyAssetRequirementIdentity(c.assetRequirement)]:[]);if(identities.length&&(identities.length!==request.consumers.length+added.length||new Set(identities).size!==1))fail('weekly_material_shared_identity_mismatch','共享素材的主体、动作、场景、证据、规格和授权范围必须一致。',400);if(added.some(item=>request.consumers.some(old=>old.taskId===item.taskId)))fail('weekly_material_consumer_duplicate','消费者已存在。');request.consumers.push(...added);if(request.submissions.length)request.status='pending_verification';}
        await consumers(input.tenantId,input.programId,request.consumers);
        if(input.addConsumers?.length)await checkAutomatic(request);
        const accepted=materialRequestAcceptedConsumers(request);
        if(accepted.length)for(const evidence of request.submissions.at(-1)!.materials)await material(input.tenantId,evidence.recordId,evidence.sha256,request.consumers.every(c=>Boolean(c.assetRequirement)));
        if(!request.submissions.length&&request.verificationDueAt&&Date.parse(request.dueAt)>Date.parse(request.verificationDueAt))fail('weekly_material_deadline_order_invalid','上传必须先于或等于核验截止。',400);
        request.preparation=await assessWeeklyMaterialPreparation({store,tenantId:input.tenantId,programId:input.programId,consumers:request.consumers,dueAt:request.dueAt,verificationDueAt:request.verificationDueAt,excludedAcceptedConsumerIds:accepted});assertWeeklyMaterialPreparation(request.preparation);
        request.history.push({at:now(),actor:input.actorUserId,action:'revised',previousDueAt,previousVerificationDueAt,reason});
        return save(request,guard);
      });
    },
  };
}

export type WeeklyMaterialRequestService = ReturnType<typeof createWeeklyMaterialRequestService>;
export type CreateWeeklyMaterialRequestInput = Parameters<WeeklyMaterialRequestService['create']>[0];
export type SubmitWeeklyMaterialRequestInput = Parameters<WeeklyMaterialRequestService['submit']>[0];
export type ReviewWeeklyMaterialRequestInput = Parameters<WeeklyMaterialRequestService['review']>[0];
export type ReviseWeeklyMaterialRequestInput = Parameters<WeeklyMaterialRequestService['revise']>[0];
