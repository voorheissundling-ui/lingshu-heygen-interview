import { createHash } from 'node:crypto';
import { applyStoryboardReplicationAutomation, automaticManagedFallbackFrameAdmission, automaticManagedFallbackVideoAdmission, automaticStoryboardFrameAdmission, type StoryboardQaReport } from './storyboardAigcQuality.js';
import { storyboardProjectShotInput } from './storyboardProjectShotInput.js';
import type { StoryboardShotSpec } from '../../shared/storyboardShotSpec.js';
import { CONTROLLED_PRODUCT_FRAME_SOURCE, CONTROLLED_PRODUCT_VIDEO_SOURCE } from './controlledProductImageAnimation.js';

interface AssignmentMaterial {
  id: string;
  tenantId?: string;
  type: string;
  sourceType?: string;
  provenance?: Record<string, unknown>;
}

interface AssignmentSpec {
  storyboardAssignments?: Record<string, unknown>;
  storyboardAssemblies?: Array<{ id?: string; assignments?: Record<string, unknown>; sourcePlans?: Record<string, unknown> }>;
  selectedProductIds?: string[];
  [key: string]: unknown;
}

/** Re-read only products actually used by an assigned AIGC video. The reader
 * must resolve IDs from this tenant's current KB record, then return the image
 * bytes encoded as base64 (the same representation fingerprinted at creation).
 * A null result fails closed when an asset was deleted or became unreadable. */
export async function storyboardAigcCurrentKbIssues(input: {
  spec: AssignmentSpec;
  materials: AssignmentMaterial[];
  readCurrentProductImage: (productId: string) => Promise<string | null>;
}): Promise<string[]> {
  const byId = new Map(input.materials.map(item => [item.id, item]));
  const assignments = [input.spec.storyboardAssignments,
    ...(input.spec.storyboardAssemblies || []).map(item => item.assignments)];
  const expectedByProduct = new Map<string, Set<string>>();
  for (const set of assignments) {
    for (const rawId of Object.values(set || {})) {
      const video = byId.get(String(rawId || ''));
      if (video?.provenance?.storyboardAigc !== true) continue;
      const frame = byId.get(String(video.provenance.firstFrameMaterialId || ''));
      const frameSpec = frame?.provenance?.shotSpec as StoryboardShotSpec | undefined;
      for (const asset of frameSpec?.assets || []) {
        if (asset.role !== 'product' || asset.source !== 'knowledge_base') continue;
        const versions = expectedByProduct.get(asset.id) || new Set<string>();
        versions.add(asset.version);
        expectedByProduct.set(asset.id, versions);
      }
    }
  }
  if (!expectedByProduct.size) return [];
  const selected = new Set(Array.isArray(input.spec.selectedProductIds) ? input.spec.selectedProductIds.map(String) : []);
  const issues: string[] = [];
  await Promise.all([...expectedByProduct].map(async ([productId, versions]) => {
    if (!selected.has(productId)) {
      issues.push(`本片不再选择产品 ${productId}，相关 AI 候选需重新生成`);
      return;
    }
    let current: string | null = null;
    try { current = await input.readCurrentProductImage(productId); }
    catch { /* KB read failure must not validate a stale candidate. */ }
    if (!current) {
      issues.push(`企业知识库产品 ${productId} 的当前图片无法读取`);
      return;
    }
    const hash = createHash('sha256').update(current).digest('hex');
    if (!versions.has(hash) || versions.size !== 1)
      issues.push(`企业知识库产品 ${productId} 的图片已变化，相关 AI 候选需重新生成`);
  }));
  return issues.sort();
}

function productAssets(spec: StoryboardShotSpec | undefined): string[] {
  return (spec?.assets || []).filter(item => item.role === 'product' && item.source === 'knowledge_base')
    .map(item => `${item.id}:${item.version}`).sort();
}

/** Server-owned evidence for assigning a generated storyboard candidate. */
export function storyboardAigcAssignmentIssues(input: {
  tenantId: string;
  projectId: string;
  spec: AssignmentSpec;
  materials: AssignmentMaterial[];
}): string[] {
  const materials = new Map(input.materials.map(item => [item.id, item]));
  const issues: string[] = [];
  const assignmentSets = [{ assignments: input.spec.storyboardAssignments, spec: input.spec },
    ...(input.spec.storyboardAssemblies || []).map(item => ({ assignments: item.assignments,
      spec: { ...input.spec, activeAssemblyId: item.id || '', storyboardSourcePlans: item.sourcePlans || input.spec.storyboardSourcePlans } }))];
  for (const { assignments, spec } of assignmentSets) {
    if (!assignments || typeof assignments !== 'object') continue;
    for (const [shotId, rawMaterialId] of Object.entries(assignments)) {
      const materialId = String(rawMaterialId || '');
      const material = materials.get(materialId);
      if (!material || material.provenance?.storyboardAigc !== true) continue;
      const provenance = material.provenance;
      const storedQuality = provenance.storyboardQualityReport as StoryboardQaReport | undefined;
      const firstFrame = materials.get(String(provenance.firstFrameMaterialId || ''));
      const currentShot = storyboardProjectShotInput(spec as Record<string, any>, shotId);
      const frameSpec = firstFrame?.provenance?.shotSpec as StoryboardShotSpec | undefined;
      const videoSpec = provenance.shotSpec as StoryboardShotSpec | undefined;
      const automaticReplication = frameSpec?.mode === 'replication' && !frameSpec.constraints.includes('person_identity');
      const currentSourcePlan = (spec as Record<string, any>).storyboardSourcePlans?.[shotId] as Record<string, any> | undefined;
      const automaticFallback = automaticManagedFallbackFrameAdmission(firstFrame?.provenance as Record<string, any> | undefined, currentSourcePlan)
        && automaticManagedFallbackVideoAdmission(provenance as Record<string, any>, currentSourcePlan);
      const automaticAdmission = automaticReplication || automaticFallback;
      const quality = automaticAdmission && storedQuality ? applyStoryboardReplicationAutomation(storedQuality) : storedQuality;
      const storedFrameQuality = firstFrame?.provenance?.firstFrameQuality as StoryboardQaReport | undefined;
      const frameQuality = automaticAdmission && storedFrameQuality ? applyStoryboardReplicationAutomation(storedFrameQuality) : storedFrameQuality;
      const controlledProductAnimation = provenance.controlledProductImageAnimation === true;
      const validVideoSource = controlledProductAnimation
        ? material.sourceType === CONTROLLED_PRODUCT_VIDEO_SOURCE
        : material.sourceType === 'ai-seedance';
      const validFrameSource = controlledProductAnimation
        ? firstFrame?.sourceType === CONTROLLED_PRODUCT_FRAME_SOURCE
        : firstFrame?.sourceType === 'ai-storyboard-first-frame';
      const valid = material.tenantId === input.tenantId
        && material.type === 'video'
        && validVideoSource
        && !!input.projectId
        && provenance.projectId === input.projectId
        && provenance.shotId === shotId
        && !!currentShot
        && firstFrame?.provenance?.projectShotFingerprint === currentShot.fingerprint
        && quality?.phase === 'video'
        && quality.passed === true
        && quality.status === 'passed'
        && (quality.reviewDecision === 'accept' || automaticAdmission && quality.acceptanceSource === 'automatic_policy')
        && !!quality.reportId
        && firstFrame?.tenantId === input.tenantId
        && validFrameSource
        && firstFrame.provenance?.projectId === input.projectId
        && firstFrame.provenance?.shotId === shotId
        && firstFrame.provenance?.fingerprint === provenance.firstFrameFingerprint
        && (firstFrame.provenance?.confirmed === true || automaticStoryboardFrameAdmission(firstFrame.provenance)
          || automaticManagedFallbackFrameAdmission(firstFrame.provenance as Record<string, any>, currentSourcePlan))
        && frameQuality?.phase === 'first_frame'
        && frameQuality?.passed === true
        && frameQuality?.status === 'passed'
        && (frameQuality?.reviewDecision === 'accept' || automaticAdmission && frameQuality?.acceptanceSource === 'automatic_policy')
        && !!frameSpec && !!videoSpec
        && JSON.stringify(frameSpec) === JSON.stringify(videoSpec)
        && JSON.stringify(productAssets(frameSpec)) === JSON.stringify(productAssets(videoSpec))
        && JSON.stringify((firstFrame.provenance?.productIds as string[] | undefined) || [])
          === JSON.stringify(frameSpec.assets.filter(asset => asset.role === 'product').map(asset => asset.id));
      if (!valid) issues.push(`分镜 ${shotId} 的 AI 视频候选 ${materialId} 未通过当前项目的首帧和视频验收`);
    }
  }
  return [...new Set(issues)];
}
