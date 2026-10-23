import { createHash } from 'node:crypto';
import { store } from '../storage/index.js';
import { callLLM } from '../agents/llm.js';
import { readTenantEnterpriseProfile, updateTenantEnterpriseProfile, type SalesStyleProfile } from '../routes/enterprise.js';

const COLLECTION = 'style_memory';

export interface StyleMemoryRecord {
  id: string;
  tenant_id: string;
  customer_id?: string;
  trigger_message: string;
  draft_original: string;
  final_sent: string;
  edited: boolean;
  category: string;
  outcome?: string;
  strategy_ids?: string[] | string;
  source?: string;
  source_fingerprint?: string;
  status?: 'pending' | 'confirmed' | 'paused' | 'superseded';
  learning_scope?: 'enterprise_style' | 'customer_private';
  source_kind?: 'employee_edit' | 'ai_inferred' | 'imported_winning' | 'manual';
  evidence_source?: string;
  node_id?: string;
  risk_level?: string;
  diff_tags?: string[] | string;
  intervention_type?: string;
  outcome_3_turn?: string;
  outcome_24h?: string;
  fact_learning_allowed?: boolean;
  expires_at?: string;
  confirmed_by?: string;
  confirmed_at?: string;
  updated_by?: string;
  created?: string;
  updated?: string;
}

export interface WriteStyleMemoryInput {
  tenantId: string;
  customerId?: string;
  triggerMessage: string;
  draftOriginal: string;
  finalSent: string;
  edited: boolean;
  category: string;
  strategyIds?: string[];
  nodeId?: string;
  riskLevel?: string;
  diffTags?: string[];
  interventionType?: string;
  outcome3Turn?: string;
  outcome24h?: string;
  finalOutcome?: string;
}

const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ADDRESS_RE = /\b(?:street|st\.|road|rd\.|avenue|ave\.|building|floor|room|suite|district|province|city)\b[^。.!?\n]{0,80}/gi;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function sanitizeStyleText(value: unknown): string {
  return text(value)
    .replace(EMAIL_RE, '[邮箱]')
    .replace(PHONE_RE, '[电话]')
    .replace(ADDRESS_RE, '[地址]')
    .slice(0, 3000);
}

export function sanitizeImportedWinningStyleText(value: unknown): string {
  return sanitizeStyleText(value)
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/(?:[$€£¥]\s*)?\d[\d,.:/%-]*(?:\s*(?:usd|eur|gbp|rmb|cny|pcs?|pieces?|units?|sets?|days?|weeks?|个月|天|件|套|箱|%))?/gi, '[业务数值]')
    .replace(/\b(?:gmp|iso(?:\s*\d+)?|coa|ce|fda|msds|rohs)\b/gi, '[资质信息]')
    .replace(/\b(?:we|i)\s+(?:can|provide|offer|support|have|guarantee|ensure)\b[^.!?\n]{0,120}/gi, '[历史业务事实已移除]')
    .replace(/(?:我们|我司|工厂).{0,10}(?:可以|支持|提供|具备|有|保证).{0,80}(?=[。！？\n]|$)/g, '[历史业务事实已移除]')
    .replace(/\[业务数值](?:\s*\[业务数值])+/g, '[业务数值]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function importWinningStyleMemories(
  tenantId: string,
  samples: Array<{ customerId: string; buyer: string; seller: string }>,
): Promise<number> {
  const existing = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId },
    sort: '-created',
    perPage: 1000,
  });
  const fingerprints = new Set(existing.items.map(item => text(item.source_fingerprint)).filter(Boolean));
  let imported = 0;
  for (const sample of samples.slice(0, 200)) {
    const trigger = sanitizeImportedWinningStyleText(sample.buyer);
    const finalSent = sanitizeImportedWinningStyleText(sample.seller);
    if (!trigger || !finalSent || finalSent === '[历史业务事实已移除]') continue;
    const fingerprint = createHash('sha256')
      .update(`${tenantId}\n${sample.customerId}\n${trigger}\n${finalSent}`)
      .digest('hex');
    if (fingerprints.has(fingerprint)) continue;
    const created = await store.create(COLLECTION, {
      tenant_id: tenantId,
      customer_id: text(sample.customerId),
      trigger_message: trigger,
      draft_original: '[历史成交对话：仅学习表达方式，业务事实已剥离]',
      final_sent: finalSent,
      edited: true,
      category: 'reply',
      outcome: 'won',
      strategy_ids: [],
      source: 'winning_history_style_only',
      source_fingerprint: fingerprint,
      status: 'pending',
      learning_scope: 'enterprise_style',
      source_kind: 'imported_winning',
      evidence_source: '成交会话风格导入',
      fact_learning_allowed: false,
    });
    if (created) {
      fingerprints.add(fingerprint);
      imported += 1;
    }
  }
  return imported;
}

function styleFeatures(value: string): Set<string> {
  const normalized = sanitizeStyleText(value).normalize('NFKC').toLowerCase();
  const features = new Set<string>();
  const conceptAliases: Record<string, string> = {
    country: 'market', region: 'market', countries: 'market', markets: 'market',
    sells: 'sell', selling: 'sell', sold: 'sell',
    qty: 'quantity', quantities: 'quantity', amount: 'quantity',
    cost: 'price', pricing: 'price', quote: 'price', quotation: 'price',
    certificate: 'certification', certificates: 'certification', certified: 'certification',
    ship: 'delivery', shipping: 'delivery', deliver: 'delivery', delivered: 'delivery',
  };
  for (const token of normalized.split(/[^a-z0-9]+/i).map(item => item.trim()).filter(item => item.length >= 2)) {
    features.add(token);
    if (conceptAliases[token]) features.add(conceptAliases[token]);
  }
  const cjk = Array.from(normalized.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ''));
  for (let index = 0; index < cjk.length - 1; index += 1) features.add(cjk.slice(index, index + 2).join(''));
  return features;
}

function semanticStyleScore(leftValue: string, rightValue: string): number {
  const left = styleFeatures(leftValue);
  const right = styleFeatures(rightValue);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function recencyScore(created: unknown, now = Date.now()): number {
  const timestamp = Date.parse(String(created || ''));
  if (!Number.isFinite(timestamp)) return 0.35;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.exp(-ageDays / 180);
}

/**
 * Hybrid retrieval keeps situational relevance in front of historical outcome.
 * A won conversation is valuable evidence of style, but it must not swamp a
 * much closer current buyer scenario simply because it once converted.
 */
export function styleMemoryRelevanceScore(
  item: StyleMemoryRecord,
  message: string,
  customerId = '',
  now = Date.now(),
): number {
  const semantic = semanticStyleScore(item.trigger_message, message);
  const outcome = item.outcome === 'won' ? 1 : 0;
  const edited = item.edited ? 1 : 0.35;
  const sameCustomer = customerId && item.customer_id === customerId ? 1 : 0;
  return semantic * 0.55
    + recencyScore(item.created, now) * 0.15
    + outcome * 0.15
    + edited * 0.1
    + sameCustomer * 0.05;
}

export async function recordStyleMemory(input: WriteStyleMemoryInput): Promise<void> {
  const tenantId = text(input.tenantId);
  const draftOriginal = sanitizeStyleText(input.draftOriginal);
  const finalSent = sanitizeStyleText(input.finalSent);
  const triggerMessage = sanitizeStyleText(input.triggerMessage);
  const category = text(input.category) || 'reply';
  const strategyIds = Array.from(new Set((input.strategyIds ?? [])
    .map(item => text(item).toUpperCase())
    .filter(item => /^(?:S\d{2}|T_[A-Z0-9_]{4,})$/.test(item))))
    .slice(0, 3);
  if (!tenantId || !draftOriginal || !finalSent || !triggerMessage) return;
  await store.create(COLLECTION, {
    tenant_id: tenantId,
    customer_id: text(input.customerId),
    trigger_message: triggerMessage,
    draft_original: draftOriginal,
    final_sent: finalSent,
    edited: Boolean(input.edited),
    category,
    outcome: '',
    strategy_ids: strategyIds,
    status: 'pending',
    learning_scope: 'enterprise_style',
    source_kind: 'employee_edit',
    evidence_source: 'AI 草稿与员工最终发送内容',
    node_id: text(input.nodeId).slice(0, 120),
    risk_level: text(input.riskLevel).slice(0, 30),
    diff_tags: (input.diffTags ?? []).map(text).filter(Boolean).slice(0, 20),
    intervention_type: text(input.interventionType).slice(0, 80) || (input.edited ? 'employee_edit' : 'direct_adoption'),
    outcome_3_turn: text(input.outcome3Turn).slice(0, 80) || 'pending_observation',
    outcome_24h: text(input.outcome24h).slice(0, 80) || 'pending_observation',
    fact_learning_allowed: false,
    ...(text(input.finalOutcome) ? { outcome: text(input.finalOutcome).slice(0, 80) } : {}),
  });
  await updateWeeklyStyleAdoption(tenantId, Boolean(input.edited));
}

function notExpired(item: StyleMemoryRecord, now = Date.now()): boolean {
  const expiry = Date.parse(String(item.expires_at || ''));
  return !Number.isFinite(expiry) || expiry > now;
}

/** Legacy records predate governance and remain usable; every new record starts pending. */
export function styleMemoryUsable(item: StyleMemoryRecord, now = Date.now()): boolean {
  return (!item.status || item.status === 'confirmed')
    && item.learning_scope !== 'customer_private'
    && notExpired(item, now);
}

function customerCoverage(items: StyleMemoryRecord[]): number {
  return new Set(items.map(item => text(item.customer_id)).filter(Boolean)).size;
}

function timePeriodCoverage(items: StyleMemoryRecord[]): number {
  return new Set(items.map(item => {
    const date = new Date(String(item.created || ''));
    return Number.isFinite(date.getTime()) ? weekKey(date) : '';
  }).filter(Boolean)).size;
}

export async function styleEvidenceReadiness(tenantId: string): Promise<{
  total: number;
  pending: number;
  confirmed: number;
  editedConfirmed: number;
  customerCount: number;
  periodCount: number;
}> {
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId },
    sort: '-created',
    perPage: 1000,
  });
  const confirmed = result.items.filter(styleMemoryUsable);
  const editedConfirmed = confirmed.filter(item => item.edited);
  return {
    total: result.totalItems,
    pending: result.items.filter(item => item.status === 'pending').length,
    confirmed: confirmed.length,
    editedConfirmed: editedConfirmed.length,
    customerCount: customerCoverage(editedConfirmed),
    periodCount: timePeriodCoverage(editedConfirmed),
  };
}

function weekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function updateWeeklyStyleAdoption(tenantId: string, edited: boolean): Promise<void> {
  const week = weekKey();
  const result = await store.list<any>('style_adoption_stats', { where: { tenant_id: tenantId, week }, perPage: 1 });
  const current = result.items[0];
  const total = Number(current?.total || 0) + 1;
  const direct = Number(current?.direct_sent || 0) + (edited ? 0 : 1);
  const payload = { tenant_id: tenantId, week, total: String(total), direct_sent: String(direct), rate: String(total ? direct / total : 0) };
  if (current?.id) await store.update('style_adoption_stats', current.id, payload);
  else await store.create('style_adoption_stats', payload);
}

export async function retrieveStyleMemories(tenantId: string, category: string, message: string, customerId = ''): Promise<StyleMemoryRecord[]> {
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId, category: category || 'reply' },
    sort: '-created',
    perPage: 100,
  });
  const items = result.items.filter(item => styleMemoryUsable(item) && item.trigger_message && item.final_sent);
  if (items.length < 2) return [];
  return items
    .sort((a, b) => styleMemoryRelevanceScore(b, message, customerId) - styleMemoryRelevanceScore(a, message, customerId))
    .slice(0, 3);
}

export function buildStyleMemoryPromptBlock(items: StyleMemoryRecord[]): string {
  if (!items.length) return '';
  return [
    'Style memory few-shot:',
    '以下是该商家过往对类似问题的实际回复风格，请学习其措辞、称呼与口径；但价格、MOQ、交期、库存、证书等事实性数字必须以当前知识库检索结果为准，历史样本中的数字一律不得复用。',
    'source=winning_history_style_only 的记录已经剥离历史业务事实，只能学习句式、语气和推进节奏，方括号占位符绝不能出现在客户回复中。',
    ...items.map((item, index) => [
      `Example ${index + 1}${item.outcome === 'won' ? ' outcome=won' : ''}${item.edited ? ' edited=true' : ' edited=false'}${item.source ? ` source=${item.source}` : ''}:`,
      `Buyer trigger: ${item.trigger_message}`,
      `AI draft zh: ${item.draft_original}`,
      `Seller final zh: ${item.final_sent}`,
    ].join('\n')),
  ].join('\n');
}

export async function markStyleMemoryWonForCustomer(tenantId: string, customerId: string): Promise<number> {
  const since = Date.now() - 30 * 86_400_000;
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId, customer_id: customerId },
    sort: '-created',
    perPage: 200,
  });
  let changed = 0;
  for (const item of result.items) {
    const created = Date.parse(String(item.created || ''));
    if (Number.isFinite(created) && created < since) continue;
    if (item.outcome === 'won') continue;
    if (await store.update(COLLECTION, item.id, { outcome: 'won' })) changed += 1;
  }
  return changed;
}

function eventTimestampMs(event: Record<string, unknown>): number | null {
  const rawTimestamp = Number(event.timestamp);
  if (Number.isFinite(rawTimestamp) && rawTimestamp > 0) return rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
  const parsed = Date.parse(text(event.time));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Attach observable follow-up windows to earlier interventions without claiming causal success. */
export async function observeStyleMemoryOutcomes(input: {
  tenantId: string;
  customerId: string;
  timeline: Array<Record<string, unknown>>;
  stage?: string;
  now?: number;
}): Promise<number> {
  if (!input.tenantId || !input.customerId) return 0;
  const now = input.now ?? Date.now();
  const buyerEvents = input.timeline
    .filter(event => text(event.actor).toLowerCase() === 'buyer' || text(event.type).includes('msg_in'))
    .map(eventTimestampMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: input.tenantId, customer_id: input.customerId },
    sort: '-created',
    perPage: 100,
  });
  let updated = 0;
  for (const record of result.items) {
    const createdAt = Date.parse(text(record.created));
    if (!Number.isFinite(createdAt)) continue;
    const nextBuyerReply = buyerEvents.find(timestamp => timestamp > createdAt);
    const patch: Record<string, unknown> = {};
    if ((!record.outcome_3_turn || record.outcome_3_turn === 'pending_observation') && nextBuyerReply) {
      patch.outcome_3_turn = 'buyer_replied_within_next_3_turns';
    }
    if (!record.outcome_24h || record.outcome_24h === 'pending_observation') {
      if (nextBuyerReply) patch.outcome_24h = nextBuyerReply - createdAt <= 86_400_000 ? 'buyer_replied_within_24h' : 'buyer_replied_after_24h';
      else if (now - createdAt >= 86_400_000) patch.outcome_24h = 'no_buyer_reply_within_24h';
    }
    if (/\bwon\b|成交/i.test(text(input.stage)) && record.outcome !== 'won') patch.outcome = 'won';
    if (Object.keys(patch).length && await store.update(COLLECTION, record.id, patch)) updated += 1;
  }
  return updated;
}

function parseDistilledJson(raw: string): Partial<SalesStyleProfile> {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]) as Partial<SalesStyleProfile>;
  } catch {
    return {};
  }
}

function mergeManualProtected(current: SalesStyleProfile, next: SalesStyleProfile): SalesStyleProfile {
  return {
    ...next,
    greeting_style: current.greeting_style?.manual ? current.greeting_style : next.greeting_style,
    quoting_stance: current.quoting_stance?.manual ? current.quoting_stance : next.quoting_stance,
    followup_rhythm: current.followup_rhythm?.manual ? current.followup_rhythm : next.followup_rhythm,
    taboo_phrases: current.taboo_phrases?.manual ? current.taboo_phrases : next.taboo_phrases,
  };
}

export async function distillSalesStyleProfile(tenantId = 'local_tenant_default', force = false): Promise<SalesStyleProfile | null> {
  const profile = await readTenantEnterpriseProfile(tenantId);
  const current = profile.salesStyleProfile ?? { learnedFromCount: 0, sample_pairs: [] };
  if (!force && current.lastDistilledAt && Date.now() - Date.parse(current.lastDistilledAt) < 6 * 86_400_000) return current;
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId, edited: true },
    sort: '-created',
    perPage: 200,
  });
  const samples = result.items.filter(item => styleMemoryUsable(item) && item.trigger_message && item.draft_original && item.final_sent);
  if (samples.length < 20 || customerCoverage(samples) < 3) return null;
  const prompt = [
    'You distill a Yiwu seller sales style profile from real edited replies.',
    'Return strict JSON only with keys: greeting_style, quoting_stance, followup_rhythm, taboo_phrases, sample_pairs.',
    'Each of greeting_style/quoting_stance/followup_rhythm must be {"value": "...", "evidence": "one exact sample reason from provided data"}.',
    'taboo_phrases must be {"value": string[], "evidence": "one exact sample reason"}.',
    'sample_pairs must be up to 5 items: {"trigger":"buyer trigger summary","final":"seller final Chinese reply","evidence":"why representative"}.',
    'Do not infer anything without evidence. If evidence is insufficient, keep the value empty.',
    'Never copy phone numbers, emails, or addresses.',
    '',
    samples.slice(0, 80).map((item, index) => [
      `#${index + 1} category=${item.category} outcome=${item.outcome || 'none'}`,
      `trigger: ${item.trigger_message}`,
      `ai_draft: ${item.draft_original}`,
      `seller_final: ${item.final_sent}`,
    ].join('\n')).join('\n\n'),
  ].join('\n');
  const raw = await callLLM(prompt, { backend: 'qwen', model: process.env.STYLE_MEMORY_MODEL || 'qwen-plus' });
  const parsed = parseDistilledJson(raw);
  const distilled: SalesStyleProfile = {
    learnedFromCount: samples.length,
    lastDistilledAt: new Date().toISOString(),
    greeting_style: parsed.greeting_style,
    quoting_stance: parsed.quoting_stance,
    followup_rhythm: parsed.followup_rhythm,
    taboo_phrases: parsed.taboo_phrases,
    sample_pairs: Array.isArray(parsed.sample_pairs) ? parsed.sample_pairs.slice(0, 5) : [],
  };
  const merged = mergeManualProtected(current, distilled);
  await updateTenantEnterpriseProfile(tenantId, { salesStyleProfile: merged }, 'style-memory');
  return merged;
}

interface StrategyPreferenceRecord {
  id: string;
  tenant_id: string;
  strategy_id: string;
  adjustment: string;
  evidence_count: number | string;
  status: string;
  source?: string;
  scenario?: string;
  signals?: string[] | string;
  intent?: string;
  strategy_steps?: string[] | string;
  risk_link?: string;
  escalate?: string;
  updated?: string;
  version?: number | string;
  rollout_percent?: number | string;
  evidence_customer_count?: number | string;
  evidence_period_count?: number | string;
}

function strategyIds(item: StyleMemoryRecord): string[] {
  if (Array.isArray(item.strategy_ids)) return item.strategy_ids.map(text).filter(Boolean);
  if (typeof item.strategy_ids === 'string') {
    try {
      const parsed = JSON.parse(item.strategy_ids) as unknown;
      return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseStrategyAdjustment(raw: string): string {
  const match = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return text(parsed.adjustment).slice(0, 1200);
  } catch {
    return '';
  }
}

export async function distillResponseStrategyPreference(tenantId: string, strategyId: string): Promise<string | null> {
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId, edited: true },
    sort: '-created',
    perPage: 300,
  });
  const samples = result.items
    .filter(item => styleMemoryUsable(item) && strategyIds(item).includes(strategyId) && item.trigger_message && item.draft_original && item.final_sent)
    .slice(0, 80);
  if (samples.length < 5 || customerCoverage(samples) < 3 || timePeriodCoverage(samples) < 2) return null;

  const existingResult = await store.list<StrategyPreferenceRecord>('response_strategy_memory', {
    where: { tenant_id: tenantId, strategy_id: strategyId },
    sort: '-updated',
    perPage: 1,
  });
  const existing = existingResult.items[0];
  const existingCount = Number(existing?.evidence_count || 0);
  const recentlyUpdated = existing?.updated && Date.now() - Date.parse(existing.updated) < 7 * 86_400_000;
  if (existing?.adjustment && existingCount >= samples.length && recentlyUpdated) return existing.adjustment;

  const prompt = [
    'Distill one tenant-specific dialogue preference from real seller edits made under the same response strategy.',
    'Return strict JSON only: {"adjustment":"one concise Chinese instruction"}.',
    'Describe only repeatable conversation method, sequencing, tone, qualification questions, or handoff preference supported by multiple samples.',
    'Do not include or infer prices, discount numbers, MOQ, inventory, certificates, payment terms, shipping terms, lead times, company capability, contact details, or any other business fact.',
    'Do not overfit a single example. Return an empty adjustment when no stable preference is supported.',
    `Strategy ID: ${strategyId}`,
    '',
    samples.map((item, index) => [
      `#${index + 1} outcome=${item.outcome || 'none'}`,
      `buyer: ${item.trigger_message}`,
      `ai_draft: ${item.draft_original}`,
      `seller_final: ${item.final_sent}`,
    ].join('\n')).join('\n\n'),
  ].join('\n');
  const raw = await callLLM(prompt, {
    backend: 'qwen',
    model: process.env.STRATEGY_LEARNING_MODEL || process.env.STYLE_MEMORY_MODEL || 'qwen-plus',
  });
  const adjustment = parseStrategyAdjustment(raw);
  if (!adjustment) return null;
  const payload = {
    tenant_id: tenantId,
    strategy_id: strategyId,
    adjustment,
    evidence_count: samples.length,
    status: existing?.status === 'active' ? 'active' : 'candidate',
    source: existing?.source || 'real_seller_edits',
    evidence_customer_count: customerCoverage(samples),
    evidence_period_count: timePeriodCoverage(samples),
    version: Math.max(1, Number(existing?.version || 0) || 1),
    rollout_percent: existing?.status === 'active' ? Math.max(1, Number(existing?.rollout_percent || 100)) : 0,
    risk_boundary: '仅学习对话方法；价格、MOQ、库存、交期、认证、付款、折扣及商务承诺必须使用当前企业事实并按风险规则转人工。',
  };
  if (existing?.id) await store.update('response_strategy_memory', existing.id, payload);
  else await store.create('response_strategy_memory', payload);
  return adjustment;
}

interface DiscoveredStrategy {
  scenario: string;
  signals: string[];
  intent: string;
  tactics: string[];
  riskLink: string;
  escalate: string;
  evidenceIndexes: number[];
}

function parseDiscoveredStrategy(raw: string, sampleCount: number): DiscoveredStrategy | null {
  const match = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const scenario = text(parsed.scenario).slice(0, 160);
    const signals = Array.isArray(parsed.signals) ? parsed.signals.map(text).filter(Boolean).slice(0, 12) : [];
    const tactics = Array.isArray(parsed.tactics) ? parsed.tactics.map(text).filter(Boolean).slice(0, 8) : [];
    const evidenceIndexes = Array.from(new Set(
      (Array.isArray(parsed.evidenceIndexes) ? parsed.evidenceIndexes : [])
        .map(Number)
        .filter(index => Number.isInteger(index) && index >= 1 && index <= sampleCount),
    )).slice(0, 30);
    if (!scenario || signals.length < 2 || tactics.length < 2 || evidenceIndexes.length < 5) return null;
    return {
      scenario,
      signals,
      intent: text(parsed.intent).slice(0, 500),
      tactics,
      riskLink: /^L[234](?:-L[234])?$/.test(text(parsed.riskLink)) ? text(parsed.riskLink) : 'L3',
      escalate: text(parsed.escalate).slice(0, 500),
      evidenceIndexes,
    };
  } catch {
    return null;
  }
}

function customStrategyId(strategy: DiscoveredStrategy): string {
  const basis = `${strategy.scenario}\n${strategy.signals.join('|')}`.normalize('NFKC').toLowerCase();
  return `T_${createHash('sha256').update(basis).digest('hex').slice(0, 10).toUpperCase()}`;
}

export async function discoverResponseStrategy(tenantId: string): Promise<string | null> {
  const result = await store.list<StyleMemoryRecord>(COLLECTION, {
    where: { tenant_id: tenantId, edited: true },
    sort: '-created',
    perPage: 200,
  });
  const unassigned = result.items
    .filter(item => styleMemoryUsable(item) && strategyIds(item).length === 0 && item.trigger_message && item.draft_original && item.final_sent)
    .slice(0, 60);
  if (unassigned.length < 6 || customerCoverage(unassigned) < 3 || timePeriodCoverage(unassigned) < 2) return null;

  const prompt = [
    'Discover at most one repeatable buyer scenario and response tactic from real seller edits that did not match the built-in strategy library.',
    'Return strict JSON only with keys: scenario, signals, intent, tactics, riskLink, escalate, evidenceIndexes.',
    'Return {} unless at least five supplied records clearly share the same scenario and the seller uses a stable response method.',
    'signals must be buyer-language phrases useful for future retrieval. tactics must describe dialogue method only.',
    'Never include prices, discount numbers, MOQ, inventory, certifications, payment terms, shipping terms, lead times, company capability, personal data, or any other business fact.',
    'riskLink must be L2, L3, L4, or a range such as L2-L3. Use L4 for commitments, disputes, money decisions, or required human judgment.',
    'evidenceIndexes must list at least five one-based sample indexes that support the strategy.',
    '',
    unassigned.map((item, index) => [
      `#${index + 1}`,
      `buyer: ${item.trigger_message}`,
      `ai_draft: ${item.draft_original}`,
      `seller_final: ${item.final_sent}`,
    ].join('\n')).join('\n\n'),
  ].join('\n');
  const raw = await callLLM(prompt, {
    backend: 'qwen',
    model: process.env.STRATEGY_LEARNING_MODEL || process.env.STYLE_MEMORY_MODEL || 'qwen-plus',
  });
  const discovered = parseDiscoveredStrategy(raw, unassigned.length);
  if (!discovered) return null;
  const evidenceSamples = discovered.evidenceIndexes.map(index => unassigned[index - 1]).filter(Boolean);
  if (customerCoverage(evidenceSamples) < 3 || timePeriodCoverage(evidenceSamples) < 2) return null;

  const strategyId = customStrategyId(discovered);
  const existingResult = await store.list<StrategyPreferenceRecord>('response_strategy_memory', {
    where: { tenant_id: tenantId, strategy_id: strategyId },
    perPage: 1,
  });
  const payload = {
    tenant_id: tenantId,
    strategy_id: strategyId,
    adjustment: '',
    evidence_count: discovered.evidenceIndexes.length,
    status: 'candidate',
    source: 'learned_custom',
    scenario: discovered.scenario,
    signals: discovered.signals,
    intent: discovered.intent,
    strategy_steps: discovered.tactics,
    risk_link: discovered.riskLink,
    escalate: discovered.escalate,
    version: Math.max(1, Number(existingResult.items[0]?.version || 0) || 1),
    rollout_percent: 0,
    evidence_customer_count: customerCoverage(evidenceSamples),
    evidence_period_count: timePeriodCoverage(evidenceSamples),
    risk_boundary: '候选策略必须由管理员确认；L4、价格、折扣、MOQ、认证、付款、交期与法律承诺不得自动启用。',
  };
  const existing = existingResult.items[0];
  if (existing?.id) await store.update('response_strategy_memory', existing.id, payload);
  else await store.create('response_strategy_memory', payload);

  for (const evidenceIndex of discovered.evidenceIndexes) {
    const sample = unassigned[evidenceIndex - 1];
    if (sample?.id) await store.update(COLLECTION, sample.id, { strategy_ids: [strategyId] });
  }
  return strategyId;
}

export async function listStyleAdoptionTrends(): Promise<Array<{ tenantId: string; week: string; total: number; directSent: number; rate: number }>> {
  const result = await store.list<any>('style_adoption_stats', { sort: '-week', perPage: 500 });
  return result.items.map(item => ({
    tenantId: String(item.tenant_id || ''),
    week: String(item.week || ''),
    total: Number(item.total || 0),
    directSent: Number(item.direct_sent || 0),
    rate: Number(item.rate || 0),
  })).filter(item => item.tenantId && item.week);
}
