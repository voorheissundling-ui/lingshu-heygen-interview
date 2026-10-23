/** Explicit, expiring consent for future publishing cycles. Never inferred from autonomy. */
export interface ManagedPublishingGrant {
  enabled: boolean;
  accountIds: string[];
  maxPublishItems: number;
  validUntil: string;
  /** Server-owned provenance, replaced when the user saves consent. */
  grantId?: string;
  authorizedBy?: string;
  authorizedAt?: string;
}
export function normalizeManagedPublishingGrant(value: unknown): ManagedPublishingGrant | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ManagedPublishingGrant>;
  return {
    enabled: raw.enabled === true,
    accountIds: Array.isArray(raw.accountIds) ? [...new Set(raw.accountIds.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))].slice(0, 100) : [],
    maxPublishItems: Math.min(100, Math.max(0, Math.floor(Number(raw.maxPublishItems) || 0))),
    validUntil: typeof raw.validUntil === 'string' ? raw.validUntil.slice(0, 10) : '',
    ...(typeof raw.grantId === 'string' ? { grantId: raw.grantId.slice(0, 100) } : {}),
    ...(typeof raw.authorizedBy === 'string' ? { authorizedBy: raw.authorizedBy.slice(0, 160) } : {}),
    ...(typeof raw.authorizedAt === 'string' ? { authorizedAt: raw.authorizedAt.slice(0, 40) } : {}),
  };
}
export function managedPublishingGrantErrors(grant: ManagedPublishingGrant | undefined, config: { autonomyMode: string; allowRealPublishing: boolean; enabledWorkflows: string[]; publishingTargets: { accountId: string }[] }, today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())): string[] {
  if (!grant?.enabled) return [];
  const errors: string[] = [];
  if (config.autonomyMode !== 'automatic' || !config.allowRealPublishing || !config.enabledWorkflows.includes('content_publish')) errors.push('持续自动发布需开启全自动模式、内容发布及真实发布授权');
  if (!grant.accountIds.length || grant.accountIds.some(id => !config.publishingTargets.some(target => target.accountId === id))) errors.push('持续发布账号必须属于当前选定的已连接账号');
  if (!Number.isInteger(grant.maxPublishItems) || grant.maxPublishItems < 1 || grant.maxPublishItems > 100) errors.push('请设置 1–100 条的每周期发布上限');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(grant.validUntil) || !Number.isFinite(Date.parse(grant.validUntil)) || new Date(grant.validUntil).toISOString().slice(0, 10) !== grant.validUntil || grant.validUntil < today) errors.push('请选择有效的授权截止日期');
  return errors;
}
