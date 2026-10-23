export type KeywordRole = 'brand' | 'category' | 'product' | 'buyer_intent' | 'value_theme' | 'partner' | 'trend' | 'geo';
export type KeywordSource = 'enterprise' | 'reference' | 'local_taxonomy' | 'google_ads' | 'google_trends';

export interface KeywordCandidate {
  term: string;
  hashtag: string;
  role: KeywordRole;
  source: KeywordSource;
  mandatory: boolean;
  relevanceScore: number;
  monthlySearches?: number;
  competition?: 'low' | 'medium' | 'high';
  trendScore?: number;
}

export interface CaptionReplicationContract {
  sourceAvailable: boolean;
  paragraphCount: number;
  emojiPattern: string[];
  hashtagCount: number;
  hashtagRoles: KeywordRole[];
  hasCallToAction: boolean;
  instruction: string;
}

export interface KeywordResearchResult {
  provider: 'local' | 'google_ads';
  providerStatus: 'ready' | 'fallback' | 'pending_credentials' | 'pending_basic_access';
  candidates: KeywordCandidate[];
  selected: KeywordCandidate[];
  replication: CaptionReplicationContract;
  generatedAt: string;
}

export interface KeywordResearchInput {
  platform: string;
  language: string;
  targetMarket?: string;
  brandName?: string;
  productName?: string;
  categoryTerms?: string[];
  valueThemes?: string[];
  partnerTerms?: string[];
  referenceCaption?: string;
  maxHashtags?: number;
}
