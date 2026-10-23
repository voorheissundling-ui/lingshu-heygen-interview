export const MATERIAL_USAGE_MANIFEST_VERSION = 'material-usage.v1' as const;

export const MATERIAL_USAGE_ROLES = [
  'three_second_hook',
  'body',
  'proof',
  'cta',
  'cover',
  'generation_reference',
] as const;

export type MaterialUsageRole = typeof MATERIAL_USAGE_ROLES[number];

export interface MaterialUsageManifestItem {
  materialId: string;
  sceneIds: string[];
  roles: MaterialUsageRole[];
}

/** Frozen only after a real content artifact exists. Selecting a material in
 * an editor is not usage evidence. */
export interface MaterialUsageManifest {
  schemaVersion: typeof MATERIAL_USAGE_MANIFEST_VERSION;
  artifactId: string;
  projectId: string;
  projectTitle: string;
  platform: string | null;
  usedAt: string;
  items: MaterialUsageManifestItem[];
}

export interface MaterialPerformanceMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  leads: number;
  engagementRate: number;
  available: Array<'views' | 'likes' | 'comments' | 'shares' | 'leads'>;
}

export interface MaterialUsageHistoryItem {
  usageId: string;
  artifactId: string;
  projectId: string;
  contentTitle: string;
  platform: string | null;
  roles: MaterialUsageRole[];
  sceneIds: string[];
  isThreeSecondHook: boolean;
  usedAt: string;
  publishedAt: string | null;
  publicationCount: number;
  metricsStatus: 'synced' | 'awaiting_sync' | 'not_published';
  metrics: MaterialPerformanceMetrics;
}

export interface MaterialUsageSummary {
  totalUses: number;
  hookUses: number;
  publishedUses: number;
  lastUsedAt: string | null;
  metrics: MaterialPerformanceMetrics;
  history: MaterialUsageHistoryItem[];
}

export const EMPTY_MATERIAL_PERFORMANCE: MaterialPerformanceMetrics = {
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  leads: 0,
  engagementRate: 0,
  available: [],
};

export const EMPTY_MATERIAL_USAGE_SUMMARY: MaterialUsageSummary = {
  totalUses: 0,
  hookUses: 0,
  publishedUses: 0,
  lastUsedAt: null,
  metrics: EMPTY_MATERIAL_PERFORMANCE,
  history: [],
};
