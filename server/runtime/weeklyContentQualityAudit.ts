import type { DataStore, Record_ } from '../storage/datastore.js';
import {weeklyProductionEvidenceTask} from './weeklyContentProductionIdentity.js';
import type { WeeklyExecutionTask, VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from '../socialPrograms/service.js';
import { socialObject, socialJson, socialRequestHash } from '../starter198/socialContentValidation.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { resolveSceneCacheSourceRun } from '../starter198/socialContentSceneCacheSource.js';
import { createSocialSceneReworkService } from '../starter198/socialContentSceneReworkService.js';
import { hasKnownFinalMediaCoverageFailure } from '../starter198/socialFinalPrivacyCoverage.js';
import { hasKnownCaptionMaskFailure } from '../starter198/socialCaptionMaskFrameAudit.js';
import { hasKnownFinalSensitiveFrameFailure } from '../starter198/socialFinalSensitiveFrameAudit.js';
function requireAudit(value:unknown,code:string):asserts value{if(!value)throw new SocialProgramError(code,409,'本次成片缺少同源、最新且可核验的质量审核证据。');}
const object=(value:unknown)=>socialObject(socialJson(value))??{};
export function assertWeeklyQualityRunLineage(content:Record<string,unknown>,sourceRunId:unknown,qualityRunId:string):void{
 if(content.workflowSchema!=='social-content.auto-production.v3')return;
 const workspace=object(content.productionWorkspaceSource);
 requireAudit(workspace.runId===qualityRunId&&(!content.sceneRework?sourceRunId===qualityRunId:true),'weekly_quality_audit_run_lineage_changed');
}
async function unique(store:DataStore,collection:string,where:Record<string,string>){const rows=await store.list<Record_>(collection,{where,perPage:2});requireAudit(rows.totalItems===1&&rows.items.length===1,'weekly_quality_audit_source_ambiguous');const row=rows.items[0]!;requireAudit(Object.entries(where).every(([k,v])=>row[k]===v),'weekly_quality_audit_scope_changed');return row;}
/** Detect actual frozen detector failures separately from immutable pending-review summaries. */
export function assertNoFrozenTechnicalFailure(content:Record<string,unknown>){
 // Current graph-produced films must carry their own measured initial report.
 // A later G4/G5 checkbox cannot manufacture missing technical observations.
 if(content.technicalQualityReport==null){
  requireAudit(content.workflowSchema!=='social-content.auto-production.v3','weekly_quality_audit_detector_report_unverified');
  return;
 }
 const report=object(content.technicalQualityReport);
 requireAudit(report.schemaVersion==='initial-scene-quality.v1','weekly_quality_audit_detector_report_unverified');
 const visual=object(report.visual),audio=object(report.audio),scenes=object(report.scenes);
 const probe=object(report.mediaHardProbe),validProbe=probe.version==='scene-media-hard-probe.v1';
 const knownFormatFailure=validProbe&&(probe.formatPassed===false||probe.container==='unknown'||(typeof probe.videoCodec==='string'&&probe.videoCodec!=='h264')||(typeof probe.audioCodec==='string'&&probe.audioCodec!=='aac'));
 const knownCaptionSpeechFailure=validProbe&&object(probe.captionSpeechAlignment).status==='mismatch';
 const knownSensitiveSpeechHit=validProbe&&object(probe.sensitiveFrozenSpeechEvidence).status==='hit';
 const knownFinalMediaFailure=validProbe&&hasKnownFinalMediaCoverageFailure(probe.finalPrivacyCoverage);
 const knownCaptionMaskFailure=validProbe&&hasKnownCaptionMaskFailure(probe.captionMaskAudit);
 const knownFullAudioFailure=validProbe&&object(probe.fullFrozenAudioIdentity).status==='failed';
 const knownFullFrameSensitiveFailure=validProbe&&hasKnownFinalSensitiveFrameFailure(probe.finalSensitiveFrameAudit,probe.mediaSha256);
 const knownSceneFailure=validProbe&&Array.isArray(probe.scenes)&&probe.scenes.some(raw=>{const scene=object(raw);return scene.durationPassed===false||scene.audioWindowDecoded===false||object(scene.audioIdentity).status==='failed'||object(scene.sensitiveScreenEvidence).status==='hit';});
 // Preserve an actual detector failure even when the rest of its report is incomplete.
 requireAudit(visual.passed!==false&&audio.ok!==false&&scenes.passed!==false&&!knownFormatFailure&&!knownCaptionSpeechFailure&&!knownSensitiveSpeechHit&&!knownFinalMediaFailure&&!knownCaptionMaskFailure&&!knownFullAudioFailure&&!knownFullFrameSensitiveFailure&&!knownSceneFailure&&(!Array.isArray(scenes.issues)||scenes.issues.length===0)&&(!Array.isArray(visual.failures)||visual.failures.length===0),'weekly_quality_audit_actual_repair_required');
 // Missing/unknown detector fields are not a passing report. G4 human checkboxes
 // cannot repair a truncated detector receipt or replace actual media inspection.
 requireAudit(visual.passed===true&&audio.ok===true&&audio.error===null&&scenes.passed===true&&Array.isArray(visual.failures)&&Array.isArray(scenes.issues)&&Number.isSafeInteger(scenes.checkedScenes)&&Number(scenes.checkedScenes)>0,'weekly_quality_audit_detector_report_unverified');
}
/** Server-read context only. A pending immutable boolean is never itself a passing receipt. */
export async function readWeeklyContentQualityAuditContext(store:DataStore,task:WeeklyExecutionTask,ref:VersionedSocialRef){
 task=await weeklyProductionEvidenceTask(store,task);
 requireAudit(task.workflowKind==='content'&&['quality_check','rework'].includes(task.schedule.stepKind)&&ref.type==='starter_social_content_artifact'&&Number.isSafeInteger(ref.version)&&ref.version>0,'weekly_quality_audit_not_applicable');
 const artifact=await unique(store,'starter_social_content_artifacts',{tenant_id:task.tenantId,artifact_id:ref.id});const content=object(artifact.content);
 requireAudit(Number(String(artifact.version).replace(/^v/,''))===ref.version&&['draft','review_required','approved'].includes(String(artifact.status))&&artifact.artifact_kind==='short_video'&&artifact.origin==='agent'&&content.render&&object(content.render).completed===true,'weekly_quality_audit_artifact_invalid');
 requireAudit(artifact.content_hash===socialRequestHash({resourceRef:artifact.resource_ref,content}),'weekly_quality_audit_artifact_changed');
 const source=await unique(store,'starter_social_content_tasks',{tenant_id:task.tenantId,task_id:String(artifact.task_id)});
 requireAudit(source.create_idempotency_key===`weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`&&object(source.brief).programRef&&object(object(source.brief).programRef).id===task.programId,'weekly_quality_audit_weekly_binding_changed');
 requireAudit(!['cancelled','paused','attention','needs_input'].includes(String(source.status)),'weekly_quality_audit_source_stopped');
 assertNoFrozenTechnicalFailure(content);
 const repository=createStarter198Repository(store);const scope={tenantId:task.tenantId,taskId:String(artifact.task_id),parentArtifactId:ref.id};
 const runId=await resolveSceneCacheSourceRun(repository,scope);const run=await store.getById<Record_>('workflow_runs',runId);
 requireAudit(run?.tenant_id===task.tenantId&&!['cancelled','failed','dead_letter'].includes(String(run.status)),'weekly_quality_audit_run_stopped');
 // The original weekly film cannot borrow G4/G5 from another run of the same
 // content task. A legitimate scene-rework child has its own explicit lineage.
 assertWeeklyQualityRunLineage(content,source.run_id,runId);
 // This validates physical full-output, clip and audio bytes, immutable lineage, and latest G4 receipts.
 const context=await createSocialSceneReworkService(repository).readCache({...scope,runId});
 if(content.technicalQualityReport!=null)requireAudit(object(object(content.technicalQualityReport).scenes).checkedScenes===context.cache.scenes.length,'weekly_quality_audit_detector_scene_count_changed');
 requireAudit(context.cache.parentArtifactHash===artifact.content_hash&&context.cache.scenes.length>0&&context.cache.scenes.every(scene=>scene.status==='passed'),'weekly_quality_audit_g4_pending');
 const productionResult=object(content.productionResult);requireAudit(typeof productionResult.productionResultId==='string'&&!!productionResult.productionResultId,'weekly_quality_audit_production_missing');
 return {repository,artifact,content,context,scope:{tenantId:task.tenantId,taskId:String(artifact.task_id),runId,artifactId:ref.id}};
}
/** Explicit review route. G4 never substitutes for the independent director G5 review. */
export async function readVerifiedWeeklyContentQualityAudit(store:DataStore,task:WeeklyExecutionTask,artifactRef:VersionedSocialRef){
 const live=await readWeeklyContentQualityAuditContext(store,task,artifactRef);
 const {assertSocialDirectorG5Audit}=await import('../starter198/socialDirectorG5ReviewService.js');
 const audit=await assertSocialDirectorG5Audit(live.repository,{...live.scope,artifactHash:String(live.artifact.content_hash)});
 const result=object(live.content.productionResult),receipt=audit.receipt;
 requireAudit(receipt.gate==='G5'&&receipt.status==='passed'&&['director_agent','human_director_reviewer'].includes(receipt.actor)&&receipt.handoffId===live.context.handoffId&&receipt.handoffVersion===live.context.handoffVersion&&receipt.productionResultRef.id===result.productionResultId&&receipt.productionResultRef.version===result.version&&receipt.productionResultRef.recordHash===socialRequestHash(result)&&receipt.artifactRefs.includes(String(live.artifact.resource_ref)),'weekly_quality_audit_g5_source_changed');
 return {reviewId:audit.review.reviewId,reviewHash:audit.review.recordHash,receiptId:receipt.receiptId,receiptHash:receipt.recordHash,sourceHash:audit.sourceHash};
}
/** The artifact remains immutable and still requires the separate final user approval. */
export async function assertWeeklyContentQualityAudit(store:DataStore,task:WeeklyExecutionTask,artifactRef:VersionedSocialRef):Promise<void>{await readVerifiedWeeklyContentQualityAudit(store,task,artifactRef);}
