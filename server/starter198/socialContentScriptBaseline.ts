import type {SocialReplicationJobContext} from '../../shared/contracts/socialContentReplication.js';
import {freezeSocialAccountProductionConstraints,assertSocialAccountProductionConstraints,assertAccountProductionConstraintReuse,type SocialAccountProductionConstraints} from './socialAccountProductionConstraints.js';
import {validContentTemplateStructure,contentTemplateRoleAt,contentTemplateRoleLabel,type ContentTemplateStructureConstraint} from '../../shared/socialContentTemplateStructure.js';
import type {
  SocialContentTaskBrief,
  SocialContentThemeId,
  SocialContentThemeSelection,
  SocialReplicationScriptVersion,
  SocialScriptBaselineSummary,
} from '../../shared/contracts/socialContentWorkflow.js';
import type { EnterpriseProfile } from '../lib/socialContentLegacyPorts.js';
import type { InternalSocialContentFormula } from './socialContentThemes.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialText } from './socialContentValidation.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';

import { SOCIAL_SCRIPT_BASELINE_SCHEMA, SOCIAL_SCRIPT_GROUNDING_VERSION, type SocialEnterpriseFactVersion, type VerifiedSocialScriptContext, type SocialInspirationScriptMatch, type StoredSocialScriptBaseline, type SocialScriptGroundingSource } from './socialContentScriptBaselineContract.js';
export { SOCIAL_SCRIPT_BASELINE_SCHEMA, SOCIAL_SCRIPT_GROUNDING_VERSION } from './socialContentScriptBaselineContract.js';
export type { SocialEnterpriseFactVersion, VerifiedSocialScriptContext, SocialInspirationScriptMatch, StoredSocialScriptBaseline } from './socialContentScriptBaselineContract.js';

import { DEFAULT_SCENES, SAFE_THEME_LABELS, SYSTEM_THEME_SCENES } from './socialContentScriptFallbackScenes.js';
const SYSTEM_THEME_NARRATION: Record<SocialContentThemeId, { zh: string[]; en: string[] }> = {
  product_value: {
    zh: ['别急着划走，先看它真实上手。', '外观、质地和使用过程，都给你拍清楚。', '不靠夸张词，让细节自己说话。', '正在挑同类产品，这款可以继续了解。'],
    en: ['Pause for one real look at the product.', 'See the design, texture, and use up close.', 'No inflated claims—let the details speak.', 'Comparing similar products? This one is worth a closer look.'],
  },
  scenario_solution: {
    zh: ['先看真实场景，再判断解决思路。', '把使用过程拆开，逐步观察关键动作。', '结果只说明画面中能够确认的部分。', '具体适用条件，请以正式资料为准。'],
    en: ['Start with the real scenario before judging the solution.', 'Break the process down and observe each key action.', 'Only visually supported results are described.', 'Check official information for exact use conditions.'],
  },
  supplier_capability: {
    zh: ['了解供应能力，可以先看完整流程。', '生产协作、检查节点和交付环节都值得关注。', '稳定能力需要持续记录和真实证据支持。', '具体产能与交期，请以企业正式资料为准。'],
    en: ['A supply capability review starts with the full process.', 'Production, inspection, and delivery are all important.', 'Stable capability needs records and real evidence.', 'Check official company information for capacity and lead time.'],
  },
  customization_process: {
    zh: ['定制合作，先从需求确认开始。', '方案、打样和样品确认要逐步推进。', '生产与验收节点需要提前约定。', '具体周期和条件，请以双方正式确认的信息为准。'],
    en: ['Customization starts with confirming the requirement.', 'Move through proposals, sampling, and sample approval step by step.', 'Production and acceptance checkpoints should be agreed in advance.', 'Use formally confirmed information for timing and terms.'],
  },
  customer_case: {
    zh: ['真实案例应该先说明客户需求。', '再展示方案过程和可核验的合作步骤。', '未经授权的名称和结果不应被推断。', '具体成果，请以获得授权的案例资料为准。'],
    en: ['A real case should begin with the customer need.', 'Then show the solution process and verifiable collaboration steps.', 'Names and results must not be inferred without permission.', 'Use authorized case material for specific outcomes.'],
  },
};

/**
 * Product references remain intent-only: they are never copied into speech or
 * promoted to product claims. A small allowlist may only choose between
 * governed, claim-free copy profiles so an uploaded beauty reel does not fall
 * back to compliance language that sounds like an internal audit notice.
 */
const PRODUCT_VALUE_NARRATION_BY_HINT = {
  haircare: {
    zh: ['洗护别随便选，先看质地。', '从按压到使用，真实可见。', '不堆夸张词，让镜头说话。', '认真护发，可以了解一下。'],
    en: ['Choose hair care by looking closer.', 'See the texture and use in real footage.', 'No inflated claims—let the camera speak.', 'Looking after your hair? Take a closer look.'],
  },
  skincare: {
    zh: ['护肤品别只看包装，先看真实质地。', '从取用到上手，使用过程拍给你看。', '不夸大功效，只看镜头里的真实呈现。', '想找日常护肤，可以继续了解。'],
    en: ['Look past the packaging and see the real texture.', 'Watch the product being dispensed and used.', 'No inflated claims—only what the footage shows.', 'Looking for everyday skincare? Take a closer look.'],
  },
  makeup: {
    zh: ['妆效别靠想象，直接看真实上手。', '颜色、质地和使用过程都拍清楚。', '不加夸张滤镜，让细节自己说话。', '喜欢这种呈现，可以继续了解。'],
    en: ['Do not imagine the finish—see it applied.', 'See the color, texture, and application clearly.', 'No exaggerated filters—let the details speak.', 'Like this look? Take a closer look.'],
  },
  home: {
    zh: ['好不好用，先看一次真实操作。', '外观、细节和使用步骤都拍清楚。', '不堆空泛卖点，让过程自己说明。', '正在挑同类产品，可以继续了解。'],
    en: ['See one real use before deciding.', 'Look at the design, details, and operation.', 'No vague claims—let the process explain itself.', 'Comparing similar products? Take a closer look.'],
  },
  electronics: {
    zh: ['先不堆参数，直接看真实上手。', '外观、接口和操作过程逐个拍清楚。', '只展示镜头能确认的细节。', '想看更多使用信息，可以继续了解。'],
    en: ['Skip the spec dump and see it in use.', 'Look at the design, ports, and operation.', 'Only details visible in the footage are shown.', 'Want more usage information? Take a closer look.'],
  },
} as const;

function controlledThemeNarration(
  themeId: SocialContentThemeId,
  language: 'zh' | 'en',
  productReference: unknown,
): readonly string[] {
  const reference = socialText(productReference).toLocaleLowerCase();
  if (themeId === 'product_value'
    && /洗发|护发|洗护|发膜|发质|头发|shampoo|conditioner|hair\s*care|haircare/.test(reference)) {
    return PRODUCT_VALUE_NARRATION_BY_HINT.haircare[language];
  }
  if (themeId === 'product_value'
    && /护肤|面霜|精华|乳液|面膜|洁面|防晒|skincare|serum|cream|lotion|cleanser/.test(reference)) {
    return PRODUCT_VALUE_NARRATION_BY_HINT.skincare[language];
  }
  if (themeId === 'product_value'
    && /彩妆|口红|唇釉|粉底|眼影|腮红|睫毛|makeup|lipstick|foundation|mascara/.test(reference)) {
    return PRODUCT_VALUE_NARRATION_BY_HINT.makeup[language];
  }
  if (themeId === 'product_value'
    && /家居|收纳|清洁|厨具|杯|灯|家具|home|kitchen|storage|cleaning/.test(reference)) {
    return PRODUCT_VALUE_NARRATION_BY_HINT.home[language];
  }
  if (themeId === 'product_value'
    && /数码|耳机|音箱|键盘|充电|摄像|电子|headphone|speaker|keyboard|charger|electronic/.test(reference)) {
    return PRODUCT_VALUE_NARRATION_BY_HINT.electronics[language];
  }
  return SYSTEM_THEME_NARRATION[themeId][language];
}

function compactFactValue(value: unknown, maximum = 72): string {
  return socialText(value).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').slice(0, maximum);
}

function factVersionIdentity(value: SocialEnterpriseFactVersion | null | undefined): string {
  return value ? `${value.id}\0${value.revision}\0${value.contentHash}` : '';
}

/** Resolve only facts already persisted in Enterprise Knowledge. Free-form task
 * text is deliberately never promoted to a product fact. */
export function verifiedSocialScriptContext(
  profile: EnterpriseProfile | null,
  productRef: string | null,
): VerifiedSocialScriptContext {
  const profileFactVersion = profile?.factVersion;
  const factVersion = profileFactVersion
    && compactFactValue(profileFactVersion.id, 160)
    && Number.isSafeInteger(profileFactVersion.revision)
    && profileFactVersion.revision > 0
    && compactFactValue(profileFactVersion.contentHash, 240)
    ? {
        id: compactFactValue(profileFactVersion.id, 160),
        revision: profileFactVersion.revision,
        contentHash: compactFactValue(profileFactVersion.contentHash, 240),
      }
    : null;
  const identityContext = {
    enterpriseName: compactFactValue(profile?.company.name, 80) || null,
    brandName: compactFactValue(profile?.brand?.name, 80) || null,
    factVersion,
  };
  const reference = socialText(productRef).toLocaleLowerCase();
  const products = profile?.products.items ?? [];
  const exact = reference
    ? products.find((item, index) => [enterpriseProductIdentity(item, index), item.name, item.sku]
      .some(value => socialText(value).toLocaleLowerCase() === reference))
    : undefined;
  const product = exact ?? (!reference && products.length === 1 ? products[0] : undefined);
  if (product) {
    const candidates: Array<[string, string, unknown]> = [
      ['category', '类别', product.category],
      ['material', '材质', product.material],
      ['highlights', '已确认特点', product.highlights],
      ['certifications', '已确认资质', product.certifications],
      ['moq', '起订量', product.moq],
    ];
    return {
      ...identityContext,
      productName: compactFactValue(product.name, 48) || null,
      facts: candidates
        .map(([key, label, value]) => ({ key, label, value: compactFactValue(value) }))
        .filter(item => item.value)
        .slice(0, 3),
      source: 'enterprise_product',
      confidence: exact ? 1 : 0.85,
    };
  }
  // The user-supplied product name is safe as an identity/keyword even when it
  // is not yet an Enterprise Knowledge row. It never unlocks product claims;
  // facts remain empty until an exact enterprise-product match exists.
  if (reference) {
    return { ...identityContext, productName: compactFactValue(productRef, 48) || null, facts: [], source: 'none', confidence: 0.5 };
  }
  const profileFacts: Array<{ key: string; label: string; value: string }> = [
    { key: 'company_industry', label: '所属行业', value: compactFactValue(profile?.company.industry) },
    { key: 'product_categories', label: '产品类别', value: compactFactValue(profile?.products.categories) },
  ].filter(item => item.value);
  return {
    ...identityContext,
    productName: null,
    facts: profileFacts.slice(0, 2),
    source: profileFacts.length ? 'enterprise_profile' : 'none',
    confidence: profileFacts.length ? 0.65 : 0,
  };
}

function baselineLanguage(value: unknown): 'zh' | 'en' {
  const language = socialText(value).toLowerCase();
  return language === 'en' || /english|英语|英文/.test(language) ? 'en' : 'zh';
}

function nextBaselineVersion(previous: StoredSocialScriptBaseline | null | undefined): string {
  const current = Number(previous?.version);
  return Number.isSafeInteger(current) && current > 0 ? String(current + 1) : '1';
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

function localizedTemplate(value: unknown, language: 'zh' | 'en'): string {
  return socialText(socialObject(value)?.[language]);
}

function groundedNarration(input: {
  language: 'zh' | 'en';
  index: number;
  count: number;
  product: string;
  topic: string;
  shotFunction: string;
  subject: string;
  verifiedFacts: VerifiedSocialScriptContext['facts'];
  hasUserProductAssociation: boolean;
}): string {
  const fact = input.verifiedFacts[Math.max(0, Math.min(input.verifiedFacts.length - 1, input.index - 1))];
  if (input.language === 'en') {
    const englishFactLabels: Record<string, string> = {
      category: 'category', material: 'material', highlights: 'verified feature',
      certifications: 'verified certification', moq: 'minimum order quantity',
      company_industry: 'industry', product_categories: 'product category',
    };
    if (input.index === 0) {
      return input.hasUserProductAssociation
        ? `This video uses material the user explicitly linked to ${input.product}.`
        : input.verifiedFacts.length
          ? `This video uses only verified enterprise information about ${input.product}.`
          : 'This video uses a controlled general theme structure without product claims.';
    }
    if (input.index === input.count - 1) {
      if (input.hasUserProductAssociation) {
        return input.verifiedFacts.length
          ? `This concludes the verified information and user-linked material for ${input.product}.`
          : `This content is limited to material the user explicitly linked to ${input.product}; it adds no unverified product claims.`;
      }
      return input.verifiedFacts.length
        ? `Check the verified enterprise information for specific details about ${input.product}.`
        : 'Check official information before using specific product claims.';
    }
    if (fact) return `Verified product information lists ${englishFactLabels[fact.key] || 'this detail'} as ${fact.value}.`;
    return input.hasUserProductAssociation
      ? `This scene continues with material the user explicitly linked to ${input.product}; no visual fact is inferred.`
      : 'This scene does not add any unverified product fact.';
  }
  if (input.index === 0) {
    return input.hasUserProductAssociation
      ? `本片使用用户明确关联到${input.product}的素材。`
      : input.verifiedFacts.length
        ? `本片仅使用关于${input.product}的已确认企业资料。`
        : '本片使用受控的通用主题结构，不添加产品事实。';
  }
  if (input.index === input.count - 1) {
    if (input.hasUserProductAssociation) {
      return input.verifiedFacts.length
        ? `以上为${input.product}的已确认资料与用户关联素材。`
        : `以上内容仅基于用户明确关联到${input.product}的素材，不扩展未经确认的产品事实。`;
    }
    return input.verifiedFacts.length
      ? `关于${input.product}的具体信息，请以已确认企业资料为准。`
      : '具体产品信息，请以品牌正式资料为准。';
  }
  if (fact) return `企业已确认资料显示，${fact.label}为${fact.value}。`;
  return input.hasUserProductAssociation
    ? `本段继续使用用户明确关联到${input.product}的素材，不推断画面事实。`
    : '本段不添加未经确认的产品事实。';
}

/**
 * Freeze the executable script as soon as the user confirms a theme/formula.
 * Uploaded material is deliberately absent from this function: production may
 * fit shots to this script, but may not silently author a second script.
 */
export function freezeSocialScriptBaseline(input: {
  replicationContext?:SocialReplicationJobContext|null;
  contentTemplateStructure?: ContentTemplateStructureConstraint;
  brief: SocialContentTaskBrief;
  theme: SocialContentThemeSelection | null;
  formula?: InternalSocialContentFormula | null;
  inspiration?: SocialInspirationScriptMatch | null;
  replicationScript?: SocialReplicationScriptVersion | null;
  verifiedContext?: VerifiedSocialScriptContext | null;
  userProductAssociation?: {
    basis: 'tenant_task_upload';
    confidence: number;
  } | null;
  /** High-confidence visual-analysis text only. Free-form filenames and task
   * copy are never accepted here as material evidence. */
  materialCategoryHint?: string | null;
  lockedAt: string;
  previous?: StoredSocialScriptBaseline | null;
}): StoredSocialScriptBaseline {
  const accountPlaybookConstraints=freezeSocialAccountProductionConstraints(input.replicationContext,input.brief.callToAction);
  if(input.previous)assertAccountProductionConstraintReuse(input.previous.accountPlaybookConstraints,accountPlaybookConstraints);
  const language = baselineLanguage(input.brief.languages[0]);
  const themeLabels = input.theme?.themeId ? SAFE_THEME_LABELS[input.theme.themeId] : null;
  // `theme.topic`, title and objective are intent inputs. They may contain a
  // whole user prompt, so they never enter narration verbatim.
  const topic = themeLabels?.[language] ?? (language === 'en' ? 'the selected content theme' : '选定内容主题');
  const verified = input.verifiedContext ?? {
    productName: null,
    facts: [],
    source: 'none',
    confidence: 0,
    factVersion: null,
  };
  const userProductAssociation = input.userProductAssociation ?? null;
  const categoryHint = verified.source === 'enterprise_product'
    ? [input.brief.productRef, ...verified.facts.map(item => item.value)].map(socialText).filter(Boolean).join(' ')
    : socialText(input.materialCategoryHint);
  const product = verified.productName || (language === 'en' ? 'this product' : '本次产品');
  // CTA is an operator-owned instruction. An absent CTA stays absent: the
  // system must not silently convert a neutral video into a sales solicitation.
  const callToAction = compactFactValue(input.brief.callToAction, 96);
  // Built-in theme templates are a safety skeleton, not evidence that an
  // operator has supplied and released a real viral formula. Only a stored,
  // governed formula version may be labelled as a formula match.
  const matchedFormula = input.formula?.recordId ? input.formula : null;
  const systemThemeBaseline = !matchedFormula
    && !input.inspiration
    && verified.source === 'none'
    && !userProductAssociation
    && Boolean(input.theme?.themeId);
  const controlledSafetyStructure = !matchedFormula
    && !input.inspiration
    && verified.source === 'none'
    && Boolean(input.theme?.themeId);
  const sourceNodes = matchedFormula?.nodes?.length
    ? matchedFormula.nodes
    : input.inspiration?.nodes?.length
      ? input.inspiration.nodes
      : input.formula?.nodes?.length
        ? input.formula.nodes
        : controlledSafetyStructure && input.theme?.themeId
          ? SYSTEM_THEME_SCENES[input.theme.themeId]
          : DEFAULT_SCENES;
  const source = matchedFormula
    ? 'formula'
    : input.inspiration
      ? 'inspiration_script'
      : systemThemeBaseline
        ? 'system_theme_baseline'
        : 'knowledge_fallback';
  const formulaReference = matchedFormula
    ? { formulaId: matchedFormula.formulaId, version: matchedFormula.version }
    : null;
  const replicationShots = input.replicationScript?.shots ?? [];
  const scenes = replicationShots.length ? replicationShots.map((shot, index) => {
    const referenceStructure = input.inspiration?.nodes[index]?.referenceStructure;
    // A silent reference shot stays silent. Captions are not promoted to
    // speech, and missing ASR is never filled with newly authored copy.
    const narration = socialText(shot.spokenText);
    const caption = socialText(shot.captionText);
    const visualInstruction = socialText(shot.visualInstruction || shot.materialPlan?.requestedDescription);
    return {
      sceneId: socialText(shot.shotId) || `scene-${index + 1}`,
      formulaNodeId: null,
      inspirationNodeId: socialText(shot.referenceShotId) || null,
      ...(referenceStructure ? {
        referenceStructure: {
          ...referenceStructure,
          sourceTiming: { ...referenceStructure.sourceTiming },
        },
      } : {}),
      shotFunction: socialText(shot.purpose) || '主题表达',
      subject: socialText(shot.materialPlan?.requestedDescription) || visualInstruction || '本次内容',
      action: visualInstruction || '按参考节奏展示',
      ...(['independent_revision','budget_semantic_revision'].includes(shot.scriptOrigin||'') ? {scriptOrigin:shot.scriptOrigin} : {}),
      ...(shot.referenceShotIds ? {referenceShotIds:[...shot.referenceShotIds]} : {}),
      script: visualInstruction || narration,
      referenceSpokenText: shot.referenceSpokenText ?? null,
      voiceover: narration,
      ...(shot.speechLines ? { speechLines: shot.speechLines.map(line => ({
        ...line, replacedEntityTypes: [...line.replacedEntityTypes],
      })) } : {}),
      ...(shot.voiceoverReplacement ? {
        voiceoverReplacement: {
          mode: 'identity_only' as const,
          replacedEntityTypes: [...shot.voiceoverReplacement.replacedEntityTypes],
        },
      } : {}),
      caption,
      narration,
    };
  }) : sourceNodes.slice(0, 12).map((node, index) => {
    const referenceStructure = !matchedFormula
      ? input.inspiration?.nodes[index]?.referenceStructure
      : undefined;
    const shotFunction = socialText(node.shotFunction) || '主题表达';
    const subject = socialText(node.subject) || '本次内容';
    const action = socialText(node.action) || '展示';
    const template = 'voiceoverTemplate' in node && node.voiceoverTemplate
      ? localizedTemplate(node.voiceoverTemplate, language)
      : 'narrationTemplate' in node
        ? localizedTemplate(node.narrationTemplate, language)
      : '';
    const interpolationValues = {
          product,
          topic,
          callToAction,
          shotFunction,
          subject,
          action,
        };
    const narration = template && matchedFormula
      ? interpolate(template, interpolationValues).trim()
      : controlledSafetyStructure && input.theme?.themeId
        ? controlledThemeNarration(input.theme.themeId, language, categoryHint)[index]
          || controlledThemeNarration(input.theme.themeId, language, categoryHint).at(-1)!
        : groundedNarration({
          language,
          index,
          count: sourceNodes.length,
          product,
          topic,
          shotFunction,
          subject,
          verifiedFacts: verified.facts,
          hasUserProductAssociation: Boolean(userProductAssociation),
        });
    const scriptTemplate = matchedFormula && 'scriptTemplate' in node
      ? localizedTemplate(node.scriptTemplate, language)
      : '';
    const captionTemplate = matchedFormula && 'captionTemplate' in node
      ? localizedTemplate(node.captionTemplate, language)
      : '';
    const script = scriptTemplate
      ? interpolate(scriptTemplate, interpolationValues).trim()
      : `${shotFunction}：${subject}，${action}`;
    const caption = captionTemplate
      ? interpolate(captionTemplate, interpolationValues).trim()
      : narration;
    return {
      sceneId: `scene-${index + 1}`,
      formulaNodeId: matchedFormula ? socialText(node.nodeId) || null : null,
      inspirationNodeId: !matchedFormula && input.inspiration ? socialText(node.nodeId) || null : null,
      ...(referenceStructure ? {
        referenceStructure: {
          ...referenceStructure,
          sourceTiming: { ...referenceStructure.sourceTiming },
        },
      } : {}),
      shotFunction,
      subject,
      action,
      script,
      voiceover: narration,
      caption,
      narration,
    };
  });
  if (!scenes.length || (!replicationShots.length && scenes.some(scene => !scene.narration))) {
    throw new SocialContentWorkflowError('social_content_script_baseline_invalid', 503);
  }
  if(input.contentTemplateStructure){if(!validContentTemplateStructure(input.contentTemplateStructure))throw new SocialContentWorkflowError('content_template_structure_invalid',409);for(let i=0;i<scenes.length;i++)scenes[i]!.shotFunction=contentTemplateRoleLabel(contentTemplateRoleAt(input.contentTemplateStructure,i,scenes.length));}
  return {
    ...(accountPlaybookConstraints?{accountPlaybookConstraints}:{}),
    ...(input.contentTemplateStructure?{contentTemplateStructure:structuredClone(input.contentTemplateStructure)}:{}),
    schemaVersion: SOCIAL_SCRIPT_BASELINE_SCHEMA,
    version: nextBaselineVersion(input.previous),
    source,
    formulaReference,
    themeId: input.theme?.themeId ?? input.formula?.themeId ?? null,
    language,
    lockedAt: input.lockedAt,
    createdBeforeMaterialAdaptation: true,
    enterpriseFactVersion: verified.factVersion ? { ...verified.factVersion } : null,
    verifiedContextSnapshot: {
      enterpriseName: verified.enterpriseName ?? null,
      brandName: verified.brandName ?? null,
      productName: verified.productName,
      facts: verified.facts.map(fact => ({ ...fact })),
      source: verified.source,
      confidence: verified.confidence,
      factVersion: verified.factVersion ? { ...verified.factVersion } : null,
    },
    groundingVersion: SOCIAL_SCRIPT_GROUNDING_VERSION,
    match: {
      strategy: matchedFormula && input.inspiration
        ? 'formula_inspiration'
        : matchedFormula
          ? 'formula'
          : input.inspiration
            ? 'inspiration'
            : systemThemeBaseline
              ? 'system_theme_baseline'
              : 'knowledge_fallback',
      confidence: Math.max(0, Math.min(1, matchedFormula
        ? input.inspiration ? (0.7 + input.inspiration.confidence * 0.3) : 0.78
        : input.inspiration ? input.inspiration.confidence
          : systemThemeBaseline ? 0.45
          : Math.min(0.62, 0.35 + (userProductAssociation?.confidence ?? verified.confidence) * 0.35))),
      inspirationReference: input.inspiration
        ? { recordId: input.inspiration.recordId, confidence: input.inspiration.confidence }
        : null,
      referenceSource: input.inspiration?.referenceSource
        ? { ...input.inspiration.referenceSource }
        : null,
      // Product linkage and enterprise knowledge are independent evidence
      // axes. Preserve the real knowledge source when facts came from the
      // enterprise profile; use the association token only when no knowledge
      // source exists at all.
      verifiedKnowledgeSource: (userProductAssociation && verified.source === 'none'
        ? 'user_product_association'
        : verified.source) as SocialScriptGroundingSource,
      verifiedFactKeys: verified.facts.map(item => item.key),
      userTextUsage: 'intent_only',
      userProductAssociation,
    },
    scenes,
  };
}

export function parseStoredSocialScriptBaseline(value: unknown): StoredSocialScriptBaseline | null {
  const raw = socialJson(value);
  if (raw === undefined || raw === null || raw === '') return null;
  const row = socialObject(raw);
  const formula = socialObject(row?.formulaReference);
  const scenesValue = socialJson(row?.scenes);
  const language = socialText(row?.language);
  const source = socialText(row?.source);
  const themeId = socialText(row?.themeId) || null;
  const groundingVersion = socialText(row?.groundingVersion);
  const hasEnterpriseFactVersion = Object.prototype.hasOwnProperty.call(row ?? {}, 'enterpriseFactVersion');
  const enterpriseFactVersionRow = socialObject(row?.enterpriseFactVersion);
  const hasVerifiedContextSnapshot = Object.prototype.hasOwnProperty.call(row ?? {}, 'verifiedContextSnapshot');
  const verifiedContextSnapshotRow = socialObject(row?.verifiedContextSnapshot);
  const match = socialObject(row?.match);
  const matchKnowledgeSource = socialText(match?.verifiedKnowledgeSource);
  const matchAssociation = socialObject(match?.userProductAssociation);
  const matchReferenceSource = socialObject(match?.referenceSource);
  if (!row
    || socialText(row.schemaVersion) !== SOCIAL_SCRIPT_BASELINE_SCHEMA
    || !/^\d+$/.test(socialText(row.version))
    || !['formula', 'inspiration_script', 'knowledge_fallback', 'system_theme_baseline'].includes(source)
    || !['zh', 'en'].includes(language)
    || !socialText(row.lockedAt)
    || row.createdBeforeMaterialAdaptation !== true
    || !Array.isArray(scenesValue)
    || scenesValue.length < 1
    || scenesValue.length > 256) {
    throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
  }
  const formulaReference = formula
    ? { formulaId: socialText(formula.formulaId), version: socialText(formula.version) }
    : null;
  if ((source === 'formula' && (!formulaReference?.formulaId || !formulaReference.version))
    || (source !== 'formula' && formulaReference)) {
    throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
  }
  const enterpriseFactVersion = enterpriseFactVersionRow ? {
    id: socialText(enterpriseFactVersionRow.id),
    revision: Number(enterpriseFactVersionRow.revision),
    contentHash: socialText(enterpriseFactVersionRow.contentHash),
  } : null;
  if (hasEnterpriseFactVersion
    && row?.enterpriseFactVersion !== null
    && (!enterpriseFactVersion
      || !enterpriseFactVersion.id
      || !Number.isSafeInteger(enterpriseFactVersion.revision)
      || enterpriseFactVersion.revision < 1
      || !enterpriseFactVersion.contentHash)) {
    throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
  }
  const snapshotFactsValue = socialJson(verifiedContextSnapshotRow?.facts);
  const snapshotFactVersionRow = socialObject(verifiedContextSnapshotRow?.factVersion);
  const verifiedContextSnapshot = verifiedContextSnapshotRow ? {
    enterpriseName: socialText(verifiedContextSnapshotRow.enterpriseName) || null,
    brandName: socialText(verifiedContextSnapshotRow.brandName) || null,
    productName: socialText(verifiedContextSnapshotRow.productName) || null,
    facts: Array.isArray(snapshotFactsValue) ? snapshotFactsValue.map(value => {
      const fact = socialObject(value);
      return {
        key: socialText(fact?.key),
        label: socialText(fact?.label),
        value: socialText(fact?.value),
      };
    }) : [],
    source: socialText(verifiedContextSnapshotRow.source),
    confidence: Number(verifiedContextSnapshotRow.confidence),
    factVersion: snapshotFactVersionRow ? {
      id: socialText(snapshotFactVersionRow.id),
      revision: Number(snapshotFactVersionRow.revision),
      contentHash: socialText(snapshotFactVersionRow.contentHash),
    } : null,
  } : null;
  if (hasVerifiedContextSnapshot && row?.verifiedContextSnapshot !== null && (
    !verifiedContextSnapshot
    || !['enterprise_product', 'enterprise_profile', 'none'].includes(verifiedContextSnapshot.source)
    || !Number.isFinite(verifiedContextSnapshot.confidence)
    || verifiedContextSnapshot.confidence < 0
    || verifiedContextSnapshot.confidence > 1
    || !Array.isArray(snapshotFactsValue)
    || verifiedContextSnapshot.facts.some(fact => !fact.key || !fact.label || !fact.value)
    || (verifiedContextSnapshot.factVersion !== null && (
      !verifiedContextSnapshot.factVersion.id
      || !Number.isSafeInteger(verifiedContextSnapshot.factVersion.revision)
      || verifiedContextSnapshot.factVersion.revision < 1
      || !verifiedContextSnapshot.factVersion.contentHash
    ))
    || factVersionIdentity(verifiedContextSnapshot.factVersion) !== factVersionIdentity(enterpriseFactVersion)
  )) {
    throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
  }
  if (groundingVersion === SOCIAL_SCRIPT_GROUNDING_VERSION
    && ((matchKnowledgeSource === 'user_product_association'
      && socialText(matchAssociation?.basis) !== 'tenant_task_upload')
      || (matchKnowledgeSource === 'none'
        && socialText(matchAssociation?.basis) === 'tenant_task_upload'))) {
    throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
  }
  const scenes = scenesValue.map(value => {
    const scene = socialObject(value);
    const referenceStructure = socialObject(scene?.referenceStructure);
    const voiceoverReplacement = socialObject(scene?.voiceoverReplacement);
    const speechLines = Array.isArray(scene?.speechLines) ? scene.speechLines.map(socialObject) : null;
    const sourceTiming = socialObject(referenceStructure?.sourceTiming);
    const parsedReferenceStructure: NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']> | null = referenceStructure && sourceTiming ? {
      sourceTiming: {
        startSeconds: Number(sourceTiming.startSeconds),
        endSeconds: Number(sourceTiming.endSeconds),
        durationSeconds: Number(sourceTiming.durationSeconds),
      },
      shotScale: socialText(referenceStructure.shotScale) as NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']>['shotScale'],
      cameraMovement: socialText(referenceStructure.cameraMovement) as NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']>['cameraMovement'],
      pace: socialText(referenceStructure.pace) as NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']>['pace'],
      transition: socialText(referenceStructure.transition) as NonNullable<StoredSocialScriptBaseline['scenes'][number]['referenceStructure']>['transition'],
    } : null;
    const parsed = {
      sceneId: socialText(scene?.sceneId),
      formulaNodeId: socialText(scene?.formulaNodeId) || null,
      inspirationNodeId: socialText(scene?.inspirationNodeId) || null,
      ...(parsedReferenceStructure ? { referenceStructure: parsedReferenceStructure } : {}),
      shotFunction: socialText(scene?.shotFunction),
      subject: socialText(scene?.subject),
      action: socialText(scene?.action),
      script: socialText(scene?.script) || `${socialText(scene?.shotFunction)}：${socialText(scene?.subject)}，${socialText(scene?.action)}`,
      ...(Object.prototype.hasOwnProperty.call(scene ?? {}, 'referenceSpokenText')
        ? { referenceSpokenText: socialText(scene?.referenceSpokenText) || null }
        : {}),
      ...(['independent_revision','budget_semantic_revision'].includes(socialText(scene?.scriptOrigin)) ? {scriptOrigin:socialText(scene?.scriptOrigin) as 'independent_revision'|'budget_semantic_revision'} : {}),
      ...(Array.isArray(scene?.referenceShotIds) ? {referenceShotIds:scene.referenceShotIds.map(socialText)} : {}),
      voiceover: socialText(scene?.voiceover) || socialText(scene?.narration),
      ...(speechLines ? { speechLines: speechLines.map(rawLine => {
        const line = rawLine ?? {};
        const sourceStartSeconds = Number(line.sourceStartSeconds);
        const sourceEndSeconds = Number(line.sourceEndSeconds);
        const sourcePrecision = socialText(line.sourcePrecision);
        const referenceText = socialText(line.referenceText);
        const draftText = socialText(line.draftText);
        const sourceProvenance = socialText(line.sourceProvenance);
        const replacedEntityTypes = Array.isArray(line.replacedEntityTypes)
          ? line.replacedEntityTypes.map(socialText)
            .filter((type): type is 'company' | 'brand' | 'product' => ['company', 'brand', 'product'].includes(type))
          : [];
        const independent = socialText(scene?.scriptOrigin) === 'independent_revision' && sourceProvenance === 'independent_revision_script:not_reference_asr'
          && sourcePrecision === 'coarse' && !socialText(scene?.referenceSpokenText) && !voiceoverReplacement
          && replacedEntityTypes.length === 0 && Array.isArray(line.sourceWords) && line.sourceWords.length === 0;
        if ((!referenceText && !independent) || !draftText || !sourceProvenance || !Number.isFinite(sourceStartSeconds)
          || !Number.isFinite(sourceEndSeconds) || sourceStartSeconds < 0 || sourceEndSeconds <= sourceStartSeconds
          || !['phrase', 'coarse'].includes(sourcePrecision)) {
          throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
        }
        return { referenceText, draftText, sourceStartSeconds, sourceEndSeconds,
          sourcePrecision: sourcePrecision as 'phrase' | 'coarse', sourceProvenance, replacedEntityTypes,
          ...(Array.isArray(line.sourceWords) ? { sourceWords: line.sourceWords.map(word => socialObject(word) || {}).filter(word => Number.isFinite(Number(word.start)) && Number(word.end) > Number(word.start) && socialText(word.text)).map(word => ({start: Number(word.start), end: Number(word.end), text: socialText(word.text)})) } : {}),
          ...(socialText(line.lineId) ? { lineId: socialText(line.lineId) } : {}),
          ...(socialText(line.narrationOwnerShotId)
            ? { narrationOwnerShotId: socialText(line.narrationOwnerShotId) } : {}),
          ...(Array.isArray(line.visualShotIds)
            ? { visualShotIds: line.visualShotIds.map(socialText).filter(Boolean) } : {}),
        };
      }) } : {}),
      ...(socialText(voiceoverReplacement?.mode) === 'identity_only' ? {
        voiceoverReplacement: {
          mode: 'identity_only' as const,
          replacedEntityTypes: Array.isArray(socialJson(voiceoverReplacement?.replacedEntityTypes))
            ? (socialJson(voiceoverReplacement?.replacedEntityTypes) as unknown[])
              .map(socialText)
              .filter((type): type is 'company' | 'brand' | 'product' => ['company', 'brand', 'product'].includes(type))
            : [],
        },
      } : {}),
      caption: socialText(scene?.caption),
      narration: socialText(scene?.narration),
    };
    const independentScene = ['independent_revision','budget_semantic_revision'].includes(parsed.scriptOrigin||'') && !parsed.referenceSpokenText
      && !parsed.voiceoverReplacement && (parsed.speechLines ?? []).every(line => !line.referenceText
        && line.sourceProvenance === 'independent_revision_script:not_reference_asr' && line.sourcePrecision === 'coarse'
        && line.sourceWords?.length === 0 && line.replacedEntityTypes.length === 0);
    const frozenReferenceScene = source === 'inspiration_script'
      && socialText(voiceoverReplacement?.mode) === 'identity_only';
    if (!scene || !parsed.sceneId || !parsed.shotFunction || !parsed.subject || !parsed.action
      || !parsed.script || (!frozenReferenceScene && !independentScene && (!parsed.voiceover || !parsed.caption || !parsed.narration))) {
      throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
    }
    if (parsedReferenceStructure && (
      !Object.values(parsedReferenceStructure.sourceTiming).every(Number.isFinite)
      || parsedReferenceStructure.sourceTiming.startSeconds < 0
      || parsedReferenceStructure.sourceTiming.endSeconds <= parsedReferenceStructure.sourceTiming.startSeconds
      || !['极近特写', '近景特写', '中景', '全景', '通用景别'].includes(parsedReferenceStructure.shotScale)
      || !['固定镜头', '推进镜头', '拉远镜头', '横向摇移', '跟随镜头', '手持镜头', '通用运镜'].includes(parsedReferenceStructure.cameraMovement)
      || !['快速', '紧凑', '舒缓'].includes(parsedReferenceStructure.pace)
      || !['快速切换', '柔和过渡', '动作衔接', '自然衔接'].includes(parsedReferenceStructure.transition)
    )) {
      throw new SocialContentWorkflowError('social_content_script_baseline_record_invalid', 503);
    }
    return parsed;
  });
  const accountPlaybookConstraints=row.accountPlaybookConstraints as SocialAccountProductionConstraints|undefined;
  if(accountPlaybookConstraints)assertSocialAccountProductionConstraints(accountPlaybookConstraints);
  const contentTemplateStructure=row.contentTemplateStructure as ContentTemplateStructureConstraint|undefined;
  if(contentTemplateStructure&&(!validContentTemplateStructure(contentTemplateStructure)||scenes.some((scene,i)=>scene.shotFunction!==contentTemplateRoleLabel(contentTemplateRoleAt(contentTemplateStructure,i,scenes.length)))))throw new SocialContentWorkflowError('content_template_structure_invalid',503);
  return {
    ...(accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(accountPlaybookConstraints)}:{}),
    ...(contentTemplateStructure?{contentTemplateStructure:structuredClone(contentTemplateStructure)}:{}),
    schemaVersion: SOCIAL_SCRIPT_BASELINE_SCHEMA,
    version: socialText(row.version),
    source: source as StoredSocialScriptBaseline['source'],
    formulaReference,
    themeId: themeId as SocialContentThemeId | null,
    language: language as StoredSocialScriptBaseline['language'],
    lockedAt: socialText(row.lockedAt),
    createdBeforeMaterialAdaptation: true,
    ...(hasEnterpriseFactVersion ? { enterpriseFactVersion } : {}),
    ...(hasVerifiedContextSnapshot ? {
      verifiedContextSnapshot: verifiedContextSnapshot ? {
        ...verifiedContextSnapshot,
        source: verifiedContextSnapshot.source as VerifiedSocialScriptContext['source'],
      } : null,
    } : {}),
    ...(groundingVersion === SOCIAL_SCRIPT_GROUNDING_VERSION ? {
      groundingVersion: SOCIAL_SCRIPT_GROUNDING_VERSION,
      match: {
        strategy: (['formula_inspiration', 'formula', 'inspiration', 'knowledge_fallback', 'system_theme_baseline'].includes(socialText(match?.strategy))
          ? socialText(match?.strategy)
          : 'legacy') as NonNullable<StoredSocialScriptBaseline['match']>['strategy'],
        confidence: Math.max(0, Math.min(1, Number(match?.confidence) || 0)),
        inspirationReference: (() => {
          const reference = socialObject(match?.inspirationReference);
          const recordId = socialText(reference?.recordId);
          return recordId ? { recordId, confidence: Math.max(0, Math.min(1, Number(reference?.confidence) || 0)) } : null;
        })(),
        referenceSource: (() => {
          const sourceId = socialText(matchReferenceSource?.sourceId);
          const sourceRef = socialText(matchReferenceSource?.sourceRef);
          if (!sourceId || !sourceRef) return null;
          return {
            sourceId,
            sourceRef,
            sourceVersion: socialText(matchReferenceSource?.sourceVersion) || null,
          };
        })(),
        verifiedKnowledgeSource: (['enterprise_product', 'enterprise_profile', 'user_product_association', 'none'].includes(matchKnowledgeSource)
          ? matchKnowledgeSource
          : 'none') as SocialScriptGroundingSource,
        verifiedFactKeys: Array.isArray(socialJson(match?.verifiedFactKeys))
          ? (socialJson(match?.verifiedFactKeys) as unknown[]).map(socialText).filter(Boolean).slice(0, 20)
          : [],
        userTextUsage: 'intent_only',
        userProductAssociation: (() => {
          if (socialText(matchAssociation?.basis) !== 'tenant_task_upload') return null;
          return {
            basis: 'tenant_task_upload' as const,
            confidence: Math.max(0, Math.min(1, Number(matchAssociation?.confidence) || 0)),
          };
        })(),
      },
    } : {}),
    scenes,
  };
}
export function publicSocialScriptBaselineSummary(
  baseline: StoredSocialScriptBaseline | null,
): SocialScriptBaselineSummary | undefined {
  if (!baseline) return undefined;
  // Historic records may still carry `formula` internally for lineage and
  // replay compatibility. Formula is no longer a customer-facing production
  // concept, so expose the nearest current grounding source instead.
  const publicSource: SocialScriptBaselineSummary['source'] = baseline.source !== 'formula'
    ? baseline.source
    : baseline.match?.inspirationReference
      ? 'inspiration_script'
      : baseline.match?.verifiedKnowledgeSource && baseline.match.verifiedKnowledgeSource !== 'none'
        ? 'knowledge_fallback'
        : 'system_theme_baseline';
  return {
    version: baseline.version,
    source: publicSource,
    sceneCount: baseline.scenes.length,
    language: baseline.language,
    lockedAt: baseline.lockedAt,
    ...(baseline.match ? { matchConfidence: baseline.match.confidence } : {}),
    ...(baseline.groundingVersion ? { groundingVersion: baseline.groundingVersion } : {}),
    ...(baseline.match?.referenceSource
      ? { referenceSourceId: baseline.match.referenceSource.sourceId }
      : {}),
    ...(baseline.match?.inspirationReference?.recordId ? { referenceVideoId: baseline.match.inspirationReference.recordId } : {}),
  };
}
