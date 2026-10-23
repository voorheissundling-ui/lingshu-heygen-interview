import { createHash } from 'node:crypto';
import { benchmarkTimeRange, buildBenchmarkAnalysis, recordOf } from '../../shared/benchmarkAnalysis.js';
import { newShotProduction } from '../../src/lib/shotProduction.js';
import { referencePresenterCompositionIssue, type ReferencePresenterComposition } from './referencePresenterComposite.js';

export interface AutomatedReplicationShot {
  shotId: string; slotId: string; kind: 'person' | 'nonperson' | 'blocked'; start: number; end: number;
  required: true; productionState: 'ready' | 'blocked'; intendedKind?: 'person' | 'nonperson';
  blockerCode?: 'physical_boundary_unconfirmed' | 'material_type_unconfirmed' | 'visual_evidence_missing' | 'avatar_required' | 'presenter_authorization_required' | 'target_narration_missing' | 'reference_model_input_authorization_required' | 'reference_composition_missing' | 'usage_action_required';
  blocker?: string;
  fingerprintContext?: string;
  referenceShotId?: string;
  referenceFirstFrameUrl?: string;
  referenceComposition?: ReferencePresenterComposition;
  firstFrameRequest?: Record<string, unknown>;
}
export interface ReplicationWorkbenchInput {
  tenantId: string; projectId: string; spec: Record<string, unknown>;
  reference: Record<string, unknown>; assets?: Array<Record<string, unknown>>;
  presenterId?: string; productIds?: string[];
}
export const MANAGED_REPLICATION_PLAN_VERSION = 2;
const parse = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return recordOf(JSON.parse(value)); } catch { return {}; } }
  return recordOf(value);
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const replicationNarrationSegments = (script: string) => [...script.matchAll(/\[(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*s?\]([^]*?)(?=\[\d+(?:\.\d+)?\s*[-–—]|$)/g)].map(match => ({
  start: Number(match[1]), end: Number(match[2]), text: match[3]!.match(/(?:台词|口播|旁白|对白)\s*[：:]\s*([^\n]+)/)?.[1]?.trim() || '',
}));

/** Source motion is not automatically valid for a different target product.
 * Explicit saved target actions already bind to their selected product IDs;
 * reference actions are transferable only for the same verified enterprise
 * product, never because two items happen to share a broad category. */
export function managedReplicationAction(input: {
  plan: Record<string, unknown>; raw: Record<string, unknown>;
  reference: Record<string, unknown>; productIds: string[];
}): { startState: string; beats: string[]; endState: string; cameraMotion: string; evidence: 'confirmed_storyboard' | 'confirmed_reference_analysis' } | null {
  const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const ids = Array.isArray(input.plan.productIds) ? input.plan.productIds.map(String) : [];
  const sameTarget = input.productIds.length > 0 && JSON.stringify(ids) === JSON.stringify(input.productIds);
  const saved = {
    startState: clean(input.plan.actionStartState),
    beats: clean(input.plan.actionBeats).split(/[；;\n]+/).map(value => value.trim()).filter(Boolean),
    endState: clean(input.plan.actionEndState), cameraMotion: clean(input.raw.camera),
    evidence: 'confirmed_storyboard' as const,
  };
  if (sameTarget && saved.startState && saved.beats.length && saved.endState) return saved;
  const referenceProductId = clean(input.reference.productId);
  const sameEnterpriseProduct = input.reference.scope === 'own' && input.productIds.length === 1
    && referenceProductId === input.productIds[0] && input.raw.needsReview !== true;
  if (!sameEnterpriseProduct) return null;
  const observed = {
    startState: clean(input.raw.startState),
    beats: (Array.isArray(input.raw.beats) ? input.raw.beats : []).map(value => clean(recordOf(value).action)).filter(Boolean),
    endState: clean(input.raw.endState), cameraMotion: clean(input.raw.camera),
    evidence: 'confirmed_reference_analysis' as const,
  };
  return observed.startState && observed.beats.length && observed.endState ? observed : null;
}

export function trustedReferenceDuration(reference: Record<string, unknown>): number {
  const analysis = parse(reference.aiAnalysis);
  const gemini = parse(analysis.gemini);
  const clock = recordOf(gemini.sourceMediaClock);
  const sourceSha256 = String(analysis.contentSha256 || '');
  const currentObjectKey = String(analysis.videoObjectKey || reference.videoFileId || '');
  const duration = Number(clock.duration);
  const measuredSha256 = String(clock.sourceSha256 || '');
  const sourceMatches = sourceSha256
    ? measuredSha256 === sourceSha256
    : Boolean(currentObjectKey && String(clock.videoObjectKey || '') === currentObjectKey);
  const trusted = /^[a-f0-9]{64}$/i.test(measuredSha256)
    && sourceMatches
    && Boolean(clock.analysisRunId)
    && String(clock.analysisRunId) === String(analysis.analysisRunId || '')
    && Number.isFinite(duration) && duration > 0;
  return trusted ? duration : Number(reference.duration);
}

/** Initialize the same stable-shot workbench used by the editor; never flatten clone into catalog slides. */
export function buildReplicationWorkbenchSpec(input: ReplicationWorkbenchInput): Record<string, unknown> {
  const referenceTenant = String(input.reference.tenantId || input.reference.tenant_id || '');
  if (!input.tenantId || !input.projectId || referenceTenant !== input.tenantId) throw Error('复刻参考视频不属于当前企业');
  const analysis = parse(input.reference.aiAnalysis);
  if (analysis.analysisMode !== 'exact' || !['video', 'video_review_required'].includes(String(analysis.analysisQuality))) throw Error('复刻需要全片精确视频分析');
  const referenceId = String(input.reference.id || '');
  if (!referenceId) throw Error('复刻参考视频标识缺失');
  // Legacy exact records used shots instead of scriptDetails15s.
  const gemini = parse(analysis.gemini);
  const rawDetails = (Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : Array.isArray(gemini.shots) ? gemini.shots : []).map(item => ({ ...recordOf(item) }));
  const ranges = rawDetails.map(row => benchmarkTimeRange(row.time || row.timestamp));
  const cuts = Array.isArray(gemini.detectedSceneCuts) ? gemini.detectedSceneCuts.map(Number) : [];
  const mediaDuration = trustedReferenceDuration(input.reference);
  const last = ranges.at(-1);
  const terminalBoundaryCorrected = Boolean(last && last.end > mediaDuration && last.start < mediaDuration
    && cuts.length === rawDetails.length - 1
    && ranges.every((range, index) => range && (index === 0 ? range.start <= 0.35 : Math.abs(range.start - cuts[index - 1]!) < 0.05)
      && (index === ranges.length - 1 || Math.abs(range.end - cuts[index]!) < 0.05)));
  if (terminalBoundaryCorrected) rawDetails[rawDetails.length - 1]!.time = `${last!.start}-${mediaDuration}s`;
  const normalized = buildBenchmarkAnalysis({ videoId: referenceId, duration: mediaDuration, analysis: {
    ...analysis, gemini: { ...gemini, scriptDetails15s: rawDetails },
  } });
  if (!normalized.timelineComplete) throw Error('复刻逐镜时间线不完整，不能生成完整成片');
  const revision = hash(normalized.shots);
  const prior = recordOf(input.spec.automatedReplicationPlan);
  if (prior.version === MANAGED_REPLICATION_PLAN_VERSION) {
    if (prior.referenceId !== referenceId || prior.referenceRevision !== revision) throw Error('复刻参考分析已变化，请创建新制作版本，不能覆盖已有供应商任务');
    return input.spec;
  }
  if (prior.version && prior.version !== 1) throw Error('复刻工作台版本不兼容，请创建新制作版本');
  if (prior.version === 1 && (prior.referenceId !== referenceId || prior.referenceRevision !== revision)) {
    throw Error('复刻参考分析已变化，请创建新制作版本，不能覆盖已有供应商任务');
  }
  const assemblyId = 'video-1';
  const ratio = String(input.spec.ratio || '9:16');
  const productIds = input.productIds || (Array.isArray(input.spec.selectedProductIds) ? input.spec.selectedProductIds.map(String) : []);
  const order = recordOf(input.spec.contentOrder);
  const scripts = recordOf(order.scripts);
  const frozen = recordOf(scripts[String(input.spec.lang || 'en')]);
  const frozenBody = frozen.status === 'confirmed' && frozen.generatedBy === 'director_agent' && frozen.hash === hash(frozen.body) ? String(frozen.body || '') : '';
  if (Object.keys(scripts).length && !frozenBody) throw Error('编导冻结脚本合同校验失败');
  if (frozenBody && input.spec.script && input.spec.script !== frozenBody) throw Error('工作台脚本与编导冻结合同不一致');
  const script = frozenBody || String(input.spec.script || '');
  if (!script) throw Error('逐镜复刻缺少编导冻结脚本');
  const narration = replicationNarrationSegments(script);
  const referenceModelInputAuthorized = (input.reference.modelInputAuthorized === true || analysis.modelInputAuthorized === true)
    && Boolean(String(input.reference.modelInputAuthorizationEvidence || analysis.modelInputAuthorizationEvidence || '').trim());
  const referenceModelInputAuthorizationEvidence = String(input.reference.modelInputAuthorizationEvidence || analysis.modelInputAuthorizationEvidence || '').trim();
  const slots: Array<Record<string, unknown>> = [];
  const productions: Record<string, unknown> = {};
  const sourcePlans: Record<string, unknown> = {};
  const automatedShots: AutomatedReplicationShot[] = [];
  const details: Array<Record<string, unknown>> = [];
  for (const shot of normalized.shots) {
    const start = shot.start!, end = shot.end!;
    const slotId = `slot-${shot.index}`;
    const shotId = `replication-${hash([input.projectId, referenceId, shot.index]).slice(0, 24)}`;
    const fingerprintContext = `automated-replication-shot:${hash({ referenceId, shot })}`;
    const raw = rawDetails[shot.index - 1]!;
    const referenceShotId = String(raw.shotId || raw.id || `${referenceId}:shot-${shot.index}`);
    const referenceFirstFrameUrl = `/api/overseas/videos/${encodeURIComponent(referenceId)}/shot/${shot.index}/first-frame`;
    const referenceComposition: ReferencePresenterComposition = {
      referenceShotId,
      referenceFirstFrameUrl,
      background: String(shot.environment || '').trim(),
      framing: String(shot.framing || '').trim(),
      camera: String(shot.camera || '').trim(),
      composition: String(raw.composition || shot.visual || '').trim(),
    };
    const role = String(raw.observedPresenterRole || '');
    const foregroundPerson = /女性|男性|女人|男人|女士|男士|主播|主持人|presenter/i.test(shot.visual)
      && !/背景.{0,8}(女性|男性|人物)|工人背影|人群|路人/.test(shot.visual);
    const observedPerson = ['sales_presenter', 'presenter_action'].includes(role) || shot.materialType === 'talking_head'
      || (role === 'unknown' && foregroundPerson);
    const savedSourcePlan = recordOf(recordOf(input.spec.storyboardSourcePlans)[slotId]);
    const action = managedReplicationAction({ plan: savedSourcePlan, raw, reference: input.reference, productIds });
    const targetText = narration.filter(segment => segment.start < end && segment.end > start).map(segment => {
      // A frozen narration line spanning several reference beats is partitioned, never repeated per shot.
      const tokens = /\s/.test(segment.text) ? segment.text.split(/\s+/) : Array.from(segment.text);
      const length = segment.end - segment.start;
      const from = Math.round(Math.max(0, start - segment.start) / length * tokens.length);
      const to = Math.round(Math.min(length, end - segment.start) / length * tokens.length);
      return tokens.slice(from, to).join(/\s/.test(segment.text) ? ' ' : '');
    }).filter(Boolean).join('\n');
    const compositionIssue = observedPerson ? referencePresenterCompositionIssue(referenceComposition) : null;
    const evidenceBlocker = observedPerson && !input.presenterId
      ? { code: 'avatar_required' as const, message: `第 ${shot.index} 镜尚未录入并授权企业默认人物` }
      : observedPerson && !targetText
        ? { code: 'target_narration_missing' as const, message: `第 ${shot.index} 镜缺少企业目标台词，禁止直接复用原片商业口播` }
        : observedPerson && !referenceModelInputAuthorized
          ? { code: 'reference_model_input_authorization_required' as const, message: `第 ${shot.index} 镜缺少对标分镜首帧作为模型输入的授权依据` }
          : observedPerson && compositionIssue
            ? { code: 'reference_composition_missing' as const, message: `第 ${shot.index} 镜${compositionIssue}` }
            : null;
    const fallbackReasons = [
      ...(!observedPerson && !referenceModelInputAuthorized ? ['原片未授权作为模型输入，仅使用企业产品素材生成'] : []),
      ...(shot.granularity !== 'shot' ? ['未确认物理切镜，仅保留时间窗口'] : []),
      ...(shot.materialType === 'unknown' ? ['镜头类型待复核'] : []),
      ...(!shot.visual.trim() ? ['原片画面事实不足'] : []),
      ...(!observedPerson && !targetText && shot.materialType === 'talking_head' ? ['原片无可验证口播'] : []),
      ...(shot.materialType === 'consumer_demo' && !action ? ['目标产品用法未确认'] : []),
    ];
    // A detected presenter shot must remain a presenter shot. It may block for
    // missing evidence, but it cannot silently degrade to a generic scene.
    const safeFallback = !evidenceBlocker && !observedPerson && fallbackReasons.length > 0;
    const person = observedPerson && !evidenceBlocker;
    const fallbackVisual = productIds.length
      ? '使用已绑定的企业产品素材做静物、转台或包装细节展示；不展示人物，不演示未确认用法，不复刻原片品牌与口播'
      : '使用企业已授权素材做无人物的中性信息画面；不推断产品功效或原片台词';
    const detail = `镜头功能：${shot.purpose}\n画面：${safeFallback ? fallbackVisual : shot.visual}\n环境：${safeFallback ? '企业产品展示场景' : shot.environment}\n景别：${safeFallback ? '产品近景或细节特写' : shot.framing}\n运镜：${safeFallback ? '固定或缓慢推拉' : shot.camera}${safeFallback ? `\n安全降级：${fallbackReasons.join('；')}` : ''}`;
    slots.push({ id: shotId, slotId, detail, duration: end - start, requirements: JSON.stringify({ detail, start, end, ratio, productIds,
      ...(evidenceBlocker ? { blockerCode: evidenceBlocker.code } : {}) }),
      observedPresenterRole: observedPerson ? 'sales_presenter' : 'none', salesPresenterConfirmed: false,
      ...(evidenceBlocker ? { locked: true, blocker: evidenceBlocker.message } : {}) });
    const sourceFirstFrameUrl = referenceFirstFrameUrl;
    details.push({ ...shot, shotId: slotId,
      // buildBenchmarkAnalysis retains the extracted frame URL for review.
      // Do not let that field leak into a generation contract when the source
      // was not authorized as model input or this shot uses the safe fallback.
      firstFrameRef: referenceModelInputAuthorized && !safeFallback ? sourceFirstFrameUrl : '',
      observedPresenterRole: observedPerson ? 'sales_presenter' : 'none',
      startState: typeof raw.startState === 'string' ? raw.startState : '',
      endState: typeof raw.endState === 'string' ? raw.endState : '',
      beats: Array.isArray(raw.beats) ? raw.beats : [],
      ...(safeFallback ? { productionFallback: { mode: 'enterprise_product_display', reasons: fallbackReasons } } : {}),
      ...(evidenceBlocker ? { productionBlocker: evidenceBlocker } : {}) });
    if (evidenceBlocker) {
      sourcePlans[slotId] = { mode: 'blocked', sceneType: 'general', productIds, confirmed: false, decided: false,
        blockerCode: evidenceBlocker.code, blocker: evidenceBlocker.message };
      automatedShots.push({ shotId, slotId, kind: 'blocked', intendedKind: observedPerson ? 'person' : 'nonperson', start, end,
        required: true, productionState: 'blocked', blockerCode: evidenceBlocker.code, blocker: evidenceBlocker.message, fingerprintContext });
      continue;
    }
    const production = newShotProduction(targetText, person ? input.presenterId : '');
    if (person) {
      production.source = 'avatar'; production.sound = 'source';
      production.digitalHuman = { workflow: 'viral_replication', method: 'reenact', replicationMode: 'sentence_first_frame',
        preferredProvider: 'auto', contentConfirmed: false, action: shot.visual, scene: shot.environment, preserve: '企业人物身份、企业产品身份、参考动作和节奏',
        reference: { videoUrl: `/api/overseas/videos/${encodeURIComponent(referenceId)}/media-url`, start, end, originalText: shot.dialogue,
          derivativeAuthorized: false, modelInputAuthorized: true, modelInputAuthorizationEvidence: referenceModelInputAuthorizationEvidence,
          cues: [{ id: `${shotId}:cue`, start, end, originalText: shot.dialogue, targetText,
            shotIds: [slotId], personShot: true, classificationSource: 'analysis', sourceFirstFrame: {time: start},
            referenceShotId, referenceFirstFrameUrl,
            generationDurationSeconds: Math.max(4, end - start), outputDurationSeconds: end - start,
            composition: { presenterKey: input.presenterId!, shotSize: shot.framing, cameraAngle: shot.camera, background: shot.environment,
              actionIntent: shot.visual, referenceShotId, sourceComposition: referenceComposition.composition } }] } };
    }
    productions[`${assemblyId}:${shotId}`] = production;
    const sceneType = safeFallback && productIds.length ? 'product'
      : shot.materialType === 'product' ? 'product'
      : shot.materialType === 'factory' ? 'factory'
      : shot.materialType === 'consumer_demo' ? 'usage'
      : 'general';
    sourcePlans[slotId] = { mode: person ? 'digital_human' : 'ai', sceneType, productIds,
      ...(safeFallback ? { fallbackMode: 'enterprise_product_display', fallbackReasons } : {}),
      ...(!safeFallback && action?.evidence === 'confirmed_storyboard' ? { actionStartState: action.startState,
        actionBeats: action.beats.join('；'), actionEndState: action.endState } : {}),
      confirmed: false, decided: true, videoResolution: '480p', videoResolutionPinned: true };
    automatedShots.push({ shotId, slotId, kind: person ? 'person' : 'nonperson', start, end, required: true, productionState: 'ready', fingerprintContext,
      ...(person ? { referenceShotId, referenceFirstFrameUrl, referenceComposition } : {}),
      ...(!person ? { firstFrameRequest: { projectId: input.projectId, shotId, requestId: `auto-frame-${hash([input.projectId, revision, shot.index]).slice(0, 32)}`,
        mode: safeFallback ? 'free_creation' : 'replication', sceneType, shotDescription: detail,
        startSeconds: start, endSeconds: end, ratio, productIds,
        ...(referenceModelInputAuthorized && !safeFallback ? { sourceFirstFrameUrl } : {}),
        ...(!safeFallback && action ? { action } : {}),
        ...(safeFallback ? { fallbackMode: 'enterprise_product_display' } : {}) } } : {}) });
  }
  const built = { ...input.spec, mode: 'clone', contentMode: 'video', creationPath: 'viral_replication', manualWorkflow: false,
    activeAssemblyId: assemblyId, assemblyName: '视频1', ratio, script, selectedProductIds: productIds,
    shootingSlots: slots, shotProductions: productions, shotProductionContext: `automated-replication:${revision}`, automatedReplicationShots: automatedShots,
    storyboardAssignments: {}, storyboardSourcePlans: sourcePlans, selected: [],
    storyboardAssemblies: [{ id: assemblyId, name: '视频1', assignments: {}, sourcePlans, selected: [] }],
    videoKickoff: { ...recordOf(input.spec.videoKickoff), source: 'inspiration', video: { ...input.reference, referenceRecordId: referenceId, videoUrl: `/api/overseas/videos/${encodeURIComponent(referenceId)}/media-url`, aiAnalysis: analysis }, referenceAnalysis: { details } },
    automatedReplicationPlan: { version: MANAGED_REPLICATION_PLAN_VERSION, referenceId, referenceRevision: revision, tenantId: input.tenantId, ...(terminalBoundaryCorrected ? { terminalBoundaryCorrection: { source: 'media_duration_and_detected_scene_cuts', originalEnd: last!.end, effectiveEnd: mediaDuration } } : {}) },
  };
  if (prior.version !== 1) return built;

  const previousSourcePlans = recordOf(input.spec.storyboardSourcePlans);
  const migratedSourcePlans = Object.fromEntries(Object.entries(sourcePlans).map(([slotId, next]) => {
    const previous = recordOf(previousSourcePlans[slotId]);
    if (!previous.mode || previous.mode === 'blocked') return [slotId, next];
    const merged = { ...recordOf(next), ...previous };
    // Safety routing belongs to the current reference authorization state, not
    // to an old editable source-plan snapshot. Preserve the user's other
    // source choices while applying (or removing) the current safe fallback.
    if (recordOf(next).fallbackMode) {
      merged.fallbackMode = recordOf(next).fallbackMode;
      merged.fallbackReasons = recordOf(next).fallbackReasons;
      merged.sceneType = recordOf(next).sceneType;
    } else {
      delete merged.fallbackMode;
      delete merged.fallbackReasons;
    }
    return [slotId, merged];
  }));
  const assignments = recordOf(input.spec.storyboardAssignments);
  const selected = Array.isArray(input.spec.selected) ? input.spec.selected : [];
  return {
    ...built,
    shotProductions: { ...productions, ...recordOf(input.spec.shotProductions) },
    storyboardAssignments: assignments,
    storyboardSourcePlans: migratedSourcePlans,
    selected,
    ...(input.spec.automatedReplicationProgress ? { automatedReplicationProgress: input.spec.automatedReplicationProgress } : {}),
    ...(input.spec.clipEdits ? { clipEdits: input.spec.clipEdits } : {}),
    storyboardAssemblies: [{ id: assemblyId, name: '视频1', assignments, sourcePlans: migratedSourcePlans, selected }],
  };
}
