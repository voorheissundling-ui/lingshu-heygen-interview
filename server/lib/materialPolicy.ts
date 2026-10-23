export interface MaterialPolicyInput {
  id?: string;
  name?: string;
  folder?: string;
  scope?: string;
  usage?: string;
  sourceType?: string;
  sourceUrl?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  mayUseInProduction?: boolean;
  provenance?: { downloadedForAnalysisOnly?: boolean };
}

export type MaterialUsage = 'editable' | 'reference_only';

const WORKFLOW_INTERNAL_SOURCE_TYPES = new Set([
  'ai-storyboard-first-frame',
  'storyboard-controlled-product-source-frame',
  'digital-human-qwen-first-frame-draft',
  'digital-human-target-first-frame',
  'viral-sentence-first-frame',
  // Presenter enrollment inputs are durable private evidence for the
  // authorization pipeline.  They are not reusable creative-library cards;
  // production and presenter management still resolve them with purpose=all.
  'presenter-inline-upload',
  'presenter-ark-enrollment',
  'presenter-video-frame',
]);

/**
 * Intermediate frames are durable workflow evidence, not reusable library
 * assets. They stay readable through purpose=all so the originating production
 * task can resume, but must never leak into the user-facing material library.
 */
export function isWorkflowInternalMaterial(material: MaterialPolicyInput): boolean {
  return WORKFLOW_INTERNAL_SOURCE_TYPES.has(String(material.sourceType || '').trim().toLowerCase());
}

/**
 * Legacy crawled videos predate explicit usage metadata. Keep them available for
 * competitor analysis, but never expose them as downloadable editing assets.
 */
export function materialUsage(material: MaterialPolicyInput): MaterialUsage {
  if (material.usage === 'reference_only') return 'reference_only';
  if (material.provenance?.downloadedForAnalysisOnly === true) return 'reference_only';
  if (material.usage === 'editable' && material.commercialUseApproved === true
    && material.derivativesApproved === true && material.rawLibraryUseApproved === true
    && material.mayUseInProduction === true) return 'editable';
  if (/^(?:youtube|facebook|instagram|tiktok)(?:[_-]reference)?$/i.test(String(material.sourceType || ''))
    || /^(?:trend|viral)[_-]reference$/i.test(String(material.sourceType || ''))) return 'reference_only';
  if (/youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com/i.test(String(material.sourceUrl || ''))) return 'reference_only';
  if (material.folder === 'hot' && /爆款[·・](?:YouTube|Facebook|Instagram|TikTok)/i.test(String(material.name || ''))) {
    return 'reference_only';
  }
  return 'editable';
}

export function isReferenceOnlyMaterial(material: MaterialPolicyInput): boolean {
  return materialUsage(material) === 'reference_only';
}

export function canAppearInSharedLibrary(material: MaterialPolicyInput): boolean {
  return material.scope === 'shared' && !isReferenceOnlyMaterial(material);
}
