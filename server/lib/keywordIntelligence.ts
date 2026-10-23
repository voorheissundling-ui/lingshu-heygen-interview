import { createHash } from 'node:crypto';
import type {
  CaptionReplicationContract,
  KeywordCandidate,
  KeywordResearchInput,
  KeywordResearchResult,
  KeywordRole,
} from '../../shared/contracts/keywordResearch.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: KeywordResearchResult }>();
const CTA_PATTERN = /\b(?:learn more|read more|contact us|message us|dm us|discover|explore|shop now|inquire|enquire|了解更多|联系我们|私信|咨询|查看详情)\b/i;

export function hashtagValue(value: string): string {
  return String(value || '')
    .replace(/^#+/, '')
    .trim()
    .split(/[\s_\-/]+/)
    .filter(Boolean)
    .map(part => /^[A-Z0-9]{2,}$/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 60);
}

export function referenceHashtags(caption: string): string[] {
  return [...String(caption || '').matchAll(/#([\p{L}\p{N}_-]+)/gu)].map(match => match[1]!).filter(Boolean);
}

function inferReferenceRole(tag: string): KeywordRole {
  if (/brand|official|®|™/i.test(tag)) return 'brand';
  if (/factory|manufacturer|supplier|wholesale|oem|odm|private.?label/i.test(tag)) return 'buyer_intent';
  if (/partner|collab|mercedes|basf/i.test(tag)) return 'partner';
  if (/sustainable|clean|beauty|innovation|quality|premium|natural/i.test(tag)) return 'value_theme';
  return 'category';
}

export function buildCaptionReplicationContract(referenceCaption = ''): CaptionReplicationContract {
  const source = String(referenceCaption || '').trim();
  const body = source.replace(/#[\p{L}\p{N}_-]+/gu, '').trim();
  const paragraphs = body ? body.split(/\n\s*\n|\n/).map(item => item.trim()).filter(Boolean) : [];
  const emojis = [...body.matchAll(/\p{Extended_Pictographic}/gu)].map(match => match[0]);
  const tags = referenceHashtags(source);
  return {
    sourceAvailable: Boolean(source),
    paragraphCount: Math.max(1, Math.min(6, paragraphs.length || 3)),
    emojiPattern: emojis.slice(0, 6),
    hashtagCount: Math.max(4, Math.min(12, tags.length || 6)),
    hashtagRoles: tags.map(inferReferenceRole),
    hasCallToAction: CTA_PATTERN.test(body),
    instruction: source
      ? 'Replicate the benchmark post structure, paragraph rhythm, emoji positions, CTA position and hashtag role pattern; replace its brand, product, partner and facts with verified enterprise context. Never copy competitor identity or unsupported claims.'
      : 'Use a concise hook, verified value explanation, CTA, then a diversified brand/category/value/buyer-intent hashtag set.',
  };
}

function candidate(term: string, role: KeywordRole, source: KeywordCandidate['source'], mandatory = false, relevanceScore = .75): KeywordCandidate | null {
  const hashtag = hashtagValue(term);
  return hashtag ? { term: String(term).trim(), hashtag, role, source, mandatory, relevanceScore } : null;
}

function configuredStatus(): KeywordResearchResult['providerStatus'] {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) return 'pending_credentials';
  if (!process.env.GOOGLE_ADS_CUSTOMER_ID || !process.env.GOOGLE_ADS_REFRESH_TOKEN) return 'pending_credentials';
  if (String(process.env.GOOGLE_ADS_API_ACCESS_LEVEL || '').toLowerCase() !== 'basic') return 'pending_basic_access';
  return 'fallback';
}

function uniqueCandidates(items: Array<KeywordCandidate | null>): KeywordCandidate[] {
  const seen = new Set<string>();
  return items.filter((item): item is KeywordCandidate => {
    if (!item) return false;
    const key = item.hashtag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function researchKeywords(input: KeywordResearchInput): KeywordResearchResult {
  const key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const replication = buildCaptionReplicationContract(input.referenceCaption);
  const referenceTerms = referenceHashtags(input.referenceCaption || '');
  const candidates = uniqueCandidates([
    candidate(input.brandName || '', 'brand', 'enterprise', Boolean(input.brandName), 1),
    candidate(input.productName || '', 'product', 'enterprise', Boolean(input.productName), .95),
    ...(input.categoryTerms || []).map(term => candidate(term, 'category', 'enterprise', true, .95)),
    ...(input.valueThemes || []).map(term => candidate(term, 'value_theme', 'enterprise', false, .85)),
    ...(input.partnerTerms || []).map(term => candidate(term, 'partner', 'enterprise', false, .8)),
    ...referenceTerms.map(term => candidate(term, inferReferenceRole(term), 'reference', false, .55)),
  ]);
  const requestedCount = Math.max(4, Math.min(12, input.maxHashtags || replication.hashtagCount));
  const selected: KeywordCandidate[] = [];
  const selectable = candidates.filter(item => item.source !== 'reference');
  for (const item of selectable.filter(item => item.mandatory)) if (selected.length < requestedCount) selected.push(item);
  const roleOrder = replication.hashtagRoles.length ? replication.hashtagRoles : ['brand', 'category', 'value_theme', 'buyer_intent'];
  for (const role of roleOrder) {
    const match = selectable.find(item => item.role === role && !selected.includes(item));
    if (match && selected.length < requestedCount) selected.push(match);
  }
  for (const item of selectable) if (!selected.includes(item) && selected.length < requestedCount) selected.push(item);
  const value: KeywordResearchResult = {
    provider: 'local', providerStatus: configuredStatus(), candidates, selected, replication, generatedAt: new Date().toISOString(),
  };
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export function researchSocialImageKeywords(input: Omit<KeywordResearchInput, 'productName' | 'categoryTerms' | 'valueThemes'> & {
  productInfo?: string; categoryTerms?: unknown; valueThemes?: string[];
}): KeywordResearchResult {
  return researchKeywords({
    ...input,
    productName: String(input.productInfo || '').split(/[\n；;]/)[0]?.replace(/^产品名称[:：]?\s*/, '').trim(),
    categoryTerms: Array.isArray(input.categoryTerms) ? input.categoryTerms.map(String).slice(0, 8) : [],
    valueThemes: input.valueThemes || [],
  });
}

export function mergePlannedHashtags(generated: unknown, research: KeywordResearchResult, max = 12): string[] {
  const values = Array.isArray(generated) ? generated.map(String) : [];
  const mandatory = research.selected.filter(item => item.mandatory).map(item => item.hashtag);
  const planned = research.selected.map(item => item.hashtag);
  return [...new Set([...mandatory, ...values.map(hashtagValue), ...planned].filter(Boolean))].slice(0, Math.max(4, Math.min(12, max)));
}

export function keywordPromptContext(research: KeywordResearchResult): string {
  return `Caption replication contract: ${JSON.stringify(research.replication)}\nApproved hashtag candidates: ${research.selected.map(item => `${item.role}=#${item.hashtag}`).join(', ') || '(none)'}`;
}
