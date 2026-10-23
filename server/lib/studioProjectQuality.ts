import { createHash } from 'node:crypto';

export type StudioProjectQualityRecord = {
  id: string;
  inputFingerprint: string;
  generationProvenance: 'ai';
  qualityStatus: 'passed';
  publishable: true;
  createdAt: string;
  createdBy: string;
  projectRevision: string;
  renderPath: string;
  report: { gateVersion: 'studio-project-quality-v1'; checks: Array<{ id: string; passed: true; detail: string }> };
};

function objectValue(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  return {};
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Inputs that can change the meaning or pixels of a delivered video. Records,
 * UI navigation and timestamps are deliberately excluded. */
export function studioProjectQualityInput(specValue: unknown): Record<string, unknown> {
  const spec = objectValue(specValue);
  return {
    creationPath: spec.creationPath,
    contentMode: spec.contentMode,
    script: spec.script,
    storyboardAssignments: spec.storyboardAssignments,
    storyboardSourcePlans: spec.storyboardSourcePlans,
    storyboardAssemblies: spec.storyboardAssemblies,
    shootingSlots: spec.shootingSlots,
    shotProductions: spec.shotProductions,
    materialSnapshots: spec.materialSnapshots,
    clipEdits: spec.clipEdits,
    voiceoverMode: spec.voiceoverMode,
    voiceoverUrl: spec.voiceoverUrl,
    voiceoverAudios: spec.voiceoverAudios,
    voiceDrafts: spec.voiceDrafts,
    alignedCuesByLang: spec.alignedCuesByLang,
    subtitlesOn: spec.subtitlesOn,
    subMode: spec.subMode,
    subtitleStyle: spec.subtitleStyle,
    bgm: spec.bgm,
    assemblyBgms: spec.assemblyBgms,
    materialVersionBgms: spec.materialVersionBgms,
    bgmVol: spec.bgmVol,
    voiceVol: spec.voiceVol,
    effectPreset: spec.effectPreset,
    effectIntensity: spec.effectIntensity,
    effectSoundsOn: spec.effectSoundsOn,
    disabledEffectSceneIds: spec.disabledEffectSceneIds,
    ratio: spec.ratio,
    languageRenderOutputs: spec.languageRenderOutputs,
    languageRenderVersions: spec.languageRenderVersions,
    renderAcceptance: spec.renderAcceptance,
  };
}

export function studioProjectQualityFingerprint(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(studioProjectQualityInput(spec)))).digest('hex');
}

export function currentStudioProjectQualityRecord(specValue: unknown): StudioProjectQualityRecord | null {
  const spec = objectValue(specValue);
  const activeId = String(spec.activeProjectQualityRecordId || '').trim();
  const records = Array.isArray(spec.projectQualityRecords) ? spec.projectQualityRecords.map(objectValue) : [];
  const record = records.find(item => String(item.id || '') === activeId);
  if (!record || record.inputFingerprint !== studioProjectQualityFingerprint(spec)
    || record.generationProvenance !== 'ai' || record.qualityStatus !== 'passed' || record.publishable !== true) return null;
  return record as StudioProjectQualityRecord;
}

export function studioProjectQualityIssues(specValue: unknown): string[] {
  const spec = objectValue(specValue);
  const acceptance = objectValue(spec.renderAcceptance);
  const renderPath = String(acceptance.renderPath || '').trim();
  const assignments = objectValue(spec.storyboardAssignments);
  const slots = Array.isArray(objectValue(objectValue(spec.analysisResults).storyboard).slots)
    ? objectValue(objectValue(spec.analysisResults).storyboard).slots as unknown[] : [];
  const issues: string[] = [];
  if (spec.contentMode !== 'video') issues.push('当前项目不是视频项目');
  if (!String(spec.creationPath || '').trim()) issues.push('缺少创作模式');
  if (!slots.length && !Object.keys(assignments).length) issues.push('缺少分镜');
  if (slots.some(slot => !assignments[String(objectValue(slot).id || '')])) issues.push('仍有分镜未绑定素材');
  if (acceptance.accepted !== true || !renderPath) issues.push('当前正式成片尚未完成人工验收');
  const renderPaths = Object.values(objectValue(spec.languageRenderOutputs)).map(item => String(objectValue(item).path || ''));
  const versionPaths = Object.values(objectValue(spec.languageRenderVersions)).flatMap(value => Array.isArray(value)
    ? value.map(item => String(objectValue(item).path || '')) : []);
  if (renderPath && ![...renderPaths, ...versionPaths].includes(renderPath)) issues.push('验收成片不是当前项目的正式渲染结果');
  if (spec.voiceoverMode !== 'none' && !String(spec.voiceoverUrl || '').trim()
    && !Object.values(objectValue(spec.voiceoverAudios)).some(item => String(objectValue(item).url || '').trim())) issues.push('口播模式已启用但缺少有效配音');
  if (spec.subtitlesOn === true && !Object.values(objectValue(spec.alignedCuesByLang)).some(value => Array.isArray(value) && value.length)) issues.push('字幕已启用但缺少对齐字幕');
  return [...new Set(issues)];
}
