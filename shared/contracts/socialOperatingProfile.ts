export type SocialOperatingProfileId = 'starter_four_platform' | 'dual_account_growth';
export type SocialOperatingStage = 'validation' | 'growth';
export type SocialOperatingPlatform = 'tiktok' | 'facebook' | 'instagram' | 'youtube' | 'linkedin';
export type SocialAccountRole = 'brand_capability' | 'buyer_advisor' | 'brand_combined';

export interface SocialPlatformAccountPlan {
  platform: SocialOperatingPlatform;
  accountRole: SocialAccountRole;
  weeklyVideoCount: number;
  weeklyNonVideoCount: number;
  formats: string[];
  purpose: string;
}

export interface SocialOperatingProfile {
  id: SocialOperatingProfileId;
  stage: SocialOperatingStage;
  name: string;
  description: string;
  accounts: SocialPlatformAccountPlan[];
  weeklyTargets: {
    /** New source videos, before platform adaptation and distribution. */
    baseVideoOriginals: number;
    /** New source articles or carousels, before platform adaptation. */
    baseNonVideoOriginals: number;
    /** Platform/account-specific derivatives; never counted as new originals. */
    adaptationVersions: number;
    /** One approved deliverable sent to one account counts as one task. */
    publicationTasks: number;
  };
  activationGates: string[];
}

const starterAccounts: SocialPlatformAccountPlan[] = [
  { platform: 'tiktok', accountRole: 'brand_combined', weeklyVideoCount: 5, weeklyNonVideoCount: 0, formats: ['native_short_video'], purpose: '用买家问题、产品演示和过程证据验证短视频需求。' },
  { platform: 'facebook', accountRole: 'brand_combined', weeklyVideoCount: 5, weeklyNonVideoCount: 1, formats: ['reel', 'buyer_article'], purpose: '沉淀供应能力、采购说明与 WhatsApp/主页承接。' },
  { platform: 'instagram', accountRole: 'brand_combined', weeklyVideoCount: 3, weeklyNonVideoCount: 1, formats: ['reel', 'carousel'], purpose: '用视觉化产品证据和可收藏清单建立信任。' },
  { platform: 'youtube', accountRole: 'brand_combined', weeklyVideoCount: 3, weeklyNonVideoCount: 0, formats: ['short'], purpose: '用可搜索的买家问题与长期内容资产承接采购意图。' },
];

const growthAccounts: SocialPlatformAccountPlan[] = [
  { platform: 'tiktok', accountRole: 'brand_capability', weeklyVideoCount: 5, weeklyNonVideoCount: 0, formats: ['native_short_video'], purpose: '展示工厂、产品、交付和可核验能力。' },
  { platform: 'tiktok', accountRole: 'buyer_advisor', weeklyVideoCount: 5, weeklyNonVideoCount: 0, formats: ['native_short_video'], purpose: '围绕采购决策、避坑和选型问题建立专业信任。' },
  { platform: 'facebook', accountRole: 'brand_capability', weeklyVideoCount: 5, weeklyNonVideoCount: 0, formats: ['reel'], purpose: '承接企业身份、能力证据和稳定供货叙事。' },
  { platform: 'facebook', accountRole: 'buyer_advisor', weeklyVideoCount: 5, weeklyNonVideoCount: 0, formats: ['reel'], purpose: '承接采购教育、评论互动和询盘筛选。' },
  { platform: 'instagram', accountRole: 'brand_combined', weeklyVideoCount: 3, weeklyNonVideoCount: 0, formats: ['reel'], purpose: '精选高视觉密度版本，不机械搬运全量内容。' },
  { platform: 'youtube', accountRole: 'brand_combined', weeklyVideoCount: 3, weeklyNonVideoCount: 0, formats: ['short'], purpose: '精选搜索价值最高的版本形成长期资产。' },
];

export const SOCIAL_OPERATING_PROFILES: Record<SocialOperatingProfileId, SocialOperatingProfile> = {
  starter_four_platform: {
    id: 'starter_four_platform',
    stage: 'validation',
    name: '四平台单账号验证',
    description: '每个平台先使用一个综合账号，以 5 条基础视频和 1 篇基础采购内容完成 18 次差异化发布。',
    accounts: starterAccounts,
    weeklyTargets: { baseVideoOriginals: 5, baseNonVideoOriginals: 1, adaptationVersions: 12, publicationTasks: 18 },
    activationGates: [
      '四个平台至少各有一个已确认账号或明确标记为待接入。',
      '企业事实、重点产品、目标市场、买家角色和承接入口已确认。',
      '发布仍须通过账号、内容哈希、质量门和人工授权校验。',
    ],
  },
  dual_account_growth: {
    id: 'dual_account_growth',
    stage: 'growth',
    name: 'TikTok / Facebook 双账号增长',
    description: '仅在验证阶段形成稳定生产与真实询盘证据后，将 TikTok 和 Facebook 拆为品牌能力号与买家顾问号。',
    accounts: growthAccounts,
    weeklyTargets: { baseVideoOriginals: 10, baseNonVideoOriginals: 0, adaptationVersions: 16, publicationTasks: 26 },
    activationGates: [
      '至少连续四周具备可追溯的制作、发布回执和 24 小时 / 7 天数据。',
      '至少出现由业务人员确认的有效询盘，且能够回溯到账号、内容和承接入口。',
      '团队能够稳定完成验证阶段产能；扩号不会稀释事实审核、评论回复和询盘承接。',
      '双账号的受众承诺、首三秒、证据排序、字幕、CTA 与归因标记均已分别定义。',
    ],
  },
};

export const SOCIAL_AGENT_BOUNDARIES = {
  business: {
    owns: ['业务目标', '账号矩阵', '周频次', '预算', 'CTA', '授权范围', '业务复盘'],
    mustNot: ['选择具体镜头参考', '绕过内容质量门', '把互动自动认定为有效询盘'],
  },
  director: {
    owns: ['发现策略', '对标证据', '选题', '脚本', '分镜意图', '爆款因子', '创意验收'],
    mustNot: ['修改账号数量', '修改市场或预算', '替内容 Agent 选择具体模型和素材文件'],
  },
  content: {
    owns: ['素材匹配', '生成与剪辑', '字幕与混音', '技术质检', '成片交付'],
    mustNot: ['修改业务事实', '修改选题和 CTA', '自行发布'],
  },
  platform: {
    owns: ['平台适配', '排期', '逐账号发布', '回执与失败重试'],
    mustNot: ['把排期当作发布成功', '把一个账号回执复制给其他账号'],
  },
  customer: {
    owns: ['评论与私信回流', '来源归因', '客户分层', '跟进草稿与回执'],
    mustNot: ['自行确认有效询盘、报价、样品或成交', '虚构客户身份和采购量'],
  },
} as const;

/**
 * One approved copy is the cross-platform source of truth. Platform adapters
 * may change media packaging and the verified destination, but must not ask a
 * model to rewrite captions or hashtags. Only enterprise facts explicitly
 * bound in the plan may be replaced.
 */
export const SOCIAL_DISTRIBUTION_COPY_POLICY = {
  caption: '同一条已确认发布文案跨平台原样复用，不做平台二次改写。',
  hashtags: '同一组已确认 Tag 跨平台原样复用，不自动增删或排序。',
  replacements: ['商品名', '品牌名', '企业名'] as const,
  sourceReuseGate: '采集原文仅在自有、已授权或用户明确确认可复用时进入发布文案。',
} as const;

export const SOCIAL_PLATFORM_EXECUTION_RULES: Record<SocialOperatingPlatform, {
  adaptation: string[];
  ctaRule: string;
  metrics: string[];
}> = {
  tiktok: {
    adaptation: ['首三秒直接呈现买家问题或结果', '使用平台原生节奏、字幕和声音，不保留其他平台水印', '同源素材必须重排钩子、证据顺序和 CTA'],
    ctaRule: '优先引导主页入口或私信；不承诺未确认的价格、交期或效果。',
    metrics: ['3 秒留存', '平均观看时长', '完整播放率', '主页访问', '有效询盘'],
  },
  facebook: {
    adaptation: ['先给结论与可信证据，再补采购背景', 'Reels 与采购说明文分别组织，不把长文硬塞进视频字幕', '评论问题需回流客户工作台'],
    ctaRule: '使用已验证的主页、表单或 WhatsApp 承接入口。',
    metrics: ['3 秒播放', '一分钟观看（适用时）', '互动', '链接点击', '有效询盘'],
  },
  instagram: {
    adaptation: ['强化封面、构图和可收藏信息', 'Reels 与轮播图分别设计信息层级', '保留产品身份，避免把风格统一误当作画面复制'],
    ctaRule: '引导主页入口、私信或已配置表单。',
    metrics: ['播放', '分享', '收藏', '主页访问', '有效询盘'],
  },
  youtube: {
    adaptation: ['标题围绕一个可搜索的买家问题', 'Shorts 只保留最完整的一条证据链', '频道身份、描述和主页采购入口保持一致'],
    ctaRule: '采购链接放在频道个人资料入口；不得把 Shorts 评论或描述中的普通 URL 当作可点击承接。',
    metrics: ['选择观看率', '平均观看时长', '观看百分比', '频道访问', '有效询盘'],
  },
  linkedin: {
    adaptation: ['首段先交代业务问题与可核验证据', '正文使用专业短段落，避免消费化口号堆叠', '视频标题和正文保持企业采购语境'],
    ctaRule: '优先引导私信、主页或已验证的企业承接入口；不承诺未确认的价格、交期或认证。',
    metrics: ['视频观看', '互动', '主页访问', '私信', '有效询盘'],
  },
};

/** Discovery is account-led: keyword search is only used to nominate accounts for approval, never to fill production inventory. */
export const SOCIAL_DISCOVERY_BASELINE = [
  { mode: 'account', percent: 100, purpose: '只追踪已确认对标账号的高表现视频与图文；图文必须同时保留原帖配文，候选通过生产准入后才进入内容链路。' },
] as const;

export function socialDiscoveryMixIssues(mix: ReadonlyArray<{ mode: string; percent: number }>): string[] {
  const issues: string[] = [];
  const percentages = mix.map(item => Number(item.percent));
  if (new Set(mix.map(item => item.mode)).size !== mix.length) issues.push('发现模式不可重复');
  if (percentages.some(percent => !Number.isFinite(percent) || percent < 0 || percent > 100)) issues.push('发现模式比例须为 0–100');
  const total = percentages.reduce((sum, percent) => sum + (Number.isFinite(percent) ? percent : 0), 0);
  if (Math.abs(total - 100) > 0.01) issues.push(`发现模式比例合计须为 100（当前 ${Number(total.toFixed(2))}）`);
  return issues;
}

export function socialOperatingProfile(id: unknown): SocialOperatingProfile {
  return SOCIAL_OPERATING_PROFILES[id === 'dual_account_growth' ? 'dual_account_growth' : 'starter_four_platform'];
}

export function socialOperatingProfileIssues(profile: SocialOperatingProfile): string[] {
  const targets = profile.weeklyTargets;
  const publicationTasks = profile.accounts.reduce((sum, item) => sum + item.weeklyVideoCount + item.weeklyNonVideoCount, 0);
  const originals = targets.baseVideoOriginals + targets.baseNonVideoOriginals;
  const issues: string[] = [];
  if (publicationTasks !== targets.publicationTasks) issues.push('平台账号计划与发布任务总数不一致');
  if (originals + targets.adaptationVersions !== targets.publicationTasks) issues.push('原创、改编版本与发布任务总数不守恒');
  if (profile.accounts.some(item => item.weeklyVideoCount < 0 || item.weeklyNonVideoCount < 0 || !item.formats.length)) issues.push('平台账号计划包含无效数量或空格式');
  return issues;
}

export function connectedAccountIssues(
  id: SocialOperatingProfileId,
  targets: Array<{ platform: string; accountId: string }>,
): string[] {
  const profile = socialOperatingProfile(id);
  const required = new Map<SocialOperatingPlatform, number>();
  for (const row of profile.accounts) required.set(row.platform, (required.get(row.platform) || 0) + 1);
  return [...required].flatMap(([platform, count]) => {
    const actual = new Set(targets.filter(target => target.platform === platform && target.accountId).map(target => target.accountId)).size;
    return actual >= count ? [] : [`${platform} 需要 ${count} 个账号，当前已接入 ${actual} 个`];
  });
}

export function platformExecutionConstraints(platform: string): string[] {
  return platform in SOCIAL_PLATFORM_EXECUTION_RULES
    ? [
        SOCIAL_DISTRIBUTION_COPY_POLICY.caption,
        SOCIAL_DISTRIBUTION_COPY_POLICY.hashtags,
        ...SOCIAL_PLATFORM_EXECUTION_RULES[platform as SocialOperatingPlatform].adaptation,
        SOCIAL_PLATFORM_EXECUTION_RULES[platform as SocialOperatingPlatform].ctaRule,
      ]
    : [];
}
