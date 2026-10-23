import { normalizeVideoPlan, type VideoCreationPlan } from './videoCreationPlan';
import { bindMatrixVideo, type MatrixAccountPlan } from './weeklyMatrix';

export type WeeklyTaskPackagePresetId = 'b2b_starting' | 'b2b_growing' | 'brand_authority' | 'dtc_sales';
export type WeeklyTaskPackagePlatform = VideoCreationPlan['platform'];

export interface WeeklyTaskPackagePreset {
  id: WeeklyTaskPackagePresetId;
  label: string;
  shortLabel: string;
  description: string;
  primaryPlatform: WeeklyTaskPackagePlatform;
  platforms: WeeklyTaskPackagePlatform[];
  weeklyOutput: number;
  frequency: string;
  accountRoles: string;
  themes: string[];
  metric: 'approved_content_packages' | 'published_posts' | 'qualified_inquiries';
  objective: string;
}

export const WEEKLY_TASK_PACKAGE_PRESETS: WeeklyTaskPackagePreset[] = [
  {
    id: 'b2b_starting',
    label: 'B2B 从零起步',
    shortLabel: '从零验证',
    description: '先用专业内容验证主平台、买家问题和稳定更新能力。',
    primaryPlatform: 'youtube',
    platforms: ['youtube', 'tiktok', 'instagram', 'facebook'],
    weeklyOutput: 5,
    frequency: '每周 5 条原创短视频，周一至周五制作，周末分发或补排',
    accountRoles: '品牌综合频道起步，验证后再拆工厂号或专家号',
    themes: ['选型教程：帮助买家理解一个具体选型问题', '产品测试：用真实素材回答一个采购疑问', '采购答疑：回答常见采购条件', '产品演示：展示有证据的产品用途', '供应能力：展示真实生产或交付过程'],
    metric: 'approved_content_packages',
    objective: '完成首轮平台与内容方向验证，形成可持续的 B2B 内容起步节奏',
  },
  {
    id: 'b2b_growing',
    label: 'B2B 已有基础',
    shortLabel: '改进放大',
    description: '复盘历史内容，放大有效路线，并测试新的专业内容方向。',
    primaryPlatform: 'youtube',
    platforms: ['youtube', 'tiktok', 'instagram', 'facebook'],
    weeklyOutput: 5,
    frequency: '每周 5 条原创短视频，周一至周五制作，周末分发或补排',
    accountRoles: '主品牌频道持续运营，按证据增加区域号或专家号',
    themes: ['深度教程：回答高频采购问题', '测试对比：展示真实验证过程', '案例记录：复盘一次真实合作或交付', '客户访谈：整理买家关心的问题', '有效内容复刻：复用自身账号已验证的表达结构'],
    metric: 'qualified_inquiries',
    objective: '复用有效内容路线并持续改进，提升来自内容的高质量询盘',
  },
  {
    id: 'brand_authority',
    label: '品牌影响',
    shortLabel: '建立权威',
    description: '用完整教程、研究说明和专家内容建立长期信任。',
    primaryPlatform: 'youtube',
    platforms: ['youtube', 'tiktok', 'instagram', 'facebook'],
    weeklyOutput: 3,
    frequency: 'YouTube 每周 1 条长视频 + 2 条 Shorts',
    accountRoles: '品牌专家频道为主，必要时增加独立语言频道',
    themes: ['完整教程：系统回答一个行业问题', '研究说明：用已确认事实解释专业结论', '专家答疑：回应目标客户高频问题'],
    metric: 'approved_content_packages',
    objective: '持续输出来源清晰的专业内容，建立可搜索、可复用的品牌信任资产',
  },
  {
    id: 'dtc_sales',
    label: 'DTC 直接销售',
    shortLabel: '成交验证',
    description: '围绕真实产品演示、用户问题和购买路径验证成交内容。',
    primaryPlatform: 'tiktok',
    platforms: ['tiktok', 'instagram', 'youtube', 'facebook'],
    weeklyOutput: 5,
    frequency: 'TikTok 主号每周 5 条，稳定后再增加人物号或场景号',
    accountRoles: '品牌商品号起步，验证后再增加真实主持人或创作者号',
    themes: ['痛点演示：展示产品解决的真实问题', '使用教程：讲清正确用法和注意事项', '对比说明：只比较有证据支持的差异', '用户问题：回答购买前的常见疑问', '真实场景：展示产品在日常场景中的使用'],
    metric: 'published_posts',
    objective: '用真实素材验证能带来访问、咨询或订单的产品内容方向',
  },
];

export function weeklyTaskPackagePreset(id: WeeklyTaskPackagePresetId): WeeklyTaskPackagePreset {
  return WEEKLY_TASK_PACKAGE_PRESETS.find(item => item.id === id) ?? WEEKLY_TASK_PACKAGE_PRESETS[0]!;
}

export function buildPresetVideoPlans(input: {
  preset: WeeklyTaskPackagePreset;
  productName: string;
  focus?: string;
  defaults?: Partial<VideoCreationPlan>;
  platforms?: WeeklyTaskPackagePlatform[];
}): VideoCreationPlan[] {
  const focus = input.focus?.trim();
  const platforms = input.platforms?.length ? input.platforms : input.preset.platforms;
  const primaryPlatform = platforms.includes(input.preset.primaryPlatform)
    ? input.preset.primaryPlatform
    : platforms[0]!;
  return input.preset.themes.slice(0, input.preset.weeklyOutput).map((theme, index) => normalizeVideoPlan({
    ...input.defaults,
    route: 'clone',
    presenter: 'material',
    productName: input.productName,
    platform: index === 0 ? primaryPlatform : platforms[index % platforms.length]!,
    theme: focus ? `${theme}；本周重点：${focus}` : theme,
    duration: input.preset.primaryPlatform === 'youtube' && /长视频/.test(theme) ? 90 : 30,
  }));
}

/**
 * Expand the preset's editorial directions into the account matrix's actual
 * weekly video slots. The preset themes describe what to make; the matrix
 * quotas determine how many platform/account deliverables will be made.
 */
export function buildPresetMatrixVideoPlans(input: {
  preset: WeeklyTaskPackagePreset;
  productName: string;
  focus?: string;
  defaults?: Partial<VideoCreationPlan>;
  platforms?: WeeklyTaskPackagePlatform[];
  matrixRows: MatrixAccountPlan[];
  idFactory?: () => string;
}): VideoCreationPlan[] {
  const seeds = buildPresetVideoPlans(input);
  if (!input.matrixRows.length || !seeds.length) return seeds;
  const idFactory = input.idFactory || (() => crypto.randomUUID());
  let slot = 0;
  return input.matrixRows.flatMap(row => Array.from(
    { length: Math.max(0, Math.floor(row.weeklyCount)) },
    () => {
      const seed = seeds[slot % seeds.length]!;
      slot += 1;
      return bindMatrixVideo({ ...seed, contentId: idFactory() }, row);
    },
  )).slice(0, 30);
}
