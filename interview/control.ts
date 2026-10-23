import fs from 'node:fs/promises';import path from 'node:path';import {Readable} from 'node:stream';
import {createRequire} from 'node:module';import type {WeeklyExecutionTask} from '../shared/contracts/socialProgram.js';
import {pbStore as store} from '../server/storage/pbStore.js';
import {runWithDataAuthority} from '../server/storage/dataAuthority.js';
import {createStarter198Repository} from '../server/starter198/repository.js';
import {prepareWeeklyQualityAuditFixture} from '../server/runtime/weeklyContentQualityAudit.fixture.js';
import {createSocialWeeklyProductionAdapter} from '../server/runtime/socialWeeklyProductionAdapter.js';
import {createSocialWeeklyExecutionWorker} from '../server/runtime/socialWeeklyExecutionWorker.js';
import {admitContentExecutionJob,DurableContentExecutionWorker,readContentExecutionJob} from '../server/contentExecution/durableQueue.js';
import {storeSocialContentFile,registerSocialContentFile} from '../server/starter198/socialContentFiles.js';
import {createSocialContentArtifact} from '../server/starter198/socialContentOutputs.js';
import {runVisualFfmpeg} from '../server/lib/renderVisualQuality.js';
const root=path.resolve('.interview-data');const fixedNow=()=>new Date('2026-10-02T12:00:00Z');
export const local=<T>(fn:()=>T)=>runWithDataAuthority('local',fn);
const repository=createStarter198Repository(store);
/** Scenarios pin a historical valid week; wall clock never silently expires the exercise. */
export async function seed(){return local(async()=>{
 await fs.rm(path.join(root,'store'),{recursive:true,force:true});await fs.mkdir(root,{recursive:true});
 const f=await prepareWeeklyQualityAuditFixture({width:360,height:640,fps:24,registeredOwnedMedia:true});
 try{
  await fs.writeFile(path.join(root,'source.mp4'),await fs.readFile(f.local));
  await fs.writeFile(path.join(root,'template.json'),JSON.stringify(f.artifact.content));await fs.writeFile(path.join(root,'context.json'),JSON.stringify({context:f.context,handoff:f.handoff}));
  // Fixture is upstream context only: discard ALL final artifacts, review receipts and cached outputs.
  const excluded=new Set(['starter_social_content_artifacts','starter_social_production_receipts','starter_social_scene_media_caches','starter_social_scene_g4_reviews','starter_publication_packages','social_metric_snapshots','social_weekly_review_snapshots','starter_social_content_operations','starter_social_content_files']);
  for(const [collection,rows]of Object.entries(f.tables)){
   if(excluded.has(collection))continue;
   for(const row of rows as any[]){if(collection==='social_weekly_execution_tasks')continue;if(collection==='social_weekly_operating_packages'&&row.package_id!=='week1')continue;const copy=structuredClone(row);if(collection==='starter_198_access'){copy.cycle_started_at='2026-10-01T00:00:00Z';copy.cycle_ends_at='2099-12-31T00:00:00Z';}await store.create(collection,copy);}
  }
  const content=(await store.list<any>('starter_social_content_tasks')).items[0];await store.update('starter_social_content_tasks',content.id,{status:'producing',task_mode:'weekly',artifact_count:0,approved_artifact_count:0});
  // Seed canonical frozen source records before any worker scan; these are local, synthetic upstream inputs.
  const brief=structuredClone(content.brief),authority=brief._weeklyAuthority;
  const handoff=(await store.list<any>('starter_social_inspiration_handoff_versions')).items[0].payload;
  authority.referenceSelection={...authority.referenceSelection,evidenceVersionRefs:['controlled-evidence@1'],selected:[{candidateId:handoff.inspirationId,evidenceId:'controlled-evidence',evidenceVersion:1}]};authority.selectedHandoffs=[handoff];
  await store.create('trend_videos',{id:handoff.inspirationId,tenantId:'t',sourceUrl:handoff.source.sourceUrl,title:'本地合成参考',platform:'tiktok',aiAnalysis:{analysisMode:'exact',analysisQuality:'video'}});
  const planning=(await store.list<any>('social_weekly_agent_planning')).items[0];const plan=planning.payload;for(const a of plan.directorAnalyses){a.benchmarkAccountRefs=[];a.benchmarkEvidenceRefs=[];a.benchmarkVideoRefs=[{type:'social_discovery_video',id:handoff.inspirationId,version:1}];}
  await store.update('social_weekly_agent_planning',planning.id,{payload:plan});
  await store.update('starter_social_content_tasks',content.id,{brief});
  const {readWeeklyReferenceSources}=await import('../server/runtime/socialWeeklyReferenceSource.js');const references=await readWeeklyReferenceSources(store,'t',authority,plan.directorAnalyses[0]);
  for(const [index,ref]of references.entries())await store.create('starter_social_task_sources',{tenant_id:'t',task_id:'content',source_id:'reference-'+index,source_kind:'reference_link',source_ref:ref.sourceRef,source_version:ref.sourceVersion,status:'active',label:ref.label,created_at:fixedNow().toISOString()});
  await store.update('starter_social_content_tasks',content.id,{source_count:references.length});
  const {readSocialTaskDetail}=await import('../server/starter198/socialContentRecords.js');const current=await readSocialTaskDetail({repository,tenantId:'t',taskId:'content'});if(!current?.assetSupplyPlan)throw Error('seed_material_plan_missing');
  const {buildWeeklySchedulerMaterialPlanProof}=await import('../server/starter198/socialWeeklySchedulerMaterialPlan.js');
  const persisted=(await store.list<any>('starter_social_content_tasks')).items[0];
  const proof=buildWeeklySchedulerMaterialPlanProof({tenantId:'t',taskId:'content',commandId:'controlled-scheduler',row:persisted,detail:{...current,runId:null},sources:current.sources});if(!proof)throw Error('seed_scheduler_proof_missing');
  await store.update('starter_social_content_tasks',persisted.id,{last_operation_id:'controlled-scheduler',version:proof.scheduledTaskVersion});
  await store.update('workflow_runs','run',{starter_context:{schemaVersion:'starter-social-content.auto-execution.v1',socialTaskId:'content',socialTaskVersion:current.version,sourceRefs:current.sources.map(source=>({id:source.sourceId,version:source.sourceVersion})),packageSelection:current.packageSelection,weeklyMaterialPlan:proof}});
  const now=fixedNow().toISOString();const task:WeeklyExecutionTask={...f.task,status:'queued',resultRefs:[],dependsOnTaskIds:[],upstreamVersionRefs:[],inputSnapshot:{},idempotencyKey:'interview-week-video',budget:{category:'none',limitCny:null},scope:'publication' as any,subjectId:'pub',ownBlockingReasons:[],inheritedBlockingTaskIds:[],attempt:0,maxAttempts:3,nextAttemptAt:null,lease:null,lastError:null,recoveredFromDeadLetterAt:null,cancelReason:null,createdAt:now,updatedAt:now,schedule:{...f.task.schedule,stepKind:'video_generation',responsibleActor:'content_agent',estimatedDurationMinutes:1,estimatedStartAt:now,estimatedFinishAt:now,actualStartedAt:null,actualFinishedAt:null}};
  await store.create('social_weekly_execution_tasks',{id:'weekly-video',tenant_id:'t',task_id:task.taskId,program_id:'p',package_id:'week1',package_version:1,status:'queued',idempotency_key:task.idempotencyKey,created_at:now,payload:task});
  const job=await admitContentExecutionJob({dataStore:store,tenantId:'t',userId:'owner',taskId:'content',runId:'run',taskType:'social_content_weekly',accountId:'account',now:fixedNow()});
  await fs.writeFile(path.join(root,'session.json'),JSON.stringify({jobId:job.id,tenantId:'t',taskId:'video',contentTaskId:'content',runId:'run',mode:'success'}));
  return {jobId:job.id,taskId:task.taskId};
 }finally{await f.cleanup()}
})}
export async function snapshot(){return local(async()=>({weekly:(await store.list<any>('social_weekly_execution_tasks')).items,content:(await store.list<any>('starter_social_content_tasks')).items,jobs:(await store.list<any>('content_execution_jobs')).items,artifacts:(await store.list<any>('starter_social_content_artifacts')).items,files:(await store.list<any>('starter_social_content_files')).items}))}
/** The controlled execute port replaces the production provider in this bounded consumer exercise.
 * It uses real ffmpeg bytes and ORIGINAL file/artifact commands. It is not a supplier-ready LangGraph proof.
 * Never write a fake succeeded flag; the durable queue and weekly complete() validate and settle it.
 */
export async function executeLocal(){return local(async()=>{
 const session=JSON.parse(await fs.readFile(path.join(root,'session.json'),'utf8'));
 const worker=new DurableContentExecutionWorker({dataStore:store,dataAuthority:'local',allowedJobIds:[session.jobId],now:fixedNow,execute:async job=>{
  const sourcePath=path.join(root,'source.mp4'),voicePath=path.join(root,'voice.wav');
  const voiceRender=await runVisualFfmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=6','-y',voicePath]);if(!voiceRender.ok)throw Error('interview_voice_unavailable');
  const prepared=JSON.parse(await fs.readFile(path.join(root,'context.json'),'utf8'));const cache=prepared.context.cache;
  const manifest={jobId:'interview-'+job.runId,spec:{duration:6,width:360,height:640,fps:24},voiceover:{url:voicePath},timeline:cache.scenes.map((scene:any,index:number)=>({sceneId:scene.sceneId,type:'video',url:sourcePath,trimStart:0,trimEnd:3,speed:1,targetStart:index*3,targetEnd:(index+1)*3}))};
  const {composite}=createRequire(import.meta.url)('../desktop/render.cjs');
  const render=await composite(manifest,undefined,path.join(root,'output'));if(!render.ok||!render.outputPath)throw Error('interview_local_render_failed:'+render.error);
  const output=render.outputPath;const bytes=await fs.readFile(output);const stored=await storeSocialContentFile({tenantId:job.tenantId,stream:Readable.from([bytes]),name:'interview-local-output.mp4',mimeType:'video/mp4',declaredLength:bytes.length});
  const file=await registerSocialContentFile({repository,tenantId:job.tenantId,userId:'owner',taskId:job.taskId,usage:'artifact_media',idempotencyKey:'interview-file-'+job.runId,stored,now:fixedNow()});
  const content=JSON.parse(await fs.readFile(path.join(root,'template.json'),'utf8'));
  const {createHash}=await import('node:crypto');const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const sourceSha=hash(await fs.readFile(sourcePath)),voiceSha=hash(await fs.readFile(voicePath));
  const {sceneReworkHash}=await import('../server/starter198/socialContentSceneRework.js');
  content.initialSceneSourceHashes=[...new Map(cache.scenes.map((scene:any)=>[scene.result.asset.id,{role:'asset',id:scene.result.asset.id,source:sourcePath,sha256:sourceSha}])).values(),{role:'voice',id:'voice',source:voicePath,sha256:voiceSha}];
  content.initialSceneCacheInput={planHash:cache.planHash,baselineHash:sceneReworkHash(prepared.context.baseline),manifestHash:sceneReworkHash(manifest),productionSceneIds:cache.scenes.map((scene:any)=>scene.productionSceneId),executionHash:sceneReworkHash(content.assetSupplyExecution)};
  content.mediaStorage={video:{fileId:file.fileId,fileRef:file.fileRef,url:file.downloadUrl,sha256:file.sha256}};
  content.productionWorkspaceSource={runId:job.runId,outputSha256:file.sha256,type:'controlled-local-render'};content.render={completed:true};
  content.productionResult={...content.productionResult,artifactResourceRef:file.fileRef,artifactId:null,technicalReview:{approved:false},creativeReview:{approved:false}};
  const result=await createSocialContentArtifact({repository,tenantId:job.tenantId,userId:'owner',taskId:job.taskId,idempotencyKey:'interview-artifact-'+job.runId,trustedAgentOrigin:true,requireHumanReview:true,now:fixedNow(),value:{kind:'short_video',platform:'tiktok',language:'en',origin:'agent',resourceRef:file.fileRef,content}});
  const {createSocialSceneReworkService}=await import('../server/starter198/socialContentSceneReworkService.js');
  const {sealSocialSceneMediaCache}=await import('../server/starter198/socialContentSceneRework.js');
  const {buildSocialProductionReceipt,persistSocialProductionReceipt}=await import('../server/starter198/socialContentProductionHandoff.js');
  const scenes=[];for(const scene of cache.scenes){const receipt=buildSocialProductionReceipt({handoff:prepared.handoff,productionResult:content.productionResult,gate:'G4',sceneId:scene.productionSceneId,attempt:1,status:'review_required',actor:'content_agent',artifactRefs:[file.fileRef],evidenceRefs:['controlled-local-render-not-human-reviewed'],checks:['format','duration','audio_visual_sync','caption','linked_assets','render','sensitive_data'].map(code=>({code,passed:false,message:'pending human review'}))});await persistSocialProductionReceipt(repository,job.tenantId,receipt);scenes.push({...scene,sha256:sourceSha,result:{...scene.result,asset:{...scene.result.asset,url:sourcePath,localPath:sourcePath}},technicalReceiptId:receipt.receiptId,status:'review_required'});}
  const raw=(await store.list<any>('starter_social_content_artifacts',{where:{tenant_id:'t',artifact_id:result.artifact.artifactId}})).items[0];
  const {recordHash,...baseCache}=cache;const context={...prepared.context,cache:sealSocialSceneMediaCache({...baseCache,parentArtifactId:result.artifact.artifactId,parentArtifactHash:raw.content_hash,scenes,renderInput:{manifest,sourceManifest:manifest,mediaRemap:[],voice:{localPath:voicePath,sha256:voiceSha},bgm:null}})};
  await createSocialSceneReworkService(repository).saveCache(context);
  console.log(JSON.stringify({event:'local_render_registered',jobId:job.id,runId:job.runId,artifactId:result.artifact.artifactId,sha256:file.sha256}));
 }});
 await worker.drain();for(let n=0;n<300;n++){const job=await readContentExecutionJob(store,'t','content','run');if(job&&['succeeded','blocked','retry_wait','reconciling','dead_letter','paused'].includes(job.status)){worker.stop();return job}await new Promise(r=>setTimeout(r,100))}worker.stop();throw Error('interview_render_timeout');
})}
export async function scan(){return local(async()=>{
 const worker=createSocialWeeklyExecutionWorker(store);const claim=await worker.claimNext({tenantId:'t',workerId:'interview-weekly',now:fixedNow(),scope:{tenantId:'t',programId:'p',packageId:'week1',packageVersion:1}});
 if(!claim)return {status:'idle'};
 try{const result=await createSocialWeeklyProductionAdapter(store,{now:fixedNow}).execute(claim.task);console.log(JSON.stringify({event:'weekly_adapter',result}));
 if(result.status==='succeeded')await worker.complete(claim,result.resultRefs,fixedNow());else await worker.defer(claim,{code:result.code,message:result.message,retryDelayMs:1000,blockingReason:result.status==='blocked'?result.code:undefined,now:fixedNow()});return result;
 }catch(error){await worker.fail(claim,{code:'interview_scan_failed',message:error instanceof Error?error.message:String(error),retryable:false,now:fixedNow()});throw error}
})}
