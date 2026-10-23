import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';
import type {DataStore} from '../storage/datastore.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {StoryboardAigcProjectBudget} from '../lib/storyboardAigcProjectBudget.js';
import {readMvpSpeechRevision} from '../lib/mvpSpeechRevisionReuse.js';
import {socialObject,socialRequestHash} from './socialContentValidation.js';
import {frozenStudioProjectSpec} from './socialContentStudioFrozenBridge.js';
async function sha(file:string){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
/** Read-only evidence, separate from package readiness, approval and accounting invoices. */
export async function readFrozenStudioOperationalEvidence(input:{dataStore:DataStore;tenantId:string;projectId:string;spec:unknown;authorityRoot?:string}){
 const spec=frozenStudioProjectSpec(input.spec),c=socialObject(spec.resolvedStudioContract);if(!c)return null;
 const root=input.authorityRoot??process.cwd(),dataRoot=fs.realpathSync(path.join(root,'data')),taskId=String(c.taskId),runId=String(c.runId),version=Number(c.taskVersion);
 if(c.tenantId!==input.tenantId)throw Error('studio_operational_evidence_scope_changed');
 const job=await readContentExecutionJob(input.dataStore,input.tenantId,taskId,runId),binding=socialObject(job?.checkpoints['social.executor']?.payload);
 if(!job||!binding||job.id!==c.jobId||binding.inputHash!==c.inputHash||(socialObject(binding?.approvedContext)?.revisionPlanHash!==c.planHash))throw Error('studio_operational_evidence_binding_changed');
 const ledger=await new StoryboardAigcProjectBudget(path.join(dataRoot,'storyboard-aigc-budget')).status(input.tenantId,input.projectId),providerOperations=[];
 for(const entry of ledger.entries){
  const base=`mvp-studio:${input.projectId}:S04:video:v${version}`;
  if(entry.operationId!==base&&!entry.operationId.startsWith(base+':repair-'))continue;
  const output=socialObject(entry.output),providerTaskId=String(output?.providerTaskId||'');if(!providerTaskId)continue;
  const file=path.join(dataRoot,'mvp-studio-video-results',`S04-${providerTaskId.replace(/[^a-zA-Z0-9_-]/g,'_')}.mp4`),qaFile=file+'.qa.json';
  let qualityStatus='unverified',providerStatus='accepted',mediaSha256:string|null=null,rejectionRef:string|null=null,qaReceiptHash:string|null=null;
  if(fs.existsSync(qaFile)&&fs.existsSync(file)){
   const bytes=fs.readFileSync(qaFile),qa=JSON.parse(bytes.toString());
   if(qa.tenantId!==input.tenantId||qa.projectId!==input.projectId||qa.taskId!==taskId||qa.runId!==runId||Number(qa.version)!==version||qa.shotId!=='S04'||qa.providerTaskId!==providerTaskId||qa.inputFingerprint!==output?.seedanceInputFingerprint||typeof qa.filePath!=='string'||fs.realpathSync(qa.filePath)!==fs.realpathSync(file)||await sha(file)!==qa.outputSha256)throw Error('studio_operational_QA_scope_invalid');
   providerStatus='completed';mediaSha256=qa.outputSha256;qualityStatus=qa.canAdopt===true&&qa.quality?.passed===true?'passed':'rejected';qaReceiptHash=createHash('sha256').update(bytes).digest('hex');
   if(fs.existsSync(file+'.local-rejection.json')){const reject=JSON.parse(fs.readFileSync(file+'.local-rejection.json','utf8'));if(reject.providerTaskId!==providerTaskId||reject.mediaSha256!==mediaSha256||reject.scope?.runId!==runId||reject.scope?.projectId!==input.projectId||Number(reject.scope?.taskVersion)!==version)throw Error('studio_operational_rejection_scope_invalid');qualityStatus='rejected';rejectionRef=`studio_visual_rejection:${socialRequestHash(reject)}`;}
  }
  providerOperations.push({shotId:'S04',operationId:entry.operationId,providerTaskId,providerStatus,qualityStatus,adoptionStatus:qualityStatus==='rejected'?'blocked':'not_adopted',receiptRef:`studio_budget:${entry.operationId}`,qaReceiptHash,rejectionRef,mediaSha256,estimatedCostCny:(entry.originalAmountMicros??entry.amountMicros)/1e6,reservedCostCny:entry.amountMicros/1e6,actualCostCny:null,invoiceKnown:false});
 }
 const adopted=await input.dataStore.list<any>('social_studio_asset_adoptions',{where:{tenant_id:input.tenantId,task_id:taskId,run_id:runId,job_id:job.id,shot_id:'S01'},perPage:2});
 if(adopted.totalItems>1)throw Error('studio_operational_adoption_ambiguous');
 if(adopted.items.length){const row=adopted.items[0],proof=row.proof;if(row.proof_hash!==socialRequestHash(proof))throw Error('studio_operational_adoption_corrupt');const {createPersistedStudioReceiptAdoptionAdapter}=await import('./socialContentStudioAdoption.js');const shot=(socialObject(binding.approvedContext)?.assetSupplyPlan as any)?.shots?.find((s:any)=>s.shotId==='S01');await createPersistedStudioReceiptAdoptionAdapter({dataStore:input.dataStore,scope:{tenantId:input.tenantId,taskId,runId,jobId:job.id}}).execute({tenantId:input.tenantId,taskId,shot,baselineScene:{} as any,availableAssets:[],outputDirectory:''});providerOperations.push({shotId:'S01',operationId:`studio_adoption:${row.id}`,providerTaskId:proof.providerTaskId,providerStatus:'completed',qualityStatus:'passed',adoptionStatus:'adopted',receiptRef:proof.providerReceiptRef,qaReceiptHash:null,rejectionRef:null,mediaSha256:proof.mediaSha256,estimatedCostCny:null,reservedCostCny:null,actualCostCny:proof.actualCostCny,invoiceKnown:proof.actualCostCny!==null});}
 const audio=[];const speechRoot=path.join(dataRoot,'mvp-speech-revision-reuse');
 if(fs.existsSync(speechRoot))for(const filename of fs.readdirSync(speechRoot)){if(!/^[a-f0-9]{64}\.json$/.test(filename))continue;const row=JSON.parse(fs.readFileSync(path.join(speechRoot,filename),'utf8')),target=row.input?.target;if(target?.tenantId!==input.tenantId||target.taskId!==taskId||target.runId!==runId||Number(target.version)!==version||target.planHash!==c.planHash)continue;const r=readMvpSpeechRevision(filename.slice(0,-5),speechRoot);audio.push({role:r.operationRole,receiptRef:r.receiptRef,sha256:r.clipSha256,durationSeconds:r.durationSeconds,sourceRunId:r.sourceIdentity.runId,sourceCostPreserved:r.sourceCostPreserved});}
 const hook=audio.find(a=>a.role==='hook'),body=audio.find(a=>a.role==='body');
 if(hook&&body){const {readVoiceAssemblyPreview}=await import('./socialContentVoiceAssemblyPreview.js');const preview=await readVoiceAssemblyPreview({dataStore:input.dataStore,scope:{tenantId:input.tenantId,taskId,runId,jobId:job.id},hookRef:hook.receiptRef,bodyRef:body.receiptRef,authorityRoot:root});if(preview)audio.push(preview as any);}
 const pools=[];const poolRoot=path.join(dataRoot,'mvp-budget-pools');
 if(fs.existsSync(poolRoot))for(const filename of fs.readdirSync(poolRoot)){if(!/^[a-f0-9]{64}\.json$/.test(filename))continue;const p=JSON.parse(fs.readFileSync(path.join(poolRoot,filename),'utf8'));if(p.tenantId!==input.tenantId||p.taskId!==taskId)continue;if(p.schemaVersion!==1||!Number.isFinite(p.limitCny)||!p.entries||Array.isArray(p.entries))throw Error('studio_operational_pool_corrupt');const entries=Object.values(p.entries) as any[];if(entries.some(e=>!Number.isFinite(e.amountCny)||e.amountCny<0||!['reserved','completed'].includes(e.status)))throw Error('studio_operational_pool_corrupt');pools.push({poolRef:`mvp_budget:${p.id}`,session:p.session,authorizedCny:p.limitCny,retainedReservedCny:entries.reduce((sum,e)=>sum+e.amountCny,0),actualCostCny:null,invoiceKnown:false,sourceRunIds:[...new Set((p.authorizations??[]).map((a:any)=>a.runId))]});}
 return {schemaVersion:'social-studio-operational.v1',tenantId:input.tenantId,taskId,taskVersion:version,runId,jobId:job.id,inputHash:c.inputHash,planHash:c.planHash,jobStatus:job.status,providerOperations,audio,budget:{status:pools.length?'recorded':'missing',poolAuthorizedCny:pools.length?pools.reduce((s,p)=>s+p.authorizedCny,0):null,retainedReservedCny:pools.length?pools.reduce((s,p)=>s+p.retainedReservedCny,0):null,actualCostCny:null,invoiceKnown:false,pools},artifactCompleted:false,humanApproved:false,publicationAuthorized:false};
}
