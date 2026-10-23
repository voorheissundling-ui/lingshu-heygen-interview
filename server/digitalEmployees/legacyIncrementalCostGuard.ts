/** Legacy media providers do not yet share an all-provider per-order charge
 * ledger. A user's reservation is not a verified upstream quote or spend cap. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {currentStudioProjectQualityRecord,studioProjectQualityIssues} from '../lib/studioProjectQuality.js';
import {socialJson,socialObject} from '../starter198/socialContentValidation.js';
export const LEGACY_INCREMENTAL_COST_BLOCKER='新增内容尚未取得可核验的费用报价，未发起付费生成。';
export function legacyIncrementalCostBlocker(value:unknown):string{
 if(!value||typeof value!=='object'||Array.isArray(value))return '';
 const order=value as Record<string,unknown>;
 return order.assistantAdmission===true?LEGACY_INCREMENTAL_COST_BLOCKER:'';
}

/** Observes existing manual workbench receipts only. It never generates media,
 * clears cost authority, or treats a path/`passed` boolean as sufficient. */
export async function readLegacyManualCompletion(store:DataStore,tenantId:string,project:Record_){
 const spec=socialObject(socialJson(project.spec))??{},order=socialObject(spec.contentOrder);
 if(project.tenant_id!==tenantId||!legacyIncrementalCostBlocker(order))return null;
 const quality=currentStudioProjectQualityRecord(spec),manual=socialObject(spec.manualRenderJob);
 if(!quality||studioProjectQualityIssues(spec).length||quality.report?.gateVersion!=='studio-project-quality-v1'||!['storyboard_materials','voice_subtitles','render_acceptance','input_fingerprint'].every(id=>quality.report.checks.some(check=>check.id===id&&check.passed===true))||!manual?.id||manual.status!=='completed')return null;
 const job=await store.getById<Record_>('studio_render_jobs',String(manual.id));
 if(!job||job.tenant_id!==tenantId||job.project_id!==project.id||job.status!=='completed'||job.output_path!==quality.renderPath||manual.outputPath!==quality.renderPath||!job.input_signature||manual.inputSignature!==job.input_signature)return null;
 const outputs=socialObject(spec.languageRenderOutputs)??{},output=socialObject(outputs[String(job.output_key)]);
 if(!output||output.status!=='done'||output.path!==quality.renderPath||output.inputSignature!==job.input_signature)return null;
 try{const root=await fs.realpath(path.resolve(process.cwd(),'data/publishing-uploads',tenantId.replace(/[^\w.-]+/g,'-'))),file=await fs.realpath(quality.renderPath);if(!file.startsWith(root+path.sep)||path.extname(file).toLowerCase()!=='.mp4')return null;const stat=await fs.stat(file);if(!stat.isFile()||stat.size<32||stat.size>256*1024*1024)return null;const bytes=await fs.readFile(file);if(bytes.subarray(4,8).toString()!=='ftyp')return null;return {jobId:job.id,qualityRecordId:quality.id,inputFingerprint:quality.inputFingerprint,outputPath:file,sha256:createHash('sha256').update(bytes).digest('hex'),outputBytes:bytes.length,verifiedAt:new Date().toISOString()};}catch{return null;}
}
