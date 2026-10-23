import {
  SOCIAL_CONTENT_THEME_IDS,
  SOCIAL_MATERIAL_REQUIREMENT_STATUSES,
  type SocialContentThemeCard,
  type SocialContentThemeId,
  type SocialContentThemeSelection,
  type SocialMaterialReadiness,
  type SocialMaterialRequirement,
  type SocialMaterialRequirementStatus,
  type SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialText } from './socialContentValidation.js';

export const SOCIAL_THEME_CATALOG: readonly SocialContentThemeCard[] = [
  {
    themeId: 'product_value',
    name: '产品与卖点',
    description: '讲清产品是什么、关键能力和可验证的差异。',
    exampleTopics: ['新品核心卖点', '原料与工艺细节', '性能实测'],
    minimumShots: ['产品全貌', '关键细节', '使用或性能演示', '可验证证据'],
  },
  {
    themeId: 'scenario_solution',
    name: '场景与解决方案',
    description: '从真实使用场景和问题出发，展示解决过程与边界。',
    exampleTopics: ['高温环境怎么用', '客户常见问题解决', '使用前后对比'],
    minimumShots: ['场景或对象', '具体问题', '解决动作', '可见结果或适用边界'],
  },
  {
    themeId: 'supplier_capability',
    name: '企业与供应保障',
    description: '展示团队、制造或供应协同、质检与交付保障。',
    exampleTopics: ['生产流程', '质量控制', '仓储与交付'],
    minimumShots: ['场所或团队', '流程', '质量检查点', '仓储或交付'],
  },
  {
    themeId: 'customization_process',
    name: '定制与合作流程',
    description: '让买家知道从需求到打样、生产和交付如何推进。',
    exampleTopics: ['OEM/ODM合作流程', '打样周期', '包装定制'],
    minimumShots: ['需求', '可选方案', '样品', '确认', '生产或交付'],
  },
  {
    themeId: 'customer_case',
    name: '客户案例与合作成果',
    description: '在获得授权且证据可核验的前提下讲合作结果。',
    exampleTopics: ['客户问题与方案', '合作过程', '可核验成果'],
    minimumShots: ['获授权的背景', '问题', '方案过程', '可核验结果', '授权证明'],
  },
] as const;

export interface InternalFormulaNode {
  nodeId: string;
  shotFunction?: string;
  subject?: string;
  action?: string;
  environment?: string | null;
  orientation?: 'portrait' | 'landscape' | 'either';
  durationSeconds?: { minimum: number; maximum: number } | null;
  required?: boolean;
  /** Director-owned visual grammar. Drafts may omit it; released formulas may not. */
  shotType?: 'live_action' | 'product_demo' | 'process' | 'talking_head' | 'graphic';
  shotSize?: 'extreme_close_up' | 'close_up' | 'medium' | 'wide' | 'detail';
  cameraMovement?: 'static' | 'pan' | 'tilt' | 'push_in' | 'pull_out' | 'tracking' | 'handheld';
  composition?: string;
  transition?: 'cut' | 'match_cut' | 'dissolve' | 'fade' | 'wipe';
  /** Executable script owned by the formula; never returned in customer task payloads. */
  narrationTemplate?: { zh: string; en: string };
  /** All three are mandatory before trial/release and are never synthesized by the registry. */
  scriptTemplate?: { zh: string; en: string };
  voiceoverTemplate?: { zh: string; en: string };
  captionTemplate?: { zh: string; en: string };
}

export interface InternalSocialContentFormulaDirection {
  pace?: 'fast' | 'balanced' | 'steady';
  visualStyle?: string;
  music?: {
    mood?: string;
    volume?: number;
    strategy?: string;
    sourceType?: 'licensed_library' | 'original' | 'none';
    licenseVerified?: boolean;
    licenseReference?: string | null;
  };
  voiceover?: {
    voice?: string;
    preset?: 'tiktok_excited' | 'authentic_review' | 'professional_b2b' | 'warm_story' | 'urgent_cta';
    speed?: number;
    pauseStyle?: 'few' | 'natural' | 'dramatic';
  };
  subtitles?: { fontScale?: number; bottomRatio?: number; styleIntent?: string };
  cover?: {
    intent?: string;
    headlineTemplate?: { zh: string; en: string };
    subject?: string;
    composition?: string;
  };
  materialFallback?: {
    minimumUsableClips?: number;
    allowStillFrames?: boolean;
    allowRepeatedClips?: boolean;
    maxRepeatCount?: number;
    insufficientMaterialAction?: 'adapt_with_verified_assets' | 'request_reshoot' | 'block';
  };
  risks?: {
    prohibitedClaims?: string[];
    prohibitedVisuals?: string[];
    mandatoryDisclosures?: string[];
  };
  acceptanceGates?: Array<{ gateId: string; name: string; rule: string; blocking: boolean }>;
}

export interface InternalSocialContentFormula {
  recordId?: string;
  formulaId: string;
  version: string;
  name: string;
  themeId: SocialContentThemeId;
  status: 'draft' | 'internal_trial' | 'gray' | 'active' | 'disabled';
  rollout: { percentage: number; tenantAllowlist: string[] };
  audit: Array<{ event: string; actor: string; at: string; note?: string }>;
  direction?: InternalSocialContentFormulaDirection;
  nodes: InternalFormulaNode[];
}

/**
 * Intentionally empty. The admin-facing registry and rollout mechanism stay in
 * place, but no formula is silently bundled into customer production. Until an
 * administrator authors and releases one, Director Agent falls back to an
 * analyzed inspiration script and then to the verified-knowledge skeleton.
 */
export const INTERNAL_SOCIAL_CONTENT_FORMULAS: readonly InternalSocialContentFormula[] = [];

const CLASSIFICATION_KEYWORDS: Record<SocialContentThemeId, readonly string[]> = {
  product_value: ['产品', '卖点', '原料', '配方', '材质', '参数', '性能', '成分', '功效', '新品'],
  scenario_solution: ['场景', '使用', '问题', '痛点', '解决', '怎么用', '适用', '效果'],
  supplier_capability: ['工厂', '车间', '产线', '生产', '质检', '仓库', '交付', '供应', '团队', '产能'],
  customization_process: ['定制', '合作', '打样', 'oem', 'odm', '包装', '起订', '流程', '需求'],
  customer_case: ['客户', '案例', '合作成果', '复购', '增长', '结果', '品牌'],
};

export function classifySocialCustomTopic(topicValue: string): SocialContentThemeSelection {
  const topic = topicValue.trim();
  const normalized = topic.toLowerCase();
  const scores = SOCIAL_CONTENT_THEME_IDS.map(themeId => ({
    themeId,
    score: CLASSIFICATION_KEYWORDS[themeId].filter(keyword => normalized.includes(keyword)).length,
  })).sort((a, b) => b.score - a.score);
  const best = scores[0];
  const tied = best.score > 0 && scores[1]?.score === best.score;
  return {
    themeId: best.score > 0 && !tied ? best.themeId : null,
    inputKind: 'custom',
    topic,
    classificationStatus: best.score > 0 && !tied ? 'confirmed' : 'pending_confirmation',
  };
}

export function resolveSocialThemeSelection(input: {
  themeId?: SocialContentThemeId | null;
  customTopic?: string | null;
  topic?: string | null;
}): SocialContentThemeSelection | null {
  const customTopic = socialText(input.customTopic);
  if (input.themeId) {
    if (!SOCIAL_CONTENT_THEME_IDS.includes(input.themeId)) {
      throw new SocialContentWorkflowError('social_content_theme_invalid', 400);
    }
    return {
      themeId: input.themeId,
      inputKind: customTopic ? 'custom' : 'preset',
      topic: customTopic || socialText(input.topic),
      classificationStatus: 'confirmed',
    };
  }
  return customTopic ? classifySocialCustomTopic(customTopic) : null;
}

export function formulaForTheme(themeId: SocialContentThemeId): InternalSocialContentFormula {
  const formula = INTERNAL_SOCIAL_CONTENT_FORMULAS.find(item => item.themeId === themeId && item.status === 'active');
  if (!formula) throw new SocialContentWorkflowError('social_content_formula_unavailable', 503);
  return formula;
}

export interface StoredMaterialRequirement extends SocialMaterialRequirement {
  /** Server-only formula node reference; stripped by public serializers. */
  formulaNodeId: string;
}

export function initialMaterialRequirements(
  themeId: SocialContentThemeId,
  timestamp: string,
  selectedFormula?: InternalSocialContentFormula,
  mode: 'formula' | 'advisory' = 'formula',
): { formulaReference: { formulaId: string; version: string }; requirements: StoredMaterialRequirement[] } {
  const formula = selectedFormula ?? formulaForTheme(themeId);
  if (formula.themeId !== themeId || !['active', 'gray', 'internal_trial'].includes(formula.status)) {
    throw new SocialContentWorkflowError('social_content_formula_unavailable', 503);
  }
  return {
    formulaReference: { formulaId: formula.formulaId, version: formula.version },
    requirements: formula.nodes.map((item, index) => ({
      requirementId: `material:${themeId}:${index + 1}`,
      // Themes only describe what the content is about. Until a formula is
      // explicitly applied to a production task, its shot structure is an
      // advisory checklist and must never block the user from starting.
      required: mode === 'formula' ? item.required === true : false,
      targetTheme: themeId,
      shotFunction: item.shotFunction!,
      subject: item.subject!,
      action: item.action!,
      environment: item.environment ?? null,
      orientation: item.orientation!,
      durationSeconds: item.durationSeconds ?? null,
      status: 'missing',
      matchedSourceIds: [],
      confidence: null,
      reason: '尚未匹配素材',
      recalculatedAt: timestamp,
      ruleVersion: 'material-match-v1',
      formulaNodeId: item.nodeId,
    })),
  };
}

const numberValue = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function parseStoredMaterialRequirements(value: unknown): StoredMaterialRequirement[] {
  const parsed = socialJson(value);
  if (parsed === undefined || parsed === null || parsed === '') return [];
  if (!Array.isArray(parsed)) throw new SocialContentWorkflowError('social_material_requirements_invalid', 503);
  return parsed.map(item => {
    const row = socialObject(item);
    const targetTheme = socialText(row?.targetTheme) as SocialContentThemeId;
    const status = socialText(row?.status) as SocialMaterialRequirementStatus;
    const orientation = socialText(row?.orientation) as StoredMaterialRequirement['orientation'];
    const duration = socialObject(row?.durationSeconds);
    const matched = socialJson(row?.matchedSourceIds);
    if (!row || !SOCIAL_CONTENT_THEME_IDS.includes(targetTheme)
      || !SOCIAL_MATERIAL_REQUIREMENT_STATUSES.includes(status)
      || !['portrait', 'landscape', 'either'].includes(orientation)
      || !Array.isArray(matched) || matched.some(value => !socialText(value))) {
      throw new SocialContentWorkflowError('social_material_requirements_invalid', 503);
    }
    const minimum = numberValue(duration?.minimum);
    const maximum = numberValue(duration?.maximum);
    return {
      requirementId: socialText(row.requirementId),
      required: row.required === true,
      targetTheme,
      shotFunction: socialText(row.shotFunction),
      subject: socialText(row.subject),
      action: socialText(row.action),
      environment: socialText(row.environment) || null,
      orientation,
      durationSeconds: minimum !== null && maximum !== null ? { minimum, maximum } : null,
      status,
      matchedSourceIds: matched.map(socialText),
      confidence: numberValue(row.confidence),
      reason: socialText(row.reason) || null,
      recalculatedAt: socialText(row.recalculatedAt),
      ruleVersion: socialText(row.ruleVersion),
      formulaNodeId: socialText(row.formulaNodeId),
    };
  });
}

export function publicMaterialRequirements(requirements: StoredMaterialRequirement[]): SocialMaterialRequirement[] {
  return requirements.map(({ formulaNodeId: _formulaNodeId, ...requirement }) => requirement);
}

export function materialReadiness(requirements: SocialMaterialRequirement[]): SocialMaterialReadiness {
  const required = requirements.filter(item => item.required);
  const satisfied = required.filter(item => item.status === 'satisfied');
  return {
    complete: required.length === satisfied.length,
    requiredCount: required.length,
    satisfiedRequiredCount: satisfied.length,
    blockingRequirementIds: required.filter(item => item.status !== 'satisfied').map(item => item.requirementId),
  };
}

export function advisoryMaterialRequirements(
  requirements: StoredMaterialRequirement[],
): StoredMaterialRequirement[] {
  return requirements.map(requirement => requirement.required
    ? { ...requirement, required: false }
    : requirement);
}

export function recomputeMaterialRequirements(
  requirements: StoredMaterialRequirement[],
  sources: Pick<SocialTaskSource, 'sourceId' | 'kind' | 'label' | 'purpose' | 'status'>[],
  timestamp: string,
): StoredMaterialRequirement[] {
  const usable = sources.filter(source => source.status === 'active' && ['material', 'reference_link'].includes(source.kind));
  const unassigned = new Set(usable.map(source => source.sourceId));
  return requirements.map(requirement => {
    const searchable = `${requirement.requirementId} ${requirement.formulaNodeId} ${requirement.shotFunction} ${requirement.subject}`.toLowerCase();
    let matches = usable.filter(source => {
      const purpose = `${source.purpose ?? ''} ${source.label}`.toLowerCase();
      return Boolean(purpose) && (purpose.includes(requirement.requirementId.toLowerCase())
        || purpose.includes(requirement.formulaNodeId.toLowerCase())
        || purpose.split(/[\s,，、;；]+/).some(token => token.length >= 2 && searchable.includes(token)));
    });
    if (!matches.length) {
      const fallback = usable.find(source => unassigned.has(source.sourceId));
      if (fallback) matches = [fallback];
    }
    matches.forEach(source => unassigned.delete(source.sourceId));
    const flags = matches.map(source => `${source.label} ${source.purpose ?? ''}`.toLowerCase()).join(' ');
    let status: SocialMaterialRequirementStatus = 'missing';
    let confidence: number | null = null;
    let reason = '尚未匹配素材';
    if (matches.length) {
      if (/不可用|损坏|模糊|unusable|invalid/.test(flags)) {
        status = 'unusable'; confidence = 0; reason = '匹配素材已标记为不可用';
      } else if (/待确认|pending|需确认/.test(flags)) {
        status = 'pending_confirmation'; confidence = 0.5; reason = '素材已匹配，仍需确认是否满足拍摄要求';
      } else if (matches.every(source => source.kind === 'reference_link')) {
        status = 'partial'; confidence = 0.45; reason = '参考链接只能辅助说明，仍需可用于制作的原始素材';
      } else {
        status = 'satisfied'; confidence = matches.some(source => `${source.purpose ?? ''}`.includes(requirement.requirementId)) ? 1 : 0.75;
        reason = '已匹配可用于制作的素材';
      }
    }
    return {
      ...requirement,
      status,
      matchedSourceIds: matches.map(source => source.sourceId),
      confidence,
      reason,
      recalculatedAt: timestamp,
      ruleVersion: 'material-match-v1',
    };
  });
}
