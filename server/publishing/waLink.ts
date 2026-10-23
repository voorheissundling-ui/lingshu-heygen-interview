import { getTenantPlatformApp } from '../lib/tenantPlatformApps.js';
import { store } from '../storage/index.js';

export interface PostRecord {
  id: string;
  tenant_id: string;
  content_id?: string;
  platform: string;
  platform_post_id?: string;
  title?: string;
  published_at?: string;
  track_code: string;
  wa_link?: string;
  stats?: Record<string, unknown>;
  inquiries?: number;
  deals?: number;
  created?: string;
  updated?: string;
}

interface PostDraftInput {
  contentId?: string;
  platform: string;
  title?: string;
  language?: string;
  enabled?: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanPhone(value: string): string {
  return value.replace(/[^\d]/g, '').replace(/^00/, '');
}

function platformLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized === 'youtube') return 'YouTube';
  if (normalized === 'tiktok') return 'TikTok';
  if (normalized === 'instagram') return 'Instagram';
  if (normalized === 'facebook') return 'Facebook';
  return platform || 'content';
}

function prefillText(language: string | undefined, code: string): string {
  const lang = text(language).toLowerCase();
  if (/es|spanish|西语|西班牙/.test(lang)) return `Hola, vi tu video [#${code}] y me interesa.`;
  if (/pt|portuguese|葡语|葡萄牙/.test(lang)) return `Ola, vi seu video [#${code}] e tenho interesse.`;
  return `Hi, I saw your video [#${code}] and I'm interested.`;
}

async function tenantWhatsAppNumber(tenantId: string): Promise<{ number: string; needsSetup: boolean }> {
  const app = await getTenantPlatformApp(tenantId, 'meta');
  const publicNumber = cleanPhone(text(app?.wa_public_number));
  if (publicNumber) return { number: publicNumber, needsSetup: false };
  const envNumber = cleanPhone(text(process.env[`WA_PUBLIC_NUMBER_${tenantId}`]) || text(process.env.WA_PUBLIC_NUMBER));
  if (envNumber) return { number: envNumber, needsSetup: false };
  return { number: cleanPhone(text(app?.phone_number_id)), needsSetup: true };
}

async function nextTrackCode(tenantId: string): Promise<string> {
  const result = await store.list<PostRecord>('posts', { where: { tenant_id: tenantId }, perPage: 500 });
  const used = new Set(result.items.map(item => text(item.track_code)).filter(Boolean));
  const max = result.items.reduce((value, item) => {
    const match = text(item.track_code).match(/^V(\d{4})$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 999);
  for (let index = Math.max(1000, max + 1); index <= 9999; index += 1) {
    const code = `V${index}`;
    if (!used.has(code)) return code;
  }
  throw new Error('track_code_exhausted');
}

export async function createTrackedPostDraft(
  tenantId: string,
  input: PostDraftInput,
  initialState?: Pick<PostRecord, 'published_at' | 'stats'>,
): Promise<PostRecord & { trackingEnabled: boolean; needsWaNumberSetup: boolean }> {
  const enabled = input.enabled !== false;
  const now = new Date().toISOString();
  const code = await nextTrackCode(tenantId);
  const wa = await tenantWhatsAppNumber(tenantId);
  const link = enabled && wa.number
    ? `https://wa.me/${wa.number}?text=${encodeURIComponent(prefillText(input.language, code))}`
    : '';
  const created = await store.create<PostRecord>('posts', {
    tenant_id: tenantId,
    content_id: text(input.contentId),
    platform: text(input.platform),
    platform_post_id: '',
    title: text(input.title),
    published_at: initialState?.published_at || now,
    track_code: code,
    wa_link: link,
    stats: initialState?.stats || {},
    inquiries: 0,
    deals: 0,
  });
  if (!created) throw new Error('post_track_record_create_failed');
  return { ...created, trackingEnabled: enabled, needsWaNumberSetup: wa.needsSetup };
}

export function appendTrackedWaLink(platform: string, description: string, waLink: string): string {
  const body = text(description);
  if (!waLink) return body;
  const line = `WhatsApp inquiry: ${waLink}`;
  if (platform === 'youtube' || platform === 'facebook') return [line, body].filter(Boolean).join('\n\n');
  return [body, line].filter(Boolean).join('\n\n');
}

export async function finalizeTrackedPost(postId: string, patch: { platformPostId?: string; stats?: Record<string, unknown>; title?: string }): Promise<void> {
  const current = await store.getById<PostRecord>('posts', postId);
  const currentStats = current?.stats && typeof current.stats === 'object' && !Array.isArray(current.stats)
    ? current.stats
    : {};
  const update: Record<string, unknown> = {
    platform_post_id: text(patch.platformPostId),
    stats: { ...currentStats, ...(patch.stats ?? {}), status: text(patch.stats?.status) || 'published' },
    published_at: new Date().toISOString(),
  };
  const title = text(patch.title);
  if (title) update.title = title;
  await store.update('posts', postId, update);
}

export async function findPostByTrackCode(tenantId: string, code: string): Promise<PostRecord | null> {
  const result = await store.list<PostRecord>('posts', { where: { tenant_id: tenantId, track_code: code }, perPage: 1 });
  return result.items[0] ?? null;
}

export async function findPostById(postId: string): Promise<PostRecord | null> {
  return store.getById<PostRecord>('posts', postId);
}

export function extractTrackCode(message: string): string {
  return text(message).match(/\[#(V\d{4})\]/i)?.[1]?.toUpperCase() || '';
}

export async function incrementPostMetric(postId: string, field: 'inquiries' | 'deals'): Promise<void> {
  const post = await store.getById<PostRecord>('posts', postId);
  if (!post) return;
  await store.update('posts', postId, { [field]: Number(post[field] || 0) + 1 });
}

export async function recentPostCandidates(tenantId: string, hours = 72): Promise<PostRecord[]> {
  const result = await store.list<PostRecord>('posts', { where: { tenant_id: tenantId }, perPage: 100, sort: '-published_at' });
  const cutoff = Date.now() - hours * 3600_000;
  return result.items.filter(item => {
    const published = Date.parse(text(item.published_at) || text(item.created));
    return Number.isFinite(published) && published >= cutoff;
  });
}

export function sourceFromPost(post: PostRecord): string {
  return `whatsapp_from_${post.platform || 'content'}`.replace(/[^\w-]/g, '_');
}

export function attributionSystemText(post: PostRecord): string {
  return `客户来自【${platformLabel(post.platform)} · ${post.title || post.track_code}】`;
}
