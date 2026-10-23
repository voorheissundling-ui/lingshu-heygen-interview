import { readTenantEnterpriseProfile, type EnterpriseProfile } from '../routes/enterprise.js';
import { store } from '../storage/index.js';
import { callVideoModel } from './videoModel.js';
import { SCRIPT_CREATIVE_QUALITY_RULES, scriptCreativeModeRule } from '../prompts/scriptCreativeQuality.js';
import { normalizeVideoPlan, usesDigitalPresenter, presentationScenes } from '../../shared/contracts/videoCreationPlan.js';
import { VIDEO_LANGUAGES, normalizeVideoLanguage } from '../../shared/contracts/videoLanguages.js';
import { generateNarration } from './narration.js';
import { storyboardSceneRanges } from '../lib/studioScriptQualityV2.js';
import { closedWorldNarrationLines } from './contentProductionCreative.js';
import { aggregateNarrationStyleProfiles, narrationStyleInstruction, type NarrationStyleProfile } from './narrationStyle.js';
import { freezeStoryboardNarration, storyboardVoiceLanguageMatches, translateStoryboardFromMaster, voiceoverText } from './contentProductionNarrationTiming.js';
import type { FrozenDirectorScript } from '../../src/lib/directorScript.js';
import type { DigitalEmployeeConfig, WeeklyGoalInput } from './domain.js';
import type { AssetCandidate, ContentProductionOrderInput, ContentProductionRoute, StoredRecord } from './contentProductionContracts.js';
import { narrationEvidenceForProduct, platformCreativeBrief, stableHash, text } from './contentProductionPlanning.js';
import { collectProductionAssets, exactAnalysis } from './contentProductionAssets.js';
import { productFacts, referenceStructure } from './contentProductionFacts.js';

export function routeTitle(route: ContentProductionRoute): string {
  return route === 'clone' ? '爆款裂变' : route === 'product' ? '产品生成' : '素材生成';
}

export function isLlmUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /timed?\s*out|timeout|not set|unavailable|temporar|network|fetch|connection|econn|socket|access denied|overdue[ -]?payment|insufficient (?:balance|quota)|quota|rate limit|401|403|429|502|503|504|service/i.test(message);
}

function safeFactClauses(value: string): string[] {
  return value
    .split(/[\n；;]+/)
    .map(item => item.trim().replace(/[\r\n]+/g, ' '))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Provider-independent continuity path. Every factual noun phrase is copied
 * from product facts or a tenant-owned/licensed asset observation. It does not
 * infer certifications, efficacy, labels, people, actions or environments.
 */
export function deterministicClosedWorldStoryboard(input: {
  productFacts: string;
  assets: AssetCandidate[];
  language?: string;
}): string {
  const facts = safeFactClauses(input.productFacts);
  const language = normalizeVideoLanguage(input.language || 'zh');
  const spoken = closedWorldNarrationLines(facts, language);
  return spoken.map((line, index) => {
    const asset = input.assets[index % input.assets.length];
    const observation = asset?.observations.map(item => text(item, 180)).find(Boolean) || '';
    const visual = observation
      ? `展示素材“${text(asset?.name, 120) || '已上传素材'}”中已确认可见的内容：${observation}`
      : '展示已上传素材中已确认可见的主体';
    return `[${index * 4}-${(index + 1) * 4}s]\n环境：已上传素材所示实际环境\n景别：保持原素材景别\n运镜：固定\n构图：保持原素材构图\n镜头功能：${index === 4 ? '保守行动引导' : '展示可验证素材'}\n画面：${visual}\n配乐：轻节奏\n台词：${line}\n字幕：${line}`;
  }).join('\n\n');
}

export type GeneratedScript = { script: string; source: 'llm' | 'deterministic_closed_world_fallback'; degradedReason: string };

export async function generateScript(input: {
  route: ContentProductionRoute; config: DigitalEmployeeConfig; goal: WeeklyGoalInput; profile: EnterpriseProfile; assets: AssetCandidate[]; reference?: StoredRecord;
  productId?: string; platformBrief: string; contentOrder?: ContentProductionOrderInput; learnedNarrationStyle?: NarrationStyleProfile | null;
}): Promise<GeneratedScript> {
  const facts = productFacts(input.profile, input.config, input.productId);
  const reference = input.route === 'clone' ? referenceStructure(input.reference) : null;
  const referenceSummary = reference ? JSON.stringify(reference.structure).slice(0, 8_000) : '';
  const narrationStyle = reference?.narrationStyle || input.learnedNarrationStyle || null;
  const materialEvidence = input.assets.slice(0, 8).map(asset => `${asset.name}：${asset.observations.join('；')}`).join('\n');
  const brief = normalizeVideoPlan(input.contentOrder?.videoPlan || input.config.videoDefaults || {});
  const lines = await generateNarration({ facts, theme: input.contentOrder?.theme?.label || input.goal.objective, audience: brief.matrix?.audience || input.config.customerProfile,
    language: brief.language, duration: brief.duration, cta: input.contentOrder?.cta || '引导买家讨论当前问题，不承诺额外服务',
    constraints: [...(input.contentOrder?.constraints || input.goal.constraints), ...(brief.reviewRequirements?.length ? ['第一段口播必须能在3秒内自然读完，与首镜钩子对应；其余段落展开解释。'] : []), ...(brief.presenter === 'heygen' ? [`必须恰好分为 ${brief.scenePlan?.length || 4} 段口播，对应用户分镜画面安排；数字人段简短，素材段展开解释。`] : [])], reference: referenceSummary,
    styleProfile: narrationStyleInstruction(narrationStyle),
    visibleEvidence: narrationEvidenceForProduct(input.assets, input.productId),
  });
  if (brief.presenter === 'heygen' && brief.scenePlan?.length && lines.length !== brief.scenePlan.length) throw Error('口播段数与用户指定分镜数量不一致，请重新生成');
  const hookEnd = brief.reviewRequirements?.length ? 3 : 0;
  const step = hookEnd ? (brief.duration - hookEnd) / (lines.length - 1) : brief.duration / lines.length;
  const prompt = `你是严谨的 B2B 短视频分镜导演。根据已确认事实生成一条 ${brief.duration} 秒视频脚本。
生产路径：${routeTitle(input.route)}
目标：${brief.matrix?.objective || input.goal.objective}
本条主题：${input.contentOrder?.theme?.label || '按周目标生成'}
客户：${brief.matrix?.audience || input.config.customerProfile}
市场：${input.goal.scope || input.config.targetMarkets}
平台创作要求：${input.platformBrief}
行动引导：${input.contentOrder?.cta || '私信获取方案'}
本条冻结约束：${(input.contentOrder?.constraints || []).join('；') || '遵守企业与周目标约束'}
产品事实（封闭世界，不得补造）：
${facts || '（无）'}
可用素材事实：
${materialEvidence || '（无）'}
${referenceSummary ? `爆款参考结构（必须逐段对应其时间、镜头功能、节奏和转场；只迁移结构，不复制品牌、文案或参考主体）：\n${referenceSummary}` : ''}

路径规则：${input.route === 'material'
    ? '素材路径已经先锁定素材。必须从该素材已观察到的主体和动作开始组织脚本，不能写完脚本再寻找别的画面。'
    : input.route === 'product'
      ? '产品路径以单个产品事实为中心，画面只能使用明确归属于该产品的素材。'
      : '裂变路径逐段复用精确参考结构，同时只能使用当前产品自己的素材替换参考主体。'}

${SCRIPT_CREATIVE_QUALITY_RULES}
${scriptCreativeModeRule(input.route)}

事实边界（违反任一条即为不可用脚本）：
1. 只能逐字采用“产品事实”中已有的规格、MOQ、纯度、认证或合规结论；不得从品类、市场或常识推断“高纯度”“符合美国市场合规”等结论。
2. “可用素材事实”只证明其中明确写出的可见内容。不得声称标签、包装或画面中出现 FOR SENSITIVE SKIN、MOQ、二维码、邮箱、VI、认证标识或任何未在素材观察中明确记录的文字/物体。
3. 不知道素材具体画面时，保守写“展示已上传产品素材中的实际可见主体”，不得自行补出旋转瓶身、扫码、标签特写、邮件界面等动作。
4. 产品资料中的文本事实不等于素材中肉眼可见；台词可引用已确认事实，但画面仍只能写素材观察已确认的内容。
5. 展示设备视频不证明性能或兼容性通过测试；产品事实未明确验证时，不得使用“已验证兼容”“兼容性已验证”等结论，应邀请工程师按具体需求核实。

${usesDigitalPresenter(brief) ? `成片画面安排：${presentationScenes(brief, lines.length).map((scene, i) => `第${i + 1}镜：${scene.source === 'avatar' ? '数字人面对镜头口播，不插入产品实拍' : `产品素材 ${scene.materialId ? input.assets.find(asset => asset.id === scene.materialId)?.name || '指定素材缺失' : '按已选素材事实匹配'}`}`).join('；')}。逐镜遵守，不增加或替换画面来源。素材段沿用同一数字人声音作为画外音。` : '成片画面全部使用已授权产品素材，不出现生成的数字人。'}
口播已经确认，不得改写、翻译或删减。恰好 ${lines.length} 段，时间线从 0 到 ${brief.duration} 秒连续。逐段口播与时间：
${lines.map((line, index) => `[${(hookEnd ? index === 0 ? 0 : hookEnd + (index - 1) * step : index * step).toFixed(2)}-${(hookEnd ? index === 0 ? hookEnd : hookEnd + index * step : (index + 1) * step).toFixed(2)}s] 台词：${line}`).join('\n')}
字段名保持中文，台词/字幕使用 ${brief.language}，严格逐字复用以上口播。每段格式：
[start-end s]
环境：<只写素材已证明或可执行的环境>
景别：<景别>
运镜：<运镜>
构图：<构图>
镜头功能：<本段作用>
画面：<可执行画面；缺少证据就写待匹配素材>
画面来源：<数字人，或明确的已提供素材名称；禁止只写素材混剪>
配乐：<情绪>
台词：<自然口播，不说未确认价格、功效、交期>
字幕：<与台词逐字一致>

最后只保留一个低门槛 CTA。不输出 Markdown 或解释。`;
  try {
    const generatedScript = await callVideoModel(prompt, { timeoutMs: 90_000, systemPrompt: '你必须遵守封闭世界事实约束。产品事实与视觉素材证据严格分离；未明确提供的纯度、合规、认证、标签文字、二维码、邮箱、VI 和画面动作一律不得生成。缺少证据时使用保守场景或明确待匹配，不得虚构。' });
    const script = freezeStoryboardNarration(generatedScript.text.trim(), lines);
    if (!script) throw new Error('脚本服务未返回内容，请重试');
    if (brief.reviewRequirements?.length) { const first = storyboardSceneRanges(script)[0]; if (!first || first.start !== 0 || first.end !== 3) throw Error('复盘要求的首镜必须覆盖0–3秒，请重新生成分镜'); }
    if (voiceoverText(script).replace(/\s/g, '') !== lines.join('').replace(/\s/g, '')) throw new Error('分镜改变了已确认口播，需重新生成分镜');
    return { script, source: 'llm', degradedReason: generatedScript.fallbackReason };
  } catch (error) {
    if (!isLlmUnavailableError(error)) throw error;
    return {
      script: deterministicClosedWorldStoryboard({ productFacts: facts, assets: input.assets, language: brief.language }),
      source: 'deterministic_closed_world_fallback',
      degradedReason: error instanceof Error ? error.message : String(error || '脚本服务不可用'),
    };
  }
}

export async function generateDirectorScriptContracts(input: { tenantId: string; config: DigitalEmployeeConfig; goal: WeeklyGoalInput; orders: ContentProductionOrderInput[]; now?: string; enterpriseProfile?: EnterpriseProfile }): Promise<ContentProductionOrderInput[]> {
  const [profile, analysesResult] = await Promise.all([
    input.enterpriseProfile ? Promise.resolve(structuredClone(input.enterpriseProfile)) : readTenantEnterpriseProfile(input.tenantId),
    store.list<StoredRecord>('trend_videos', { where: { tenantId: input.tenantId }, sort: '-updatedAt', perPage: 500 }),
  ]);
  const allAssets = await collectProductionAssets(input.tenantId, profile);
  const analyses = analysesResult.items.filter(record => exactAnalysis(record) && Boolean(referenceStructure(record)));
  const learnedNarrationStyle = aggregateNarrationStyleProfiles(analyses.map(record => referenceStructure(record)?.narrationStyle || null));
  const generatedAt = input.now || new Date().toISOString();
  const results: ContentProductionOrderInput[] = [];
  for (const order of input.orders) {
    const languages = (order.languages?.length ? order.languages : [order.videoPlan?.language || input.config.videoDefaults?.language || 'en']).map(normalizeVideoLanguage).filter((language, index, values) => language in VIDEO_LANGUAGES && values.indexOf(language) === index);
    const persistedScripts = order.contractVersion === 1 && order.scripts ? order.scripts : {};
    const scripts: Record<string, FrozenDirectorScript> = Object.fromEntries(Object.entries(persistedScripts).filter(([language, script]) => (
      languages.includes(language)
      && script?.status === 'confirmed'
      && script.generatedBy === 'director_agent'
      && script.hash === stableHash(script.body)
      && storyboardVoiceLanguageMatches(script.body, language)
    )));
    const assets = allAssets.filter(asset => order.evidenceRefs.some(ref => ref.type === 'enterprise_material' && ref.id === asset.id));
    const referenceId = order.evidenceRefs.find(ref => ref.type === 'exact_analysis')?.id || '';
    const reference = analyses.find(item => item.id === referenceId);
    for (const language of languages.length ? languages : ['en']) {
      if (scripts[language]) continue;
      const directedOrder = { ...order, videoPlan: normalizeVideoPlan({ ...(order.videoPlan || input.config.videoDefaults || {}), language }) };
      let generated: GeneratedScript;
      if (process.env.DIRECTOR_SCRIPT_OFFLINE_FALLBACK === 'true') {
        generated = { script: deterministicClosedWorldStoryboard({ productFacts: productFacts(profile, input.config, order.productId), assets, language }), source: 'deterministic_closed_world_fallback', degradedReason: '已启用编导脚本离线降级模式' };
      } else try {
        generated = await generateScript({ route: order.route, config: input.config, goal: input.goal, profile, assets, reference, productId: order.productId, platformBrief: platformCreativeBrief(order.platform), contentOrder: directedOrder, learnedNarrationStyle });
      } catch (error) {
        if (!isLlmUnavailableError(error)) throw error;
        generated = {
          script: deterministicClosedWorldStoryboard({ productFacts: productFacts(profile, input.config, order.productId), assets, language }),
          source: 'deterministic_closed_world_fallback',
          degradedReason: error instanceof Error ? error.message : String(error || '脚本服务不可用'),
        };
      }
      if (!generated.script || storyboardSceneRanges(generated.script).length < 3) throw new Error(`编导脚本不完整：${order.id} / ${language}`);
      if (!storyboardVoiceLanguageMatches(generated.script, language)) {
        const repaired = await translateStoryboardFromMaster(
          generated.script,
          'mixed-script source',
          language,
          callVideoModel,
          '只修复不属于目标语种的口播文字。产品名使用目标语种可朗读名称；SKU、数字、单位与已验证事实保持不变。',
        );
        generated = { ...generated, script: repaired.script };
      }
      if (!storyboardVoiceLanguageMatches(generated.script, language)) throw new Error(`编导口播与目标语言不一致：${order.id} / ${language}`);
      scripts[language] = { version: 1, body: generated.script, hash: stableHash(generated.script), language, status: 'confirmed', generatedBy: 'director_agent', generatedAt, source: generated.source, degradedReason: generated.degradedReason };
    }
    results.push({ ...order, contractVersion: 1, scripts });
  }
  return results;
}
