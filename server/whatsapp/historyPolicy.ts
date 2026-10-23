import { customerServicePolicy, customerServiceStatus, type EnterpriseProfile } from '../routes/enterprise.js';
import type { AutonomyLevel } from '../autonomy/actionRules.js';
import { NIGHT_MODE_EVENTS_FILE, customers, mirrorCustomerToPocketBase, readJson, writeCustomers, writeJson } from './historyPersistence.js';
import type { CustomerStage, HandlingMode, NightModeEvent } from './historyImport.js';

export function autonomyLevel(profile: EnterpriseProfile): AutonomyLevel {
  const policy = customerServicePolicy(profile);
  if (!policy.enabled) return 'remind';
  if (!customerServiceStatus(profile).autoReplyReady) return 'draft';
  const value = profile?.strategy?.aiAutonomy;
  return value === 'remind' || value === 'draft' || value === 'auto' ? value : 'draft';
}

export function handoffRules(profile: EnterpriseProfile): { keywords: string[]; missStreakToDraft: number; negativeSentiment: boolean } {
  const rules: Partial<NonNullable<EnterpriseProfile['handoffRules']>> = profile.handoffRules ?? {};
  const keywords = Array.isArray(rules.keywords)
    ? rules.keywords.map((item: unknown) => text(item)).filter(Boolean)
    : [];
  const missStreakToDraft = [1, 2, 3].includes(Number(rules.missStreakToDraft)) ? Number(rules.missStreakToDraft) : 2;
  return {
    keywords: keywords.length ? keywords : ['人工', '老板', 'manager', 'complaint', 'refund'],
    missStreakToDraft,
    negativeSentiment: rules.negativeSentiment !== false,
  };
}

function normalizeForMatch(value: string): string {
  return text(value).normalize('NFKC').toLowerCase();
}

export function matchedHandoffKeyword(body: string, keywords: string[]): string {
  const normalized = normalizeForMatch(body);
  return keywords.find(keyword => normalized.includes(normalizeForMatch(keyword))) || '';
}

function minutesOfDay(value: string): number {
  const [hour, minute] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function currentDate(): Date {
  return new Date();
}

function isWithinWorkHours(workHours: { start: string; end: string }, now = new Date()): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(workHours.start || '09:00');
  const end = minutesOfDay(workHours.end || '22:00');
  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}

export function nightModeState(profile: EnterpriseProfile, now = currentDate()): { enabled: boolean; active: boolean; workHours: { start: string; end: string } } {
  const notifications = profile.notifications;
  const workHours = {
    start: /^\d{2}:\d{2}$/.test(String(notifications?.workHours?.start || '')) ? notifications!.workHours.start : '09:00',
    end: /^\d{2}:\d{2}$/.test(String(notifications?.workHours?.end || '')) ? notifications!.workHours.end : '22:00',
  };
  const enabled = Boolean(notifications?.nightMode?.enabled);
  return { enabled, active: enabled && !isWithinWorkHours(workHours, now), workHours };
}

function nightModeEvents(): NightModeEvent[] {
  return readJson<NightModeEvent[]>(NIGHT_MODE_EVENTS_FILE, []);
}

function writeNightModeEvents(items: NightModeEvent[]): void {
  writeJson(NIGHT_MODE_EVENTS_FILE, items);
}

export function recordNightModeEvent(input: Omit<NightModeEvent, 'id' | 'createdAt'>): void {
  const now = currentDate();
  const recent = nightModeEvents().filter(item => now.getTime() - new Date(item.createdAt).getTime() < 7 * 86_400_000);
  recent.push({ ...input, id: `${input.kind}-${input.customerId}-${now.getTime()}`, createdAt: now.toISOString() });
  writeNightModeEvents(recent);
}

export function getNightModeMorningBriefing(tenantId = 'local'): null | {
  customers: number;
  autoReplies: number;
  drafts: number;
  calls: number;
  autoCustomerIds: string[];
  draftCustomerIds: string[];
  callCustomerIds: string[];
} {
  const since = currentDate().getTime() - 24 * 60 * 60 * 1000;
  const items = nightModeEvents().filter(item => item.tenantId === tenantId && new Date(item.createdAt).getTime() >= since);
  if (!items.length) return null;
  const autoCustomerIds = Array.from(new Set(items.filter(item => item.kind === 'auto').map(item => item.customerId)));
  const draftCustomerIds = Array.from(new Set(items.filter(item => item.kind === 'draft').map(item => item.customerId)));
  const callCustomerIds = Array.from(new Set(items.filter(item => item.kind === 'call').map(item => item.customerId)));
  return {
    customers: new Set(items.map(item => item.customerId)).size,
    autoReplies: items.filter(item => item.kind === 'auto').length,
    drafts: items.filter(item => item.kind === 'draft').length,
    calls: callCustomerIds.length,
    autoCustomerIds,
    draftCustomerIds,
    callCustomerIds,
  };
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function timestamp(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(raw) && raw > 0) return raw < 10_000_000_000 ? raw * 1000 : raw;
  return Date.now();
}

export function detectLanguage(body: string): string {
  if (/[\u0600-\u06ff]/.test(body)) return '\u963f\u8bed';
  if (/[áéíóúãõçñ¿¡]/i.test(body) || /\b(hola|gracias|precio|env[ií]o|cu[aá]nto|piezas)\b/i.test(body)) return '\u897f\u8bed';
  if (/\b(ol[aá]|obrigad[ao]|pre[cç]o|envio|quantidade)\b/i.test(body)) return '\u8461\u8bed';
  if (/[\u4e00-\u9fff]/.test(body)) return '\u4e2d\u6587';
  return '\u82f1\u8bed';
}

const PHONE_REGION_PREFIXES: Array<{ prefix: string; countryName: string; timeZone: string }> = [
  { prefix: '966', countryName: '沙特阿拉伯', timeZone: 'Asia/Riyadh' },
  { prefix: '974', countryName: '卡塔尔', timeZone: 'Asia/Qatar' },
  { prefix: '965', countryName: '科威特', timeZone: 'Asia/Kuwait' },
  { prefix: '968', countryName: '阿曼', timeZone: 'Asia/Muscat' },
  { prefix: '973', countryName: '巴林', timeZone: 'Asia/Bahrain' },
  { prefix: '880', countryName: '孟加拉国', timeZone: 'Asia/Dhaka' },
  { prefix: '855', countryName: '柬埔寨', timeZone: 'Asia/Phnom_Penh' },
  { prefix: '852', countryName: '中国香港', timeZone: 'Asia/Hong_Kong' },
  { prefix: '853', countryName: '中国澳门', timeZone: 'Asia/Macau' },
  { prefix: '886', countryName: '中国台湾', timeZone: 'Asia/Taipei' },
  { prefix: '351', countryName: '葡萄牙', timeZone: 'Europe/Lisbon' },
  { prefix: '234', countryName: '尼日利亚', timeZone: 'Africa/Lagos' },
  { prefix: '254', countryName: '肯尼亚', timeZone: 'Africa/Nairobi' },
  { prefix: '212', countryName: '摩洛哥', timeZone: 'Africa/Casablanca' },
  { prefix: '971', countryName: '阿联酋', timeZone: 'Asia/Dubai' },
  { prefix: '62', countryName: '印度尼西亚', timeZone: 'Asia/Jakarta' },
  { prefix: '84', countryName: '越南', timeZone: 'Asia/Ho_Chi_Minh' },
  { prefix: '66', countryName: '泰国', timeZone: 'Asia/Bangkok' },
  { prefix: '60', countryName: '马来西亚', timeZone: 'Asia/Kuala_Lumpur' },
  { prefix: '65', countryName: '新加坡', timeZone: 'Asia/Singapore' },
  { prefix: '63', countryName: '菲律宾', timeZone: 'Asia/Manila' },
  { prefix: '91', countryName: '印度', timeZone: 'Asia/Kolkata' },
  { prefix: '92', countryName: '巴基斯坦', timeZone: 'Asia/Karachi' },
  { prefix: '81', countryName: '日本', timeZone: 'Asia/Tokyo' },
  { prefix: '82', countryName: '韩国', timeZone: 'Asia/Seoul' },
  { prefix: '86', countryName: '中国', timeZone: 'Asia/Shanghai' },
  { prefix: '44', countryName: '英国', timeZone: 'Europe/London' },
  { prefix: '49', countryName: '德国', timeZone: 'Europe/Berlin' },
  { prefix: '33', countryName: '法国', timeZone: 'Europe/Paris' },
  { prefix: '39', countryName: '意大利', timeZone: 'Europe/Rome' },
  { prefix: '34', countryName: '西班牙', timeZone: 'Europe/Madrid' },
  { prefix: '31', countryName: '荷兰', timeZone: 'Europe/Amsterdam' },
  { prefix: '48', countryName: '波兰', timeZone: 'Europe/Warsaw' },
  { prefix: '55', countryName: '巴西', timeZone: 'America/Sao_Paulo' },
  { prefix: '52', countryName: '墨西哥', timeZone: 'America/Mexico_City' },
  { prefix: '54', countryName: '阿根廷', timeZone: 'America/Argentina/Buenos_Aires' },
  { prefix: '56', countryName: '智利', timeZone: 'America/Santiago' },
  { prefix: '57', countryName: '哥伦比亚', timeZone: 'America/Bogota' },
  { prefix: '51', countryName: '秘鲁', timeZone: 'America/Lima' },
  { prefix: '20', countryName: '埃及', timeZone: 'Africa/Cairo' },
  { prefix: '27', countryName: '南非', timeZone: 'Africa/Johannesburg' },
  { prefix: '61', countryName: '澳大利亚', timeZone: 'Australia/Sydney' },
  { prefix: '64', countryName: '新西兰', timeZone: 'Pacific/Auckland' },
  // NANP spans multiple zones. New York is an explicit, auditable regional
  // default until the customer profile supplies a more precise time zone.
  { prefix: '1', countryName: '北美（国家码默认）', timeZone: 'America/New_York' },
];

export function inferPhoneRegion(waNumber: string): { countryName: string; timeZone?: string } {
  const digits = String(waNumber || '').replace(/\D/g, '');
  const match = PHONE_REGION_PREFIXES.find(item => digits.startsWith(item.prefix));
  return match ? { countryName: match.countryName, timeZone: match.timeZone } : { countryName: '未知' };
}

export function currentLocalTime(timeZone?: string): string {
  if (!timeZone) return '未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  } catch {
    return '未知';
  }
}

export function normalizedCustomerSource(source?: string): string {
  const value = String(source || 'whatsapp').trim().toLowerCase();
  const aliases: Record<string, string> = {
    fb: 'facebook', ig: 'instagram', yt: 'youtube',
    'tik tok': 'tiktok', whatsapp_business: 'whatsapp',
  };
  const normalized = aliases[value] || value;
  return /^(whatsapp|facebook|instagram|tiktok|youtube|whatsapp_from_(facebook|instagram|tiktok|youtube))$/.test(normalized)
    ? normalized
    : 'whatsapp';
}

export function stageByTimestamp(lastActiveAt: number): CustomerStage {
  const days = Math.floor((Date.now() - lastActiveAt) / 86_400_000);
  if (days <= 30) return 'inquiry';
  if (days <= 60) return 'silent30';
  return 'silent60';
}

export function recomputeWhatsAppCustomerStages(now = Date.now()): number {
  const list = customers();
  let changed = 0;
  const next = list.map(customer => {
    // Business milestones are explicit CRM states and must not be downgraded
    // merely because the WhatsApp conversation has been quiet for a while.
    if (customer.stage === 'quoted' || customer.stage === 'won') return customer;
    const stage = stageByTimestamp(customer.lastActiveAt || now);
    if (stage === customer.stage) return customer;
    changed += 1;
    return {
      ...customer,
      stage,
      handlingMode: stage === 'silent30' || stage === 'silent60' ? 'ai_draft' as HandlingMode : customer.handlingMode,
      handlingReason: stage === 'silent30' || stage === 'silent60'
        ? '\u5ba2\u6237\u5df2\u6c89\u9ed8\uff0cAI \u5df2\u51c6\u5907\u5524\u9192\u8ddf\u8fdb'
        : customer.handlingReason,
      updatedAt: new Date(now).toISOString(),
    };
  });
  if (changed > 0) {
    writeCustomers(next);
    for (const customer of next) {
      void mirrorCustomerToPocketBase(customer).catch(error => console.error('[whatsapp-pb-customer]', error));
    }
  }
  return changed;
}
