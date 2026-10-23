import {uploadAutomaticMaterialEvidence} from './weeklyAutomaticMaterialProducer.js';
import { KeyedWorkQueue } from './keyedWorkQueue.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readMaterialLibrary, updateAccessibleLocalMaterial, type MaterialRecord } from './materialLibrary.js';
import { getOwnedCloudMaterialRecord, updateCloudMaterial } from './cloudMaterials.js';
import { analyzeProductionMaterial } from '../digitalEmployees/productionMaterialAnalysis.js';
import type { AssetCandidate } from '../digitalEmployees/contentProduction.js';
import { buildMaterialScriptAnalysis, reusableMaterialScriptAnalysis, type MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import { materialThemeTagsOf } from '../../shared/materialTaxonomy.js';
import { materialAssetV2FromRecord } from '../../shared/contracts/materialAssetV2.js';
import { inferMaterialAssetV2, materialDirectorSummary } from '../../shared/imageCreativePlanning.js';
import { buildMaterialCapabilityManifest } from '../../shared/contracts/materialCapabilityManifest.js';
const jobs = new KeyedWorkQueue(2);
export const isMaterialAnalysisActive = (tenantId: string, id: string) => jobs.has(`${tenantId}:${id}`);
export function localMaterialMediaPath(record: MaterialRecord, mediaRoot = path.resolve(process.cwd(), 'data/media')): string {
  const relative = String(record.file || '').trim()
    || (/^\/media\/tenants\/[^?#]+$/.test(String(record.url || '')) ? String(record.url).slice('/media/'.length) : '');
  if (!relative) return '';
  const resolved = path.resolve(mediaRoot, relative);
  if (!resolved.startsWith(mediaRoot + path.sep)) throw Error('素材路径不属于素材目录');
  return resolved;
}
/** Older local imports bypassed the browser upload endpoint. Index them when
 * their owner next opens the library, without blocking the library response. */
export function pendingLocalMaterialAnalysisIds(tenantId: string, records: MaterialRecord[]): string[] {
  return records.filter(record =>
    record.type === 'video'
    && String(record.tenantId || record.tenant_id || '') === tenantId
    && record.scope !== 'shared'
    && record.usage !== 'reference_only'
    && !record.id.startsWith('pb-')
    && !['pending', 'analyzing', 'completed', 'failed'].includes(String(record.segmentAnalysisStatus || ''))
    && !isMaterialAnalysisActive(tenantId, record.id)
  ).map(record => record.id);
}
export function startPendingLocalMaterialAnalyses(tenantId: string, records: MaterialRecord[]): void {
  for (const id of pendingLocalMaterialAnalysisIds(tenantId, records)) {
    void requestMaterialAnalysis(tenantId, id).catch(error =>
      console.warn('[material-analysis] local auto-start failed', error instanceof Error ? error.message : 'failed'));
  }
}
function scriptAnalysisForRecord(record: MaterialRecord, revision: string): MaterialScriptAnalysis | null {
  if (record.segmentAnalysisStatus !== 'completed' || record.analysisSourceRevision !== revision) return null;
  return reusableMaterialScriptAnalysis(record.scriptAnalysis, revision) || buildMaterialScriptAnalysis({
    materialId: record.id,
    name: String(record.name || ''),
    sourceRevision: revision,
    duration: Number(record.duration || 0),
    segments: Array.isArray(record.segments) ? record.segments : [],
    visualObservations: Array.isArray(record.visualObservations) ? record.visualObservations : [],
    analyzedAt: String(record.updatedAt || record.createdAt || '') || undefined,
  });
}
export function libraryCandidate(record: MaterialRecord): AssetCandidate {
  const cloud = record.id.startsWith('pb-');
  const mediaRoot = path.resolve(process.cwd(), 'data/media');
  const local = !cloud ? localMaterialMediaPath(record, mediaRoot) : '';
  return { id: record.id, name: String(record.name || ''), type: record.type, duration: Number(record.duration || 0),
    ...(local && fs.existsSync(local) ? { localPath: local } : {}), ...(record.objectKey ? { objectKey: String(record.objectKey) } : {}),
    ...(cloud ? { cloudRecordId: record.id.slice(3) } : {}), url: String(record.url || ''),
    productId: String(record.productId || ''), productName: String(record.productName || ''),
    observations: Array.isArray(record.visualObservations) ? record.visualObservations : [],
    visualObservations: Array.isArray(record.visualObservations) ? record.visualObservations : [],
    segments: Array.isArray(record.segments) ? record.segments : [],
    scriptAnalysis: scriptAnalysisForRecord(record, analysisFileRevision(record)) || undefined,
    capabilityManifest: buildMaterialCapabilityManifest(record),
    materialV2: materialAssetV2FromRecord(record),
    rightsEvidenceRefs: [record.rightsEvidenceRef, record.licenseEvidence].map(String).filter(Boolean),
    commercialUseApproved: record.commercialUseApproved === true,
    modelInputAllowed: record.modelInputAllowed === true || record.rawLibraryUseApproved === true,
    derivativeUseAllowed: record.derivativeUseAllowed === true || record.derivativesApproved === true,
    tags: String(record.tags || '').split(/[,，]/).map(value => value.trim()).filter(Boolean), synthetic: false,
    authorization: { status: record.scope === 'shared' ? 'licensed' : 'owned', scope: record.scope === 'shared' ? 'shared' : 'tenant', evidence: String(record.licenseEvidence || record.sourceUrl || '租户上传素材') },
    source: record.scope === 'shared' ? 'licensed_shared_material' : 'tenant_material',
  };
}
export function analysisFileRevision(record: MaterialRecord): string {
  const cloud = record.id.startsWith('pb-');
  const localPath = !cloud ? localMaterialMediaPath(record) : '';
  const stat = localPath && fs.existsSync(localPath) ? fs.statSync(localPath) : undefined;
  return crypto.createHash('sha256').update(JSON.stringify([record.id, record.file, record.objectKey, record.sourceRevision || '', stat?.size, stat?.mtimeMs])).digest('hex');
}
async function ownedMaterial(tenantId: string, id: string): Promise<MaterialRecord> {
  const inventory = await readMaterialLibrary(tenantId);
  const record = inventory.items.find(item => item.id === id);
  if (!record) throw Error('素材不存在或不属于当前账号可用素材');
  if (!['video','image'].includes(record.type)) throw Error('请选择视频或图片素材');
  if (id.startsWith('pb-') && !await getOwnedCloudMaterialRecord(id.slice(3), tenantId)) throw Error('素材访问权限已变化');
  return record;
}
async function patch(tenantId: string, id: string, changes: Record<string, unknown>) {
  let ok: boolean;
  if (id.startsWith('pb-') && changes.scriptAnalysis) {
    const cloudId = id.slice(3);
    const raw = await getOwnedCloudMaterialRecord(cloudId, tenantId);
    const rawProvenance = raw?.provenance;
    let provenance: Record<string, unknown> = {};
    if (rawProvenance && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance)) provenance = rawProvenance as Record<string, unknown>;
    else if (typeof rawProvenance === 'string') {
      try { provenance = JSON.parse(rawProvenance) as Record<string, unknown>; } catch { provenance = {}; }
    }
    const { scriptAnalysis, contentSha256: _verifiedHash, ...cloudChanges } = changes;
    ok = await updateCloudMaterial(cloudId, {
      ...cloudChanges,
      provenance: { ...provenance, ...(cloudChanges.provenance&&typeof cloudChanges.provenance==='object'?cloudChanges.provenance:{}), materialScriptAnalysis: scriptAnalysis },
    });
  } else {
    ok = id.startsWith('pb-') ? await updateCloudMaterial(id.slice(3), changes) : updateAccessibleLocalMaterial(id, tenantId, changes);
  }
  if (!ok) throw Error('素材分析结果保存失败，请重试');
}
export async function requestMaterialAnalysis(tenantId: string, id: string, retry = false): Promise<{ status: string; reused: boolean }> {
  const key = `${tenantId}:${id}`;
  if (jobs.has(key)) return { status: 'analyzing', reused: true };
  const record = await ownedMaterial(tenantId, id);
  const revision = analysisFileRevision(record);
  if (!retry && record.segmentAnalysisStatus === 'completed' && record.analysisSourceRevision === revision) {
    const reusable = reusableMaterialScriptAnalysis(record.scriptAnalysis, revision);
    const scriptAnalysis = reusable || buildMaterialScriptAnalysis({
          materialId: id,
          name: String(record.name || ''),
          sourceRevision: revision,
          duration: Number(record.duration || 0),
          segments: Array.isArray(record.segments) ? record.segments : [],
          visualObservations: Array.isArray(record.visualObservations) ? record.visualObservations : [],
        });
    const capabilityManifest = buildMaterialCapabilityManifest({
      ...record, scriptAnalysis, analysisSourceRevision: revision, segmentAnalysisStatus: 'completed',
    });
    const storedManifest = record.provenance?.materialCapabilityManifest;
    if (!reusable || JSON.stringify(storedManifest || null) !== JSON.stringify(capabilityManifest)) await patch(tenantId, id, {
      scriptAnalysis,
      provenance: { ...(record.provenance || {}), materialCapabilityManifest: capabilityManifest },
    });
    return { status: 'completed', reused: true };
  }
  // Check again after the awaited ownership lookup, before reserving this job.
  if (jobs.has(key)) return { status: 'analyzing', reused: true };
  const created = await jobs.enqueue(key,
    () => patch(tenantId, id, { segmentAnalysisStatus: 'pending', segmentAnalysisError: '' }),
    async () => {
    try {
      await patch(tenantId, id, { segmentAnalysisStatus: 'analyzing', segmentAnalysisError: '' });
      const result = await analyzeProductionMaterial(libraryCandidate(record), tenantId, true);
      const current = await ownedMaterial(tenantId, id);
      if (analysisFileRevision(current) !== revision) throw Error('素材文件已变化，请重新分析当前版本');
      const scriptAnalysis = buildMaterialScriptAnalysis({
        materialId: id,
        name: String(record.name || ''),
        sourceRevision: revision,
        duration: result.duration,
        segments: result.segments,
        visualObservations: result.observations,
      });
      const automaticVisual=result.automaticVisual;
      if(automaticVisual&&current.contentSha256&&current.contentSha256!==automaticVisual.sha256)throw Error('素材字节版本与实际分析不一致');
      const automaticEvidence=automaticVisual?uploadAutomaticMaterialEvidence({...automaticVisual,commercialUseApproved:current.commercialUseApproved===true,rightsEvidenceRef:String(current.licenseEvidence||''),authorizationScopes:Array.isArray(current.provenance?.authorizationScopes)?current.provenance.authorizationScopes:current.commercialUseApproved===true&&current.derivativesApproved===true?['enterprise-video']:[]}):[];
      const themeTags = materialThemeTagsOf({ name: record.name, segments: result.segments, visualObservations: result.observations, scriptAnalysis });
      const currentProvenance = current.provenance && typeof current.provenance === 'object' ? current.provenance : {};
      const userMetadata = currentProvenance.materialAssetV2Source === 'user'
        ? materialAssetV2FromRecord(current as Record<string, unknown>)
        : null;
      const materialV2 = userMetadata || inferMaterialAssetV2({
        type: String(current.type || record.type || ''),
        name: String(current.name || record.name || ''),
        folder: String(current.folder || record.folder || ''),
        tags: String(current.tags || record.tags || ''),
        productId: String(current.productId || ''),
        productName: String(current.productName || ''),
        identityAuthority: /^ai(?:_|-)|generated/i.test(String(current.sourceType || '')) ? 'derived' : 'source',
        enterpriseCommon: current.enterpriseCommon === true,
        visualObservations: result.observations,
        sourceRevision: revision,
      });
      const directorAnalysis = materialDirectorSummary(materialV2, String(current.productName || ''));
      const analyzedAt = new Date().toISOString();
      const capabilityManifest = buildMaterialCapabilityManifest({
        ...current,
        ...(automaticVisual ? { contentSha256: automaticVisual.sha256 } : {}),
        duration: result.duration,
        segments: result.segments,
        visualObservations: result.observations,
        scriptAnalysis,
        materialV2,
        themeTags,
        segmentAnalysisStatus: 'completed',
        analysisSourceRevision: revision,
        provenance: { ...currentProvenance, materialAssetV2: materialV2 },
      });
      await patch(tenantId, id, { ...(automaticVisual?{contentSha256:automaticVisual.sha256}:{}),provenance:{
        ...currentProvenance,
        weeklyAutomaticMaterialEvidence:automaticEvidence,
        materialAssetV2: materialV2,
        materialAssetV2Source: userMetadata ? 'user' : 'director_model',
        materialDirectorAnalysis: {
          schemaVersion: 'material-director.v1',
          analyzedAt,
          sourceRevision: revision,
          ...directorAnalysis,
        },
        materialCapabilityManifest: capabilityManifest,
      },duration: result.duration, segments: result.segments, visualObservations: result.observations, scriptAnalysis,
        themeTags, primaryTheme: themeTags[0] || '', classificationStatus: themeTags.length ? 'completed' : 'review_required',
        classificationSource: 'model', classificationEvidence: result.observations.slice(0, 8),
        segmentAnalysisStatus: 'completed', segmentAnalysisError: '', analysisSourceRevision: revision });
    } catch (error) {
      await patch(tenantId, id, { segmentAnalysisStatus: 'failed', segmentAnalysisError: materialAnalysisError(error) });
    }
  }, error => console.warn('[material-analysis]', error instanceof Error ? error.message : 'failed'));
  return { status: 'pending', reused: !created };
}
export async function saveMaterialSegmentsWithScriptAnalysis(
  tenantId: string,
  record: MaterialRecord,
  segments: Array<Record<string, unknown>>,
): Promise<MaterialScriptAnalysis> {
  const revision = analysisFileRevision(record);
  const scriptAnalysis = buildMaterialScriptAnalysis({
    materialId: record.id,
    name: String(record.name || ''),
    sourceRevision: revision,
    duration: Number(record.duration || 0),
    segments,
    visualObservations: Array.isArray(record.visualObservations) ? record.visualObservations : [],
  });
  const capabilityManifest = buildMaterialCapabilityManifest({
    ...record, segments, scriptAnalysis, analysisSourceRevision: revision, segmentAnalysisStatus: 'completed',
  });
  await patch(tenantId, record.id, {
    segments, scriptAnalysis, analysisSourceRevision: revision,
    provenance: { ...(record.provenance || {}), materialCapabilityManifest: capabilityManifest },
  });
  return scriptAnalysis;
}
export async function waitForMaterialAnalysis(tenantId: string, id: string) {
  await requestMaterialAnalysis(tenantId, id);
  await jobs.get(`${tenantId}:${id}`);
  const record = await ownedMaterial(tenantId, id);
  if (record.segmentAnalysisStatus !== 'completed') throw Error(String(record.segmentAnalysisError || '素材分析未完成'));
  return record;
}

export function materialAnalysisError(error: unknown): string {
  const message = error instanceof Error ? error.message : '素材分析失败';
  if (/timeout|timed out|abort/i.test(message)) return '视觉分析服务响应超时，请稍后重试；已上传的原片仍保存在素材库';
  if (/connection error|fetch failed|ECONN/i.test(message)) return '视觉分析服务连接失败，请稍后重试；素材文件未丢失';
  if (/429|rate.limit/i.test(message)) return '视觉分析服务繁忙，请稍后重试';
  if (/401|403|api.key/i.test(message)) return '视觉分析服务配置异常，请联系管理员检查服务凭据';
  return message.replace(/^production_input_required:/, '').slice(0,500);
}
