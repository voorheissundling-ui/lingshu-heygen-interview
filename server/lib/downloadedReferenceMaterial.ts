import type { Platform } from '../types/index.js';

export interface DownloadedReferenceMaterialInput {
  id: string;
  tenantId: string;
  name: string;
  platform: Platform;
  sourceUrl: string;
  duration: number;
  size: string;
  file: string;
  poster?: string;
  contentSha256: string;
  createdAt: string;
}

/** Downloading a public reference preserves analysis access, without granting production rights. */
export function buildDownloadedReferenceMaterial(input: DownloadedReferenceMaterialInput) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    folder: 'hot',
    type: 'video' as const,
    duration: input.duration,
    size: input.size,
    file: input.file,
    url: `/media/${input.file}`,
    poster: input.poster ? `/media/${input.poster}` : undefined,
    contentSha256: input.contentSha256,
    scope: 'own' as const,
    usage: 'reference_only' as const,
    pinned: true,
    sourceType: input.platform,
    sourceUrl: input.sourceUrl,
    rightsReviewStatus: 'reference_only' as const,
    rightsReviewRationale: '下载仅保留参考分析用途，不授予原片成片使用权。',
    commercialUseApproved: false,
    derivativesApproved: false,
    rawLibraryUseApproved: false,
    mayAnalyze: true,
    mayUseInProduction: false,
    provenance: {
      source: `${input.platform}_public_video`,
      sourceUrl: input.sourceUrl,
      downloadedForAnalysisOnly: true,
      downloadedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}
