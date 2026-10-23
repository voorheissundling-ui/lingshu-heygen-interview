import { currentStudioProjectQualityRecord } from './studioProjectQuality.js';

export type StudioGenerationKind = 'script' | 'poster';

export type StudioGenerationMetadata = {
  generationKind: StudioGenerationKind;
  generationProvenance: 'ai';
  qualityStatus: 'passed';
  publishable: true;
  generationRecordId: string;
};

export type StudioGenerationVerification =
  | { ok: true; metadata: StudioGenerationMetadata }
  | { ok: false; code: string; message: string };

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* malformed project data is not publishable */ }
  }
  return {};
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordIsPublishable(value: Record<string, unknown>): boolean {
  return cleanText(value.generationProvenance || value.generationSource || value.provenance || value.source).toLowerCase() === 'ai'
    && cleanText(value.qualityStatus).toLowerCase() === 'passed'
    && value.publishable === true;
}

export function claimedStudioGeneration(value: unknown): StudioGenerationMetadata | null {
  const record = objectValue(value);
  const generationKind = cleanText(record.generationKind);
  const generationRecordId = cleanText(record.generationRecordId);
  if ((generationKind !== 'script' && generationKind !== 'poster') || !generationRecordId) return null;
  if (cleanText(record.generationProvenance).toLowerCase() !== 'ai'
    || cleanText(record.qualityStatus).toLowerCase() !== 'passed'
    || record.publishable !== true) return null;
  return {
    generationKind,
    generationProvenance: 'ai',
    qualityStatus: 'passed',
    publishable: true,
    generationRecordId,
  };
}

export function verifiedStudioGenerationFromSpec(
  specValue: unknown,
  claimValue: unknown,
): StudioGenerationVerification {
  const spec = objectValue(specValue);
  const claim = claimedStudioGeneration(claimValue);
  if (!claim) {
    return {
      ok: false,
      code: 'studio_generation_metadata_invalid',
      message: '当前作品缺少可验证的 AI 来源、质量或可发布记录，请返回内容创作重新审核。',
    };
  }

  if (claim.generationKind === 'poster') {
    const poster = objectValue(spec.posterDraft);
    if (claim.generationRecordId !== 'poster-current'
      || !cleanText(spec.posterJsonText)
      || !recordIsPublishable(poster)
      || (Array.isArray(poster.fieldsToConfirm) && poster.fieldsToConfirm.length > 0)) {
      return {
        ok: false,
        code: 'studio_generation_record_stale',
        message: '当前图文已变化或尚未通过企业资料校验，不能提交审核或发布。',
      };
    }
    return { ok: true, metadata: claim };
  }

  const projectRecord = currentStudioProjectQualityRecord(spec);
  if (projectRecord && projectRecord.id === claim.generationRecordId) return { ok: true, metadata: claim };

  const currentScript = cleanText(spec.script);
  const scripts = Array.isArray(spec.modeScripts) ? spec.modeScripts.map(objectValue) : [];
  const record = scripts.find(item => cleanText(item.id) === claim.generationRecordId);
  if (!currentScript || !record || cleanText(record.script) !== currentScript || !recordIsPublishable(record)) {
    return {
      ok: false,
      code: 'studio_generation_record_stale',
      message: '当前脚本与已通过质量校验的 AI 版本不一致，请重新审核后再发布。',
    };
  }
  return { ok: true, metadata: claim };
}

export function publishableStudioGenerationFromSpec(
  specValue: unknown,
  kind: StudioGenerationKind = 'script',
): StudioGenerationMetadata | null {
  const spec = objectValue(specValue);
  if (kind === 'poster') {
    const metadata: StudioGenerationMetadata = {
      generationKind: 'poster', generationProvenance: 'ai', qualityStatus: 'passed', publishable: true,
      generationRecordId: 'poster-current',
    };
    return verifiedStudioGenerationFromSpec(spec, metadata).ok ? metadata : null;
  }
  const projectRecord = currentStudioProjectQualityRecord(spec);
  if (projectRecord) return {
    generationKind: 'script', generationProvenance: 'ai', qualityStatus: 'passed', publishable: true,
    generationRecordId: projectRecord.id,
  };
  const currentScript = cleanText(spec.script);
  const activeId = cleanText(spec.activeModeScriptId);
  const scripts = Array.isArray(spec.modeScripts) ? spec.modeScripts.map(objectValue) : [];
  const selected = scripts.find(item => cleanText(item.id) === activeId && cleanText(item.script) === currentScript)
    || scripts.find(item => cleanText(item.script) === currentScript && recordIsPublishable(item));
  if (!selected || !recordIsPublishable(selected)) return null;
  const generationRecordId = cleanText(selected.id);
  if (!generationRecordId) return null;
  return {
    generationKind: 'script', generationProvenance: 'ai', qualityStatus: 'passed', publishable: true,
    generationRecordId,
  };
}
