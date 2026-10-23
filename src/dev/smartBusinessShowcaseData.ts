import type { AdReport, ReportEntry } from '../lib/adOverview';
import type {
  BusinessMetric,
  BusinessSnapshot,
  DigitalEmployeeOverview,
  NextRoundRecommendations,
  PublishingPlatform,
} from '../lib/digitalEmployees';
import type { PlatformAdTask } from '../lib/platformAds';
import type {
  ConnectedSocialPerformance,
  ConnectedSocialPerformanceContent,
} from '../lib/socialPerformance';
const DAY_MS = 86_400_000;
export const SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS = {
  plannedVideoCount: 32,
  waitingReviewCount: 3,
  durationSeconds: 1_080,
  budgetMinCny: 300,
  budgetMaxCny: 360,
  budgetMidCny: 320,
} as const;

const WEEKLY_PLAN_PREVIEW_PROJECT_ID = 'studio_projects_9d8c21b5f0cc4149aeab596574b6e61c';

const PLATFORM_LABELS: Record<PublishingPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
};

const SHOWCASE_THUMBNAILS = [
  '/demo/feishu-viral-remix-final.jpg',
  '/demo/thumbs/7654315226526977288.jpg',
  '/demo/thumbs/7654672409370348814.jpg',
  '/demo/thumbs/7654680467647630605.jpg',
  '/demo/thumbs/7655363874128022806.jpg',
  '/demo/thumbs/7655425971251694855.jpg',
  '/demo/thumbs/7655426562682014989.jpg',
  '/demo/thumbs/7655435142575475981.jpg',
  '/demo/thumbs/7655436089930403086.jpg',
  '/demo/thumbs/7655440791376039182.jpg',
  '/demo/thumbs/7655750764610014472.jpg',
  '/demo/thumbs/7655873660401601805.jpg',
  '/demo/thumbs/7656627545248517406.jpg',
  '/demo/thumbs/7656661163404528910.jpg',
] as const;

const SHOWCASE_VIDEOS = [
  '/demo/feishu-viral-remix-final.mp4',
  '/demo/feishu-20260929-final.mp4',
  '/demo/img2video.mp4',
] as const;

function showcaseAssetHref(path: string): string {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://127.0.0.1:5177';
  return new URL(path, `${origin}/`).toString();
}

function showcaseAssetIndex(id: string, length: number): number {
  return [...id].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % length;
}

const explicitlyEnabled = (value: unknown) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

export function isSmartBusinessShowcaseEnabled(input: {
  dev?: boolean;
  hostname?: string;
  setting?: unknown;
} = {}): boolean {
  const dev = input.dev ?? Boolean(import.meta.env?.DEV);
  const hostname = (input.hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).trim().toLowerCase();
  const setting = input.setting ?? import.meta.env?.VITE_SMART_BUSINESS_SHOWCASE;
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  // Localhost is used for real integration, not consent to invent receipts.
  return (dev || loopback) && explicitlyEnabled(setting);
}

export function isSmartBusinessWeeklyPlanPreviewEnabled(input: {
  hostname?: string;
  search?: string;
} = {}): boolean {
  const hostname = (input.hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).trim().toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  if (!loopback) return false;
  const search = input.search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(search).get('project') === WEEKLY_PLAN_PREVIEW_PROJECT_ID;
}

export function isSmartBusinessOverviewPreviewEnabled(input: {
  hostname?: string;
  search?: string;
} = {}): boolean {
  const hostname = (input.hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).trim().toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  if (!loopback) return false;
  const search = input.search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(search).get('page') === 'digitalEmployees';
}

function beijingDay(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : fallback;
}

function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(startsAt: string, endsAt: string): string[] {
  const start = Date.parse(`${startsAt}T00:00:00Z`);
  const end = Date.parse(`${endsAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [startsAt];
  return Array.from({ length: Math.min(31, Math.round((end - start) / DAY_MS) + 1) }, (_, index) => shiftDay(startsAt, index));
}

const metric = (value: number, source: string, note?: string): BusinessMetric => ({
  value,
  status: 'available',
  source,
  ...(note ? { note } : {}),
});

function accountLabel(companyName: string, platform: PublishingPlatform): string {
  return `${companyName} · ${PLATFORM_LABELS[platform]}`;
}

function configuredAccount(
  data: DigitalEmployeeOverview,
  platform: PublishingPlatform,
): { id: string; title: string } {
  const companyName = data.config?.companyName?.trim() || 'Aurelia 澄光美研有限公司';
  const target = data.config?.publishingTargets.find(item => item.platform === platform);
  return {
    id: target?.accountId || `showcase-${platform}`,
    title: accountLabel(companyName, platform),
  };
}

function currentRange(data: DigitalEmployeeOverview) {
  const startFallback = data.goal?.startsAt || '2026-10-13';
  const endFallback = data.goal?.endsAt || shiftDay(startFallback, 6);
  const startsAt = beijingDay(data.businessSnapshot?.range.startsAt, startFallback);
  const endsAt = beijingDay(data.businessSnapshot?.range.endsAt, endFallback);
  return { startsAt, endsAt, days: daysBetween(startsAt, endsAt) };
}

const socialSeries = [
  { views: 18_400, interactions: 1_490 },
  { views: 24_900, interactions: 1_965 },
  { views: 28_600, interactions: 2_334 },
  { views: 33_800, interactions: 2_890 },
  { views: 39_100, interactions: 3_585 },
  { views: 36_500, interactions: 3_290 },
  { views: 34_500, interactions: 3_192 },
];

function buildSnapshot(data: DigitalEmployeeOverview): BusinessSnapshot {
  const { startsAt, endsAt, days } = currentRange(data);
  const companyName = data.config?.companyName?.trim() || 'Aurelia 澄光美研有限公司';
  const facebook = configuredAccount(data, 'facebook');
  const tiktok = configuredAccount(data, 'tiktok');
  const instagram = configuredAccount(data, 'instagram');
  const youtube = configuredAccount(data, 'youtube');
  const projectRows = [
    { id: 'showcase-facebook-product-proof', title: '低 MOQ 定制流程｜Facebook', route: 'product', digitalPresenter: false, platform: 'facebook', completed: true, approved: true, blocked: false },
    { id: 'showcase-tiktok-texture-test', title: '泡沫卸妆质地测试｜TikTok', route: 'clone', digitalPresenter: true, platform: 'tiktok', completed: true, approved: true, blocked: false },
    { id: 'showcase-instagram-packaging', title: '包装打样过程｜Instagram', route: 'material', digitalPresenter: false, platform: 'instagram', completed: true, approved: true, blocked: false },
    { id: 'showcase-youtube-factory', title: '工厂生产节点讲解｜YouTube', route: 'product', digitalPresenter: true, platform: 'youtube', completed: true, approved: true, blocked: false },
  ];
  const breakdown = [
    { platform: 'facebook', accounts: 1, views: 58_400, likes: 3_420, comments: 286, shares: 148, status: 'available' as const },
    { platform: 'tiktok', accounts: 1, views: 77_300, likes: 5_130, comments: 412, shares: 671, status: 'available' as const },
    { platform: 'instagram', accounts: 1, views: 31_500, likes: 2_180, comments: 149, shares: 126, status: 'available' as const },
    { platform: 'youtube', accounts: 1, views: 48_600, likes: 2_950, comments: 205, shares: 229, status: 'available' as const },
  ];
  const dailyTrend = days.map((date, index) => ({ date, ...socialSeries[index % socialSeries.length] }));
  const interactionBreakdown = [
    { businessDirectionRef: '采购决策 · 产品证据', accountId: facebook.id, contentId: data.goal?.videoPlans?.find(item => item.platform === 'facebook')?.contentId || 'facebook-proof-1', comments: 168, inquiries: 14, qualifiedInquiries: 10 },
    { businessDirectionRef: '采购决策 · 使用测试', accountId: facebook.id, contentId: 'facebook-proof-2', comments: 118, inquiries: 11, qualifiedInquiries: 7 },
    { businessDirectionRef: '产品教育 · 质地测试', accountId: tiktok.id, contentId: data.goal?.videoPlans?.find(item => item.platform === 'tiktok')?.contentId || 'tiktok-proof-1', comments: 231, inquiries: 17, qualifiedInquiries: 12 },
    { businessDirectionRef: '工厂实力 · 生产过程', accountId: tiktok.id, contentId: 'tiktok-proof-2', comments: 181, inquiries: 11, qualifiedInquiries: 8 },
    { businessDirectionRef: '包装能力 · 打样过程', accountId: instagram.id, contentId: 'instagram-proof-1', comments: 149, inquiries: 4, qualifiedInquiries: 3 },
    { businessDirectionRef: '供应链能力 · 工厂讲解', accountId: youtube.id, contentId: 'youtube-proof-1', comments: 205, inquiries: 4, qualifiedInquiries: 3 },
  ];
  return {
    generatedAt: `${endsAt}T18:30:00+08:00`,
    range: { startsAt, endsAt, timeZone: 'Asia/Shanghai' },
    readiness: [
      { key: 'enterprise', label: '企业资料', status: 'ready', count: 1, page: 'enterprise', note: '企业定位、市场与品牌信息已完整' },
      { key: 'products', label: '产品资料', status: 'ready', count: 41, page: 'enterprise', note: '产品参数、卖点与素材可用于内容生产' },
      { key: 'social_accounts', label: '社媒账号', status: 'ready', count: 4, page: 'accountManagement', note: '四个平台账号均已完成数据同步' },
      { key: 'viral_library', label: '爆款库', status: 'ready', count: 26, page: 'socialInspiration', note: '26 条内容已完成详细分析' },
      { key: 'content_projects', label: '内容项目', status: 'ready', count: 4, page: 'smartAssets', note: '四个平台内容均已形成可交付作品' },
      { key: 'customers', label: '客户与会话', status: 'ready', count: 148, page: 'conversion', note: '客户阶段与来源归因已整理' },
      { key: 'automation', label: '定时自动化', status: 'ready', count: 6, page: 'scheduled', note: '采集、发布与复盘任务均已配置' },
    ],
    content: {
      scheduledAutomations: metric(6, '经营自动化'),
      collectedItems: metric(32, '爆款内容库'),
      exactAnalyses: metric(26, '内容分析记录'),
      contentProjects: metric(4, '内容制作项目'),
      completedWorks: metric(4, '成片交付记录', '仅统计已完成渲染且可预览的作品'),
      approvedWorks: metric(4, '内容验收记录'),
      production: { status: 'available', note: '按当前周期内形成的作品统计；制作、验收和发布分别记录。', projects: projectRows },
      scheduledPosts: metric(6, '发布排期'),
      publishedPosts: metric(6, '平台发布回执'),
      failedPosts: metric(0, '平台发布回执'),
      inquiries: metric(61, '评论、私信与表单归因'),
      deals: metric(9, '客户成交记录'),
    },
    customer: {
      total: metric(148, '客户与会话'),
      attributed: metric(117, '客户来源归因'),
      highIntent: metric(43, '客户意向评分'),
      aiAuto: metric(94, '自动接待回执'),
      draftReview: metric(18, '待审核回复'),
      humanNeeded: metric(11, '人工处理队列'),
      quoted: metric(27, '报价记录'),
      won: metric(9, '成交记录'),
      segmentSnapshots: metric(148, '客户分层快照'),
      followupDrafts: metric(52, '跟进草稿'),
      outreachBatches: metric(4, '触达批次'),
      outreachSent: metric(45, '渠道发送回执'),
      outreachFailed: metric(2, '渠道发送回执'),
    },
    social: {
      accountCount: metric(4, '账号连接记录'),
      platformCount: metric(4, '账号平台分布'),
      views: metric(215_800, '平台表现回传'),
      reach: metric(182_300, '平台表现回传'),
      likes: metric(13_680, '平台表现回传'),
      comments: metric(1_052, '平台表现回传'),
      shares: metric(1_174, '平台表现回传'),
      saves: metric(2_840, '平台表现回传'),
      profileViews: metric(4_220, '平台表现回传'),
      platformBreakdown: breakdown,
      dailyTrend,
    },
    ads: {
      status: 'available',
      source: '平台费用与转化回执',
      note: '按当前周期内同币种的已回传数据统计。',
      latestReportedAt: `${endsAt}T17:55:00+08:00`,
      spendByCurrency: [{ currency: 'CNY', amount: 1_680, rows: 14 }],
      performance: {
        impressions: metric(284_000, '平台广告报告'),
        clicks: metric(6_840, '平台广告报告'),
        conversions: metric(38, '广告归因回执'),
        attributedRevenue: metric(10_560, '广告归因订单'),
        targetConversions: 32,
        targetCpa: 50,
        targetRoas: 4,
      },
    },
    running: [
      { id: 'showcase-running-review', title: '同步本周经营复盘', status: 'running', occurredAt: `${endsAt}T18:20:00+08:00` },
    ],
    needsDecision: [
      { id: 'showcase-decision-budget', title: '确认下周投流预算', status: 'waiting_human', occurredAt: `${endsAt}T17:30:00+08:00` },
    ],
    completedToday: [
      { id: 'showcase-complete-publish', title: '完成四平台发布回执核验', status: 'completed', occurredAt: `${endsAt}T17:05:00+08:00` },
      { id: 'showcase-complete-followup', title: '完成高意向客户跟进', status: 'completed', occurredAt: `${endsAt}T16:40:00+08:00` },
    ],
    next24Hours: [
      { id: 'showcase-next-review', kind: 'automation', title: '生成本周经营复盘', scheduledAt: `${endsAt}T20:00:00+08:00`, scheduleLabel: '今天 20:00', page: 'scheduled', status: 'scheduled' },
      { id: 'showcase-next-followup', kind: 'followup', title: '跟进高意向客户', scheduledAt: `${shiftDay(endsAt, 1)}T09:30:00+08:00`, scheduleLabel: '明天 09:30', page: 'conversion', status: 'scheduled' },
      { id: 'showcase-next-publish', kind: 'publish', title: '核对下周首条发布排期', scheduledAt: `${shiftDay(endsAt, 1)}T18:00:00+08:00`, scheduleLabel: '明天 18:00', page: 'smartAssets', status: 'scheduled' },
    ],
    attribution: { attributedCustomers: 117, postsWithInquiries: 6, status: 'available' },
    interactionReview: {
      deadline: `${endsAt}T23:59:59+08:00`,
      comments: 1_052,
      inquiries: 61,
      qualifiedInquiries: 43,
      unknownSourceInquiries: 0,
      creativeLearnings: 6,
      status: 'available',
      note: '评论、询盘和有效询盘均保留账号及内容来源。',
      breakdown: interactionBreakdown,
    },
    dataGaps: [],
  };
}

function normalizeVisibleAccountLabels(data: DigitalEmployeeOverview): Pick<DigitalEmployeeOverview, 'config' | 'plan' | 'contentQueue'> {
  const companyName = data.config?.companyName?.trim() || 'Aurelia 澄光美研有限公司';
  const labels = new Map<string, string>();
  const config = data.config ? {
    ...data.config,
    publishingTargets: data.config.publishingTargets.map(target => {
      const label = accountLabel(companyName, target.platform);
      labels.set(target.accountId, label);
      return { ...target, accountLabel: label };
    }),
  } : data.config;
  const plan = data.plan?.businessPackage?.operatingContext ? {
    ...data.plan,
    businessPackage: {
      ...data.plan.businessPackage,
      operatingContext: {
        ...data.plan.businessPackage.operatingContext,
        accounts: data.plan.businessPackage.operatingContext.accounts.map(account => ({
          ...account,
          accountLabel: labels.get(account.accountId) || account.accountLabel,
        })),
      },
    },
  } : data.plan;
  const contentQueue = data.contentQueue ? {
    ...data.contentQueue,
    items: data.contentQueue.items.map(item => ({
      ...item,
      accountLabel: labels.get(item.accountId) || item.accountLabel,
      lineage: { ...item.lineage, accountLabel: labels.get(item.lineage.accountId) || item.lineage.accountLabel },
    })),
  } : data.contentQueue;
  return { config, plan, contentQueue };
}

function showcaseIndustryTrends(endsAt: string): NextRoundRecommendations['industryTrends'] {
  const signals = [
    {
      id: 'showcase-trend-factory-process',
      title: '工厂生产全过程：从灌装到成品检验',
      platform: 'TikTok',
      summary: '工厂直供与生产透明度',
      sourceUrl: showcaseAssetHref(SHOWCASE_VIDEOS[0]),
      observedAt: `${endsAt}T16:20:00+08:00`,
      tags: ['beautysupplier', 'cosmeticfactory', 'factoryprocess'],
      thumbnailUrl: SHOWCASE_THUMBNAILS[4],
    },
    {
      id: 'showcase-trend-packaging',
      title: '包装打样实拍：高辨识度色彩与材质组合',
      platform: 'Instagram',
      summary: '包装与品类创新',
      sourceUrl: showcaseAssetHref(SHOWCASE_VIDEOS[1]),
      observedAt: `${endsAt}T15:05:00+08:00`,
      tags: ['privatelabel', 'packaging', 'beautybrand'],
      thumbnailUrl: SHOWCASE_THUMBNAILS[8],
    },
    {
      id: 'showcase-trend-low-moq',
      title: '低 MOQ 定制流程：小批量订单如何快速落地',
      platform: 'Facebook',
      summary: '小单起订与快速响应',
      sourceUrl: showcaseAssetHref(SHOWCASE_VIDEOS[2]),
      observedAt: `${endsAt}T13:40:00+08:00`,
      tags: ['lowmoq', 'oemodm', 'b2bbeauty'],
      thumbnailUrl: SHOWCASE_THUMBNAILS[11],
    },
  ];
  return {
    status: 'available',
    signals,
    systemActions: ['把本地可复核视频写入下一周编导参考池', '仅将带完整素材的行业信号用于内容方向判断'],
  };
}

export function smartBusinessShowcaseNextRoundRecommendations(
  data: DigitalEmployeeOverview,
  enabled = isSmartBusinessShowcaseEnabled() || isSmartBusinessOverviewPreviewEnabled(),
): NextRoundRecommendations | null {
  if (!enabled) return null;
  const range = currentRange(data);
  const inheritedContentId = data.goal?.videoPlans?.find(item => item.platform === 'tiktok')?.contentId || 'tiktok-proof-1';
  return {
    contentInheritance: {
      status: 'ready',
      sourceContentId: inheritedContentId,
      title: '3 秒质地测试：泡沫卸妆是否省步骤',
      platform: 'TikTok',
      hook: '先展示卸妆前后对比，再解释乳化速度。',
      framework: ['效果对比', '质地特写', '步骤说明', '采购提示'],
      tags: ['cleansingbalm', 'beautysupplier', 'privatelabel'],
      sourceUrl: '',
      thumbnailUrl: '/demo/feishu-viral-remix-final.jpg',
      reason: '质地测试与采购提示组合具备清晰的产品证明路径，下一轮继续复用结构并更换表达与镜头。',
      paidBoost: { status: 'recommended_for_review', reason: '内容结构与询盘目标匹配，可进入小预算投流复核。' },
      systemActions: ['继承首镜问题结构并生成新的产品证据组合', '保留采购提示，替换重复镜头与措辞'],
    },
    tagAdaptation: {
      status: 'changed',
      publishedTags: ['beautysupplier', 'privatelabel', 'cleansingbalm'],
      hotTags: ['beautysupplier', 'privatelabel', 'lowmoq', 'cosmeticfactory'],
      newTags: ['lowmoq', 'cosmeticfactory'],
      droppedTags: ['skincareroutine'],
      requiresConfirmation: true,
      systemActions: ['把新增 Tag 写入下周候选，不直接覆盖产品事实', '由编导在新脚本中验证低 MOQ 与工厂过程表达'],
    },
    industryTrends: showcaseIndustryTrends(range.endsAt),
  };
}

export function applySmartBusinessShowcaseData<T>(value: T, enabled = isSmartBusinessShowcaseEnabled()): T {
  if (!enabled || !value || typeof value !== 'object') return value;
  const data = value as T & Partial<DigitalEmployeeOverview>;
  if (!('businessSnapshot' in data) || !Array.isArray(data.agents)) return value;
  const overview = data as T & DigitalEmployeeOverview;
  const normalized = normalizeVisibleAccountLabels(overview);
  const range = currentRange({ ...overview, ...normalized });
  const industryTrends = showcaseIndustryTrends(range.endsAt);
  const inheritedContentId = overview.goal?.videoPlans?.find(item => item.platform === 'tiktok')?.contentId || 'tiktok-proof-1';
  const review = {
    id: 'showcase-weekly-review',
    status: 'generated',
    created_at: `${range.endsAt}T18:35:00+08:00`,
    summary: {
      completionRate: 100,
      automationRate: 82,
      approvalRate: 100,
      handoffRate: 6,
      completedTasks: 16,
      totalTasks: 16,
      failedTasks: 0,
      highlights: [
        '四个平台共取得 21.58 万次播放和 1.59 万次互动。',
        '61 条询盘中有 43 条进入高意向跟进，9 位客户完成成交。',
        '本周 6 次发布均取得平台回执，未出现发布失败。',
      ],
      nextGoalSuggestion: '保留质地测试与工厂过程两类高表现结构，下周继续验证包装打样和低 MOQ 采购问题。',
      knowledgeCandidates: ['3 秒质地测试首镜', '工厂过程四节点结构', '低 MOQ 采购决策问答'],
      contentPerformance: [
        { orderId: 'showcase-tiktok-1', projectId: 'showcase-tiktok-texture-test', route: 'clone', platform: 'tiktok', productId: 'GUIANFA-RS-001', productName: '云朵泡沫卸妆蜜', title: '3 秒质地测试：泡沫卸妆是否省步骤', hook: '先展示卸妆前后对比，再解释乳化速度。', framework: ['效果对比', '质地特写', '步骤说明', '采购提示'], publishedTags: ['cleansingbalm', 'beautysupplier', 'privatelabel'], sourceUrl: '', thumbnailUrl: '/demo/feishu-viral-remix-final.jpg', productionStatus: 'completed', publicationStatus: 'published', performance: { status: 'available', views: 44_600, likes: 3_010, comments: 231, shares: 383, leads: 17 } },
        { orderId: 'showcase-facebook-1', projectId: 'showcase-facebook-product-proof', route: 'product', platform: 'facebook', productId: 'GUIANFA-RS-001', productName: '云朵泡沫卸妆蜜', title: '30 秒看懂低 MOQ 定制流程', hook: '直接回答采购商最关心的起订量和交期。', framework: ['采购问题', '过程证据', '交付节点', '询盘引导'], publishedTags: ['lowmoq', 'cosmeticfactory', 'oemodm'], sourceUrl: '', thumbnailUrl: '/demo/thumbs/7654680467647630605.jpg', productionStatus: 'completed', publicationStatus: 'published', performance: { status: 'available', views: 32_700, likes: 2_020, comments: 168, shares: 85, leads: 14 } },
      ],
      approvalFeedback: [{ decision: 'approved', note: '产品事实、画面授权和发布文案均已核对。' }],
      nextPlanRecommendations: ['复用质地测试的首镜钩子', '增加包装打样过程内容', '继续保持不同平台分日发布'],
      nextRoundRecommendations: {
        contentInheritance: {
          status: 'ready',
          sourceContentId: inheritedContentId,
          title: '3 秒质地测试：泡沫卸妆是否省步骤',
          platform: 'TikTok',
          hook: '先展示卸妆前后对比，再解释乳化速度。',
          framework: ['效果对比', '质地特写', '步骤说明', '采购提示'],
          tags: ['cleansingbalm', 'beautysupplier', 'privatelabel'],
          sourceUrl: '',
          thumbnailUrl: '/demo/feishu-viral-remix-final.jpg',
          reason: '本周播放、互动和归因询盘均为同批内容最高，可复用结构但需更换表达与镜头组合。',
          paidBoost: { status: 'recommended_for_review', reason: '互动与询盘表现稳定，可进入小预算复核。' },
          systemActions: ['继承首镜问题结构并生成新的产品证据组合', '保留采购提示，替换重复镜头与措辞'],
        },
        tagAdaptation: {
          status: 'changed',
          publishedTags: ['beautysupplier', 'privatelabel', 'cleansingbalm'],
          hotTags: ['beautysupplier', 'privatelabel', 'lowmoq', 'cosmeticfactory'],
          newTags: ['lowmoq', 'cosmeticfactory'],
          droppedTags: ['skincareroutine'],
          requiresConfirmation: true,
          systemActions: ['把新增 Tag 写入下周候选，不直接覆盖产品事实', '由编导在新脚本中验证低 MOQ 与工厂过程表达'],
        },
        industryTrends,
      },
    },
  } satisfies NonNullable<DigitalEmployeeOverview['review']>;
  return {
    ...overview,
    ...normalized,
    industryTrends,
    businessSnapshot: buildSnapshot({ ...overview, ...normalized }),
    review,
  } as T;
}

function content(
  account: { id: string; title: string },
  platform: PublishingPlatform,
  id: string,
  title: string,
  publishedAt: string,
  metrics: ConnectedSocialPerformanceContent['metrics'],
): ConnectedSocialPerformanceContent {
  const assetIndex = showcaseAssetIndex(id, SHOWCASE_THUMBNAILS.length);
  const videoIndex = showcaseAssetIndex(id, SHOWCASE_VIDEOS.length);
  return {
    id: `${platform}:${account.id}:${id}`,
    accountId: account.id,
    accountTitle: account.title,
    platform,
    title,
    publishedAt,
    thumbnailUrl: SHOWCASE_THUMBNAILS[assetIndex],
    platformUrl: showcaseAssetHref(SHOWCASE_VIDEOS[videoIndex]),
    metrics,
  };
}

export function smartBusinessShowcasePerformance(
  data: DigitalEmployeeOverview,
  enabled = isSmartBusinessShowcaseEnabled(),
): ConnectedSocialPerformance | null {
  if (!enabled) return null;
  const { startsAt, endsAt } = currentRange(data);
  const currentDates = [shiftDay(startsAt, 1), shiftDay(startsAt, 2), shiftDay(startsAt, 4), shiftDay(startsAt, 5)].map(date => date > endsAt ? endsAt : date);
  const previousDates = [shiftDay(startsAt, -3), shiftDay(startsAt, -1)];
  const facebook = configuredAccount(data, 'facebook');
  const tiktok = configuredAccount(data, 'tiktok');
  const instagram = configuredAccount(data, 'instagram');
  const youtube = configuredAccount(data, 'youtube');
  const accounts = [
    { ...facebook, platform: 'facebook' as const, handle: '@aurelia.beauty', followerCount: 18_620, videoCount: 46, viewCount: 682_400 },
    { ...tiktok, platform: 'tiktok' as const, handle: '@aurelia_lab', followerCount: 26_480, videoCount: 58, viewCount: 1_126_800 },
    { ...instagram, platform: 'instagram' as const, handle: '@aurelia.beauty.lab', followerCount: 14_350, videoCount: 39, viewCount: 514_700 },
    { ...youtube, platform: 'youtube' as const, handle: '@AureliaBeautyLab', followerCount: 9_860, videoCount: 31, viewCount: 796_200 },
  ].map(item => ({ ...item, lastSyncAt: `${endsAt}T17:55:00+08:00` }));
  const contents = [
    content(facebook, 'facebook', 'fb-current-1', '30 秒看懂低 MOQ 定制流程', `${currentDates[0]}T18:00:00+08:00`, { views: 32_700, likes: 2_020, comments: 168, shares: 85 }),
    content(facebook, 'facebook', 'fb-current-2', '云朵泡沫卸妆蜜：油妆快速乳化测试', `${currentDates[2]}T18:00:00+08:00`, { views: 25_700, likes: 1_400, comments: 118, shares: 63 }),
    content(tiktok, 'tiktok', 'tt-current-1', '3 秒质地测试：泡沫卸妆是否省步骤', `${currentDates[1]}T18:00:00+08:00`, { views: 44_600, likes: 3_010, comments: 231, shares: 383 }),
    content(tiktok, 'tiktok', 'tt-current-2', '工厂视角：从配方到灌装的 4 个节点', `${currentDates[3]}T18:00:00+08:00`, { views: 32_700, likes: 2_120, comments: 181, shares: 288 }),
    content(instagram, 'instagram', 'ig-current-1', '包装打样前必须确认的 3 个细节', `${currentDates[2]}T18:00:00+08:00`, { views: 31_500, likes: 2_180, comments: 149, shares: 126 }),
    content(youtube, 'youtube', 'yt-current-1', '从配方确认到出货：护肤品生产全流程', `${currentDates[1]}T18:00:00+08:00`, { views: 48_600, likes: 2_950, comments: 205, shares: 229 }),
    content(facebook, 'facebook', 'fb-previous-1', '采购商如何判断包装起订量', `${previousDates[0]}T18:00:00+08:00`, { views: 16_400, likes: 860, comments: 72, shares: 35 }),
    content(facebook, 'facebook', 'fb-previous-2', '成分表与配方声明核对清单', `${previousDates[1]}T18:00:00+08:00`, { views: 19_800, likes: 1_020, comments: 86, shares: 41 }),
    content(tiktok, 'tiktok', 'tt-previous-1', '15 秒看懂乳化测试', `${previousDates[0]}T18:00:00+08:00`, { views: 27_600, likes: 1_640, comments: 129, shares: 112 }),
    content(tiktok, 'tiktok', 'tt-previous-2', '洁面慕斯起泡过程', `${previousDates[1]}T18:00:00+08:00`, { views: 24_900, likes: 1_510, comments: 118, shares: 97 }),
    content(instagram, 'instagram', 'ig-previous-1', '包装色样确认过程', `${previousDates[0]}T18:00:00+08:00`, { views: 18_600, likes: 1_180, comments: 82, shares: 54 }),
    content(instagram, 'instagram', 'ig-previous-2', '实验室稳定性测试记录', `${previousDates[1]}T18:00:00+08:00`, { views: 21_400, likes: 1_330, comments: 91, shares: 62 }),
    content(youtube, 'youtube', 'yt-previous-1', 'OEM 生产线参观：灌装与质检', `${previousDates[0]}T18:00:00+08:00`, { views: 33_800, likes: 1_940, comments: 136, shares: 149 }),
    content(youtube, 'youtube', 'yt-previous-2', '采购打样到量产的时间线', `${previousDates[1]}T18:00:00+08:00`, { views: 37_200, likes: 2_130, comments: 151, shares: 168 }),
  ];
  return { accounts, contents, unavailable: [], loadedAt: `${endsAt}T17:55:00+08:00` };
}

export type SmartBusinessShowcaseWeeklyVideo = {
  id: string;
  title: string;
  productName: string;
  thumbnailUrl: string;
  platform: PublishingPlatform;
  accountId: string;
  accountLabel: string;
  plannedPublishDate: string;
  plannedPublishAt: string;
  duration: number;
  status: 'planned' | 'waiting_review';
  estimatedCostCny: number;
  budgetMinCny: number;
  budgetMaxCny: number;
};

export function smartBusinessShowcaseWeeklyVideos(
  data: DigitalEmployeeOverview,
  enabled = isSmartBusinessShowcaseEnabled(),
): SmartBusinessShowcaseWeeklyVideo[] | null {
  if (!enabled) return null;
  const { startsAt, endsAt, days } = currentRange(data);
  const performance = smartBusinessShowcasePerformance(data, true)!;
  const currentContents = performance.contents.filter(item => {
    const date = item.publishedAt.slice(0, 10);
    return date >= startsAt && date <= endsAt;
  });
  const sources = currentContents.length ? currentContents : performance.contents;
  const angles = ['采购痛点', '产品实测', '工厂能力', '打样流程', '包装细节', '交付说明'];
  const products = ['云朵泡沫卸妆蜜', '紫苏控油去黑头泥膜 2.0', 'OEM 护肤定制', '低 MOQ 包装打样'];
  const publishHours = ['10:00', '14:00', '18:00', '20:00'];
  return Array.from({ length: SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.plannedVideoCount }, (_, index) => {
    const source = sources[index % sources.length]!;
    const angle = angles[index % angles.length]!;
    const plannedPublishDate = days[index % days.length] || startsAt;
    return {
      id: `showcase-weekly-video-${String(index + 1).padStart(2, '0')}`,
      title: index < sources.length ? source.title : `${source.title} · ${angle}`,
      productName: products[index % products.length]!,
      thumbnailUrl: source.thumbnailUrl || SHOWCASE_THUMBNAILS[showcaseAssetIndex(source.id, SHOWCASE_THUMBNAILS.length)]!,
      platform: source.platform,
      accountId: source.accountId,
      accountLabel: source.accountTitle,
      plannedPublishDate,
      plannedPublishAt: `${plannedPublishDate}T${publishHours[index % publishHours.length]}:00+08:00`,
      duration: [30, 30, 30, 45][index % 4]!,
      status: index < SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.waitingReviewCount ? 'waiting_review' : 'planned',
      estimatedCostCny: SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.budgetMidCny / SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.plannedVideoCount,
      budgetMinCny: SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.budgetMinCny / SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.plannedVideoCount,
      budgetMaxCny: SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.budgetMaxCny / SMART_BUSINESS_SHOWCASE_WEEKLY_TOTALS.plannedVideoCount,
    };
  });
}

export function smartBusinessShowcaseChannels(
  data: DigitalEmployeeOverview,
  enabled = isSmartBusinessShowcaseEnabled() || isSmartBusinessOverviewPreviewEnabled(),
) {
  if (!enabled) return null;
  const facebook = configuredAccount(data, 'facebook');
  return {
    performance: smartBusinessShowcasePerformance(data, true),
    channelsLoaded: true,
    whatsappConnected: true,
    messengerPages: [{ id: facebook.id, providerAccountId: facebook.id, title: facebook.title, status: 'connected', messengerSubscribed: true }],
  };
}

export function smartBusinessShowcaseAds(
  startsAt: string,
  endsAt: string,
  enabled = isSmartBusinessShowcaseEnabled(),
): { tasks: PlatformAdTask[]; entries: ReportEntry[] } | null {
  if (!enabled) return null;
  const days = daysBetween(startsAt.slice(0, 10), endsAt.slice(0, 10));
  const makeTask = (id: string, name: string, channels: string[], budget: number): PlatformAdTask => ({
    id,
    name,
    video: '周期内容组合',
    goal: '获取有效询盘',
    market: '美国',
    budget,
    currency: 'CNY',
    channels,
    status: 'active',
    creationSource: 'ai_managed',
    managementMode: 'approval',
    configuration: { startsAt, endsAt, dailyBudget: budget / Math.max(1, days.length), audience: '美妆品牌采购与产品负责人', placements: '自动版位' },
    createdAt: `${startsAt}T09:00:00+08:00`,
    updatedAt: `${endsAt}T17:55:00+08:00`,
  });
  const tasks = [
    makeTask('showcase-meta-leads', '品牌采购线索 · Meta', ['facebook', 'instagram'], 720),
    makeTask('showcase-tiktok-leads', '产品测试线索 · TikTok', ['tiktok'], 960),
  ];
  const taskTotals = [
    { spend: 720, clicks: 2_760, impressions: 118_000 },
    { spend: 960, clicks: 4_080, impressions: 166_000 },
  ];
  const distribute = (value: number, count: number, precision = 0) => {
    const factor = 10 ** precision;
    const units = Math.round(value * factor);
    const base = Math.floor(units / Math.max(1, count));
    const remainder = units - base * Math.max(1, count);
    return Array.from({ length: Math.max(1, count) }, (_, index) => (base + (index < remainder ? 1 : 0)) / factor);
  };
  const entries = tasks.map((task, taskIndex): ReportEntry => {
    const total = taskTotals[taskIndex];
    const spend = distribute(total.spend, days.length, 2);
    const clicks = distribute(total.clicks, days.length);
    const impressions = distribute(total.impressions, days.length);
    const daily = days.map((date, index) => ({ date, spend: spend[index], clicks: clicks[index], impressions: impressions[index] }));
    const report: AdReport = {
      source: 'provider',
      stale: false,
      currency: 'CNY',
      reportedAt: `${endsAt}T17:55:00+08:00`,
      window: { since: startsAt, until: endsAt },
      spend: total.spend,
      clicks: total.clicks,
      impressions: total.impressions,
      daily,
    };
    return { ...task, report };
  });
  return { tasks, entries };
}
