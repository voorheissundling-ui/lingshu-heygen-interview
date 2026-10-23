import type {
  SocialAudienceRole,
  SocialBenchmarkAccountType,
  SocialCandidateEvidence,
  SocialBusinessModel,
  SocialCollectionScopeMode,
  SocialCompanyRole,
  SocialContentSearchUnit,
  SocialCrawlKeywordCategory,
  SocialCrawlStrategy,
  SocialDiscoveryMode,
  SocialDiscoveryCandidateScore,
  SocialInspirationHandoff,
  SocialInspirationReadiness,
  SocialInspirationScores,
  SocialKeywordEvidenceSource,
  SocialReferenceVideoAnalysis,
  SocialReplicationCausalRole,
  SocialReplicationFactorCategory,
  SocialReplicationFactorEvidence,
  SocialReplicationFactorPolicy,
  SocialReplicationFactorSpec,
  SocialReplicationReferenceMode,
  SocialSceneCluster,
  SocialTimelineBeat,
} from './contracts/socialContentWorkflow';

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function clamp01(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : 0;
}

function stableHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  return (hash >>> 0).toString(36);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(JSON.stringify(value))}`;
}

function normalizedPlatform(value: string): string {
  const platform = value.trim().toLowerCase();
  if (platform === 'tik tok') return 'tiktok';
  if (platform === 'you tube') return 'youtube';
  return platform;
}

/**
 * The collection budget is deliberately asymmetric: TikTok is the main
 * discovery field, while YouTube is retained only for targeted evidence.
 */
export function normalizeSocialPlatformQuotas(platforms: string[], resultLimit: number): Array<{ platform: string; limit: number; weight: number }> {
  const selected = unique(platforms.map(normalizedPlatform));
  if (!selected.includes('tiktok')) selected.unshift('tiktok');
  const supported = selected.filter(platform => ['tiktok', 'instagram', 'facebook', 'youtube'].includes(platform));
  const total = Math.max(1, Math.floor(resultLimit));
  const socialCount = supported.filter(item => item === 'instagram' || item === 'facebook').length;
  const auxiliaryWeights = Object.fromEntries(supported.filter(platform => platform !== 'tiktok').map(platform => [platform,
    platform === 'youtube' ? 0.1 : 0.15 / Math.max(1, socialCount),
  ]));
  const auxiliaryTotal = Object.values(auxiliaryWeights).reduce((value, weight) => value + weight, 0);
  const normalized = supported.map(platform => ({ platform, weight: platform === 'tiktok' ? Math.max(0.75, 1 - auxiliaryTotal) : auxiliaryWeights[platform] }));
  const quotas = normalized.map(item => ({ ...item, limit: Math.floor(total * item.weight) }));
  let assigned = quotas.reduce((value, item) => value + item.limit, 0);
  for (const item of [...quotas].sort((a, b) => b.weight - a.weight || a.platform.localeCompare(b.platform))) {
    if (assigned >= total) break;
    item.limit += 1;
    assigned += 1;
  }
  return quotas;
}

export function inferSocialBusinessModel(text: string): SocialBusinessModel {
  const value = text.toLowerCase();
  const b2b = /\b(oem|odm|wholesale|wholesaler|distributor|manufacturer|factory|supplier|procurement|bulk|private label|trade show|dealer)\b|批发|经销|代理|工厂|制造商|供应商|采购|贴牌|代工|外贸/.test(value);
  const d2c = /\b(shop now|buy now|add to cart|checkout|discount code|free shipping|unboxing|haul|routine|influencer)\b|立即购买|加入购物车|折扣码|包邮|开箱|种草|日常护肤/.test(value);
  if (b2b && d2c) return 'mixed';
  if (b2b) return 'b2b';
  if (d2c) return 'd2c';
  return 'unknown';
}

function evidenceLevelScore(level: 'high' | 'medium' | 'low'): number {
  return level === 'high' ? 90 : level === 'medium' ? 60 : 25;
}

/** Authoritative, deterministic candidate score used by persistence and filtering. */
export function scoreSocialDiscoveryCandidate(input: {
  evidence: Omit<SocialCandidateEvidence, 'qualityScore' | 'classification'>;
  platform?: string;
  keywordTier?: 'broad' | 'medium' | 'evidence' | 'account' | 'unknown';
  audienceRole?: SocialAudienceRole;
  sourceText?: string;
  hasSource?: boolean;
  now?: Date;
}): SocialDiscoveryCandidateScore & { businessModel: SocialBusinessModel } {
  const platform = normalizedPlatform(input.platform || 'unknown');
  const businessModel = inferSocialBusinessModel(input.sourceText || '');
  const expectsBusiness = (input.audienceRole ?? 'consumer') !== 'consumer';
  const businessModelFit = expectsBusiness
    ? businessModel === 'b2b' ? 100 : businessModel === 'mixed' ? 75 : businessModel === 'unknown' ? 50 : 15
    : businessModel === 'd2c' ? 100 : businessModel === 'mixed' ? 75 : businessModel === 'unknown' ? 55 : 35;
  const relevance = evidenceLevelScore(input.evidence.relevance.level);
  const transferability = evidenceLevelScore(input.evidence.transferability.level);
  const momentum = input.evidence.momentum.level === 'rising' ? 95 : input.evidence.momentum.level === 'high_performance' ? 75 : 35;
  const hasSource = input.hasSource !== false && input.evidence.evidenceRefs.length > 0;
  const evidence = hasSource ? Math.min(100, 55 + input.evidence.evidenceRefs.length * 12) : 0;
  const platformPriority = platform === 'linkedin' ? 100 : platform === 'facebook' ? 90 : platform === 'tiktok' ? 70 : platform === 'instagram' ? 60 : platform === 'youtube' ? 45 : 30;
  const tierBoost = input.keywordTier === 'medium' ? 10 : input.keywordTier === 'account' ? 8 : input.keywordTier === 'evidence' ? 5 : input.keywordTier === 'broad' ? -10 : 0;
  const overall = Math.max(0, Math.min(100, Math.round(
    relevance * 0.25 + transferability * 0.2 + momentum * 0.1 + evidence * 0.15
    + Math.max(0, Math.min(100, platformPriority + tierBoost)) * 0.1 + businessModelFit * 0.2,
  )));
  const blockers = [
    ...(!hasSource ? ['缺少可追溯来源或证据'] : []),
    ...(input.evidence.relevance.level === 'low' ? ['与当前产品、市场或沟通对象相关性过低'] : []),
    ...(expectsBusiness && businessModel === 'd2c' ? ['账号以 DTC 消费者卖货为主，不符合当前 B2B 客群'] : []),
  ];
  const decision = blockers.length ? 'rejected' : overall >= 70 ? 'accepted' : overall >= 50 ? 'review' : 'rejected';
  const reasons = [
    `相关性 ${relevance} / 可迁移性 ${transferability} / 证据 ${evidence}`,
    platform === 'linkedin' || platform === 'facebook' ? `${platform} 对标账号主采集阵地加权` : `${platform || '未知平台'} 非主采集来源`,
    expectsBusiness ? `B2B 匹配：${businessModel}` : `消费者业务匹配：${businessModel}`,
    input.keywordTier === 'medium' ? '命中用户痛点或产品卖点中词' : `查询层级：${input.keywordTier ?? 'unknown'}`,
  ];
  return {
    ruleVersion: 'discovery-score-v1', overall,
    dimensions: { relevance, transferability, momentum, evidence, platformPriority, businessModelFit },
    decision, reasons, blockers, scoredAt: (input.now ?? new Date()).toISOString(), businessModel,
  };
}

function factorCategory(value: string, fallback: SocialReplicationFactorCategory): SocialReplicationFactorCategory {
  if (/钩子|首帧|前三秒|first frame|hook/i.test(value)) return 'hook';
  if (/光|阴影|高光|色温|lighting|shadow|highlight/i.test(value)) return 'lighting';
  if (/桌|环境|场景|背景|杂物|生活化|environment|background/i.test(value)) return 'environment';
  if (/开盖|闭盖|封膜|残留|痕迹|湿润|干燥|磨损|膏|液体|粉末|状态|state/i.test(value)) return 'object_state';
  if (/手|触碰|接触|视线|姿态|动作|交互|interaction|gesture/i.test(value)) return 'interaction';
  if (/构图|占比|位置|遮挡|前景|后景|中心|留白|composition/i.test(value)) return 'composition';
  if (/机位|俯拍|仰拍|特写|景别|运镜|镜头|camera|angle|close-up/i.test(value)) return 'camera';
  if (/节奏|时长|切镜|卡点|停顿|rhythm|timing|pace/i.test(value)) return 'rhythm';
  if (/音乐|音效|声音|口播|audio|music|voice/i.test(value)) return 'audio';
  if (/字幕|文案|文字|caption|text|ocr/i.test(value)) return 'caption';
  if (/产品|人脸|人物|品牌|商标|logo|身份|identity|face/i.test(value)) return 'identity';
  return fallback;
}

function causalRoleForPurpose(purpose: SocialTimelineBeat['purpose']): SocialReplicationCausalRole {
  if (purpose === 'hook') return 'retention';
  if (purpose === 'proof' || purpose === 'demonstration') return 'proof';
  if (purpose === 'trust') return 'trust';
  if (purpose === 'call_to_action') return 'conversion';
  if (purpose === 'transition') return 'emotion';
  return 'understanding';
}

function validatorForCategory(category: SocialReplicationFactorCategory, policy: SocialReplicationFactorPolicy) {
  const kind = policy === 'prohibit_reuse' ? 'rights_fingerprint' as const
    : category === 'rhythm' || category === 'hook' ? 'timeline_alignment' as const
    : category === 'composition' ? 'composition' as const
      : category === 'lighting' ? 'lighting' as const
        : category === 'interaction' ? 'motion' as const
          : category === 'audio' ? 'audio' as const
            : category === 'caption' ? 'ocr' as const
              : category === 'identity' && policy === 'replace_identity' ? 'identity' as const
                  : category === 'environment' ? 'spatial_relation' as const
                    : 'vision_state' as const;
  return {
    kind,
    detector: kind === 'timeline_alignment' ? 'semantic-beat-dtw'
      : kind === 'composition' ? 'subject-mask-layout'
        : kind === 'lighting' ? 'light-direction-color-contrast'
          : kind === 'motion' ? 'object-hand-track'
            : kind === 'audio' ? 'audio-energy-and-fingerprint'
              : kind === 'ocr' ? 'ocr-text-similarity'
                : kind === 'identity' ? 'identity-region-replacement'
                  : kind === 'rights_fingerprint' ? 'perceptual-and-audio-fingerprint'
                    : kind === 'spatial_relation' ? 'scene-graph-relation'
                      : 'multimodal-state-check',
    evidenceOutput: kind === 'audio'
      ? ['audio_segment', 'measurement'] as const
      : kind === 'rights_fingerprint'
        ? ['match_region', 'measurement'] as const
        : ['reference_frame', 'output_frame', 'measurement'] as const,
  };
}

/**
 * Projects historic shot analysis into the production-grade beat contract.
 * Unknown micro details remain explicit null/empty fields instead of being
 * hallucinated by the Director Agent.
 */
export function buildSocialTimelineBeats(analysis: SocialReferenceVideoAnalysis): SocialTimelineBeat[] {
  if (analysis.timelineBeats?.length) return structuredClone(analysis.timelineBeats);
  const observationConfidence = analysis.coverage?.overallConfidence ?? null;
  return analysis.shots.map((shot, index): SocialTimelineBeat => ({
    beatId: stableId('timeline_beat', { analysisId: analysis.analysisId, shotId: shot.shotId, index }),
    referenceAnalysisId: analysis.analysisId,
    referenceShotId: shot.shotId,
    startSeconds: shot.startSeconds,
    endSeconds: shot.endSeconds,
    purpose: shot.purpose,
    subjects: (shot.tags?.subjects ?? []).map((description, subjectIndex) => ({
      subjectId: stableId('subject', { shotId: shot.shotId, description, subjectIndex }),
      kind: /人|person|face/i.test(description) ? 'person'
        : /产品|商品|瓶|罐|product/i.test(description) ? 'product'
          : /字幕|文字|screen|caption/i.test(description) ? 'screen_text'
            : 'other',
      description,
      identitySensitive: /人|person|face|产品|商品|品牌|product|logo/i.test(description),
    })),
    action: {
      startState: shot.action?.startState ?? '',
      path: shot.action?.path ?? shot.visualDescription,
      endState: shot.action?.endState ?? '',
      spatialRelation: shot.action?.spatialRelation ?? '',
      startsAtSeconds: null,
      revealAtSeconds: null,
    },
    objectStates: [],
    shotLanguage: {
      shotSize: shot.shotLanguage?.shotSize ?? '',
      cameraAngle: shot.shotLanguage?.cameraAngle ?? '',
      movement: shot.shotLanguage?.movement ?? '',
      composition: shot.shotLanguage?.composition ?? '',
      subjectAreaRatio: null,
      subjectPosition: null,
    },
    lighting: { direction: null, softness: null, colorTemperature: null, contrast: null, shadowAndHighlight: null },
    environment: {
      semanticType: shot.tags?.sceneTypes?.[0] ?? null,
      materials: [],
      clutterDensity: null,
      livedInDetails: [],
    },
    audioLayers: {
      voice: shot.audioLayers?.voice ?? shot.spokenText,
      captions: shot.audioLayers?.captions ?? shot.captionText,
      ambient: shot.audioLayers?.ambient ?? shot.audioDescription,
      music: shot.audioLayers?.music ?? null,
      soundEffects: shot.audioLayers?.soundEffects ?? null,
    },
    rhythm: { description: shot.rhythmDescription, cutAtSeconds: shot.endSeconds, beatAtSeconds: [] },
    continuity: { incomingState: [], outgoingState: [], conflicts: [] },
    observation: {
      observableFacts: [...(shot.observation?.observableFacts ?? [])],
      inferredIntent: [...(shot.observation?.inferredIntent ?? [])],
      causalGaps: [...(shot.observation?.causalGaps ?? [])],
      confidence: observationConfidence,
      needsHumanReview: Boolean(shot.observation?.causalGaps?.length),
    },
  }));
}

export function inferSocialReplicationReferenceMode(input: {
  explicitMode?: SocialReplicationReferenceMode | null;
  userRequestedExactReplication?: boolean;
  referenceCount: number;
  hasAccountFormatEvidence?: boolean;
}): SocialReplicationReferenceMode {
  if (input.explicitMode) return input.explicitMode;
  if (input.userRequestedExactReplication || input.referenceCount <= 1) return 'single_source_fidelity';
  if (input.hasAccountFormatEvidence) return 'account_format_series';
  return 'multi_source_hybrid';
}

export interface BuildSocialReplicationFactorSpecsInput {
  analysis: SocialReferenceVideoAnalysis;
  referenceMode: SocialReplicationReferenceMode;
  version: string;
  frozenAt?: string | null;
  additionalEvidence?: Array<{
    matchText: string;
    evidence: SocialReplicationFactorEvidence;
  }>;
}

/**
 * Builds Director-owned factor hypotheses from observable media evidence.
 * Without account metrics or controlled experiments causal confidence stays
 * deliberately low; source popularity is never treated as proof of causality.
 */
export function buildSocialReplicationFactorSpecs(input: BuildSocialReplicationFactorSpecsInput): SocialReplicationFactorSpec[] {
  const beats = buildSocialTimelineBeats(input.analysis);
  const shotsById = new Map(input.analysis.shots.map(shot => [shot.shotId, shot]));
  const frozenAt = input.frozenAt === undefined ? new Date().toISOString() : input.frozenAt;
  const factorRows: Array<{
    beat: SocialTimelineBeat;
    category: SocialReplicationFactorCategory;
    description: string;
    policy: SocialReplicationFactorPolicy;
    importance: SocialReplicationFactorSpec['importance'];
    metric: string;
    value: SocialReplicationFactorSpec['target']['value'];
    unit?: string | null;
  }> = [];
  const add = (row: typeof factorRows[number]) => {
    if (!row.description.trim()) return;
    if (factorRows.some(item => item.beat.beatId === row.beat.beatId && item.category === row.category && item.description === row.description)) return;
    factorRows.push(row);
  };

  for (const beat of beats) {
    const shot = beat.referenceShotId ? shotsById.get(beat.referenceShotId) : undefined;
    for (const point of shot?.fidelityPoints ?? []) {
      const category = factorCategory(point, beat.purpose === 'hook' ? 'hook' : 'rhythm');
      const policy: SocialReplicationFactorPolicy = category === 'environment' ? 'equivalent'
        : category === 'composition' || category === 'lighting' || category === 'camera' ? 'bounded'
          : category === 'object_state' || category === 'interaction' || category === 'hook' ? 'lock' : 'lock';
      add({ beat, category, description: point, policy, importance: beat.purpose === 'hook' ? 'critical' : 'high', metric: `${category}.semantic_state`, value: point });
    }
    for (const point of shot?.mustDifferPoints ?? []) {
      const category = factorCategory(point, 'identity');
      const policy: SocialReplicationFactorPolicy = category === 'identity' ? 'replace_identity' : 'prohibit_reuse';
      add({ beat, category, description: point, policy, importance: 'critical', metric: `${category}.replacement`, value: true });
    }
    for (const state of beat.objectStates) {
      add({ beat, category: 'object_state', description: `${state.attribute}：${state.value}`, policy: state.visibility === 'clear' ? 'lock' : 'bounded', importance: state.visibility === 'clear' ? 'critical' : 'high', metric: `object_state.${state.attribute}`, value: state.value });
    }
    for (const subject of beat.subjects.filter(item => item.identitySensitive)) {
      add({
        beat,
        category: 'identity',
        description: `替换参考主体身份：${subject.description}`,
        policy: 'replace_identity',
        importance: 'critical',
        metric: `identity.${subject.subjectId}.replaced`,
        value: true,
      });
    }
    if (beat.action.path) {
      add({ beat, category: 'interaction', description: beat.action.path, policy: beat.purpose === 'hook' ? 'lock' : 'bounded', importance: beat.purpose === 'hook' ? 'critical' : 'high', metric: 'interaction.action_path', value: beat.action.path });
    }
    if (beat.environment.semanticType) {
      add({ beat, category: 'environment', description: `保持感知等价环境：${beat.environment.semanticType}`, policy: 'equivalent', importance: beat.purpose === 'hook' ? 'high' : 'medium', metric: 'environment.semantic_type', value: beat.environment.semanticType });
    }
    const lightingValues = Object.entries(beat.lighting).filter((entry): entry is [string, string] => Boolean(entry[1]));
    if (lightingValues.length) {
      add({ beat, category: 'lighting', description: lightingValues.map(([key, value]) => `${key}:${value}`).join('；'), policy: 'bounded', importance: 'high', metric: 'lighting.attributes', value: lightingValues.map(([key, value]) => `${key}:${value}`) });
    }
    const cameraValues = [beat.shotLanguage.shotSize, beat.shotLanguage.cameraAngle, beat.shotLanguage.movement].filter(Boolean);
    if (cameraValues.length) {
      add({ beat, category: 'camera', description: cameraValues.join('；'), policy: beat.purpose === 'hook' ? 'lock' : 'bounded', importance: beat.purpose === 'hook' ? 'high' : 'medium', metric: 'camera.language', value: cameraValues });
    }
    if (beat.shotLanguage.composition) {
      add({ beat, category: 'composition', description: beat.shotLanguage.composition, policy: 'bounded', importance: 'high', metric: 'composition.layout', value: beat.shotLanguage.composition });
    }
    if (beat.rhythm.description) {
      add({ beat, category: 'rhythm', description: beat.rhythm.description, policy: 'lock', importance: beat.purpose === 'hook' ? 'critical' : 'high', metric: 'rhythm.duration_seconds', value: +(beat.endSeconds - beat.startSeconds).toFixed(3), unit: 'seconds' });
    }
  }
  const firstBeat = beats[0];
  if (firstBeat && input.referenceMode === 'single_source_fidelity') {
    add({ beat: firstBeat, category: 'identity', description: '禁止复用原视频连续画面、Logo、水印和独特美术资产', policy: 'prohibit_reuse', importance: 'critical', metric: 'rights.visual_fingerprint_match', value: false });
    add({ beat: firstBeat, category: 'audio', description: '禁止复用原始音乐、口播录音和声音素材', policy: 'prohibit_reuse', importance: 'critical', metric: 'rights.audio_fingerprint_match', value: false });
    add({ beat: firstBeat, category: 'caption', description: '禁止照搬原台词、字幕和 CTA 文案', policy: 'prohibit_reuse', importance: 'critical', metric: 'rights.text_similarity_block', value: false });
  }

  return factorRows.map((row, index): SocialReplicationFactorSpec => {
    const effectivePolicy: SocialReplicationFactorPolicy = input.referenceMode === 'account_format_series' && row.policy === 'lock'
      ? (row.category === 'environment' || row.category === 'hook' ? 'equivalent' : 'bounded')
      : row.policy;
    const sourceEvidence: SocialReplicationFactorEvidence = {
      evidenceId: stableId('factor_evidence', { analysisId: input.analysis.analysisId, beatId: row.beat.beatId, description: row.description }),
      level: 'source_observation',
      sourceRef: `${input.analysis.analysisId}:${row.beat.startSeconds}-${row.beat.endSeconds}`,
      description: `参考视频在 ${row.beat.startSeconds}-${row.beat.endSeconds}s 可观察到：${row.description}`,
      confidence: clamp01(row.beat.observation.confidence ?? input.analysis.coverage?.overallConfidence ?? 0.7),
      supports: ['presence', 'policy'],
      capturedAtSeconds: row.beat.startSeconds,
    };
    const extraEvidence = (input.additionalEvidence ?? [])
      .filter(item => row.description.includes(item.matchText) || item.matchText.includes(row.description))
      .map(item => item.evidence);
    const evidenceRefs = [sourceEvidence, ...extraEvidence];
    const evidenceLevels = new Set(evidenceRefs.map(item => item.level));
    const causalStatus = evidenceLevels.has('owned_account_experiment') ? 'experimental_support' as const
      : evidenceLevels.has('timepoint_behavior') || evidenceLevels.has('repeated_format') ? 'repeated_association' as const
        : evidenceLevels.has('account_relative_performance') ? 'observed_correlation' as const
          : 'creative_hypothesis' as const;
    const causalConfidence = causalStatus === 'experimental_support' ? 0.85
      : causalStatus === 'repeated_association' ? 0.65
        : causalStatus === 'observed_correlation' ? 0.45 : 0.25;
    const validator = validatorForCategory(row.category, effectivePolicy);
    const toleranceMaximum = row.metric === 'rhythm.duration_seconds'
      ? Math.max(0.15, Number(row.value) * 0.12) : null;
    return {
      factorId: stableId('replication_factor', { analysisId: input.analysis.analysisId, beatId: row.beat.beatId, category: row.category, description: row.description, index }),
      version: input.version,
      beatId: row.beat.beatId,
      referenceShotId: row.beat.referenceShotId,
      category: row.category,
      description: row.description,
      causalRole: causalRoleForPurpose(row.beat.purpose),
      causalStatus,
      policy: effectivePolicy,
      target: { metric: row.metric, value: row.value, unit: row.unit ?? null, regionRef: null, stateKey: row.category === 'object_state' ? row.metric : null },
      tolerance: {
        metric: row.metric,
        minimum: null,
        maximum: toleranceMaximum,
        allowedValues: typeof row.value === 'string' ? [row.value] : Array.isArray(row.value) ? row.value : [],
        maximumDeviation: toleranceMaximum,
        unit: row.unit ?? null,
        humanReviewWhen: row.beat.observation.needsHumanReview ? ['参考分析存在因果缺口或低置信状态'] : [],
      },
      importance: row.importance,
      observationConfidence: sourceEvidence.confidence,
      causalConfidence,
      evidenceRefs,
      validator: {
        validatorId: stableId('factor_validator', { category: row.category, policy: effectivePolicy, metric: row.metric }),
        kind: validator.kind,
        detector: validator.detector,
        blocking: row.importance === 'critical' || effectivePolicy === 'replace_identity' || effectivePolicy === 'prohibit_reuse',
        threshold: effectivePolicy === 'equivalent' || effectivePolicy === 'bounded' ? 0.75 : null,
        evidenceOutput: [...validator.evidenceOutput],
        fallbackToHuman: true,
      },
      status: frozenAt ? 'frozen' : 'draft',
      frozenAt,
      decisionOwner: 'director_agent',
    };
  });
}

export interface SocialSceneClusterInput {
  label: string;
  productTask?: string;
  demandDimension: SocialSceneCluster['demandDimension'];
  queryVariants?: string[];
  evidence?: SocialKeywordEvidenceSource[];
  status?: SocialSceneCluster['status'];
}

/** Builds a Director-owned discovery plan only from traceable business inputs. */
export function buildSocialCrawlStrategy(input: {
  businessGoal: string;
  productTerms?: string[];
  sceneClusters?: SocialSceneClusterInput[];
  evidenceQueries?: SocialContentSearchUnit[];
  taskOverrides?: string[];
  competitorTerms?: string[];
  platforms: string[];
  benchmarkAccounts?: Array<{ accountRef: string; type: SocialBenchmarkAccountType; weight?: number }>;
  market?: string | null;
  language?: string | null;
  companyRole?: SocialCompanyRole;
  audienceRole?: SocialAudienceRole;
  lookbackDays?: number;
  resultLimit?: number;
  budgetLimitCny?: number | null;
  productionGap?: string | null;
  scopeMode?: SocialCollectionScopeMode;
  industryFocus?: string | null;
  marketFocus?: string | null;
  now?: Date;
}): SocialCrawlStrategy {
  const productTerms = unique(input.productTerms ?? []);
  const market = input.market?.trim() || '';
  const language = input.language?.trim() || '';
  const companyRole = input.companyRole ?? 'brand';
  const audienceRole = input.audienceRole ?? 'consumer';
  const competitors = unique(input.competitorTerms ?? []);
  const platforms = unique(input.platforms.map(normalizedPlatform));
  if (!platforms.includes('tiktok')) platforms.unshift('tiktok');
  const createdAt = (input.now ?? new Date()).toISOString();
  const scopeIdentity = { productTerms, market, language, companyRole, audienceRole, competitors };
  const keywordSetId = stableId('market_keyword_set', scopeIdentity);
  const discoverySeeds = productTerms.slice(0, 5).map((label, index) => ({
    seedId: stableId('seed', { keywordSetId, label, index }),
    label,
    queryVariants: [label],
    evidence: ['product'] as SocialKeywordEvidenceSource[],
    enabled: true,
  }));
  const sceneClusters = (input.sceneClusters ?? []).map((scene, index) => ({
    sceneId: stableId('scene', { keywordSetId, label: scene.label, index }),
    label: scene.label.trim(),
    productTask: scene.productTask?.trim() || productTerms[0] || '',
    demandDimension: scene.demandDimension,
    queryVariants: unique(scene.queryVariants?.length ? scene.queryVariants : [scene.label]),
    evidence: unique(scene.evidence ?? ['user']) as SocialKeywordEvidenceSource[],
    status: scene.status ?? 'suggested',
  })).filter(scene => scene.label && scene.queryVariants.length);
  const evidenceQueries = (input.evidenceQueries ?? []).map(query => ({
    ...query,
    queryVariants: unique(query.queryVariants),
    evidence: unique(query.evidence) as SocialKeywordEvidenceSource[],
  })).filter(query => query.productEntity && query.buyerQuestion && query.observableEvidence && query.queryVariants.length);
  const keyword = (category: SocialCrawlKeywordCategory, values: string[]) => ({ category, values: unique(values) });
  const keywordSet = {
    keywordSetId,
    version: 1,
    name: [productTerms[0], market, audienceRole].filter(Boolean).join(' · ') || '待确认发现范围',
    scope: {
      productRef: productTerms[0] || '',
      market,
      language,
      companyRole,
      audienceRole,
      verifiedCompetitors: competitors.map(value => ({ type: 'brand' as const, value })),
    },
    graph: { discoverySeeds, sceneClusters, evidenceQueries, edges: [] },
    status: productTerms.length && market && language ? 'active' as const : 'draft' as const,
    createdBy: 'director_agent' as const,
    createdAt,
  };
  const crawlStrategyId = stableId('crawl_strategy', { keywordSetId, businessGoal: input.businessGoal, platforms });
  const discoveryBrief = {
    discoveryBriefId: stableId('discovery_brief', { crawlStrategyId, createdAt }),
    keywordSetId,
    keywordSetVersion: keywordSet.version,
    productRef: keywordSet.scope.productRef,
    market,
    audience: audienceRole,
    discoverySeedIds: discoverySeeds.map(item => item.seedId),
    trackedSceneIds: sceneClusters.filter(item => item.status === 'approved' || item.status === 'watching').map(item => item.sceneId),
    competitorAccounts: (input.benchmarkAccounts ?? []).map(item => item.accountRef),
    discoveryModes: ['momentum', 'account', 'innovation'] as SocialDiscoveryMode[],
    platforms,
    lookbackDays: Math.max(1, Math.min(30, Math.floor(input.lookbackDays ?? 7))),
    resultLimit: Math.max(1, Math.min(50, Math.floor(input.resultLimit ?? 30))),
    budgetLimitCny: Number.isFinite(input.budgetLimitCny) ? Math.max(0, Number(input.budgetLimitCny)) : null,
    productionGap: input.productionGap?.trim() || null,
    createdBy: 'director_agent' as const,
  };
  const platformQuotas = normalizeSocialPlatformQuotas(platforms, discoveryBrief.resultLimit);
  return {
    crawlStrategyId,
    version: createdAt,
    businessGoal: input.businessGoal,
    keywordSet,
    discoveryBrief,
    keywords: [
      keyword('discovery_seed', discoverySeeds.flatMap(item => item.queryVariants)),
      keyword('scene_cluster', sceneClusters.flatMap(item => item.queryVariants)),
      keyword('evidence_query', evidenceQueries.flatMap(item => item.queryVariants)),
      keyword('competitor_account', competitors),
      keyword('task_override', input.taskOverrides ?? []),
    ],
    benchmarkAccounts: (input.benchmarkAccounts ?? []).map(account => ({ ...account, weight: clamp01(account.weight ?? 0.7) })),
    platformQuotas,
    collectionPolicy: {
      scopeMode: input.scopeMode ?? (market ? 'market_focus' : 'industry_matrix'),
      industryFocus: input.industryFocus?.trim() || productTerms[0] || null,
      marketFocus: input.marketFocus?.trim() || market || null,
      keywordTierWeights: { broad: 0.15, medium: 0.75, evidence: 0.1 },
      platformWeights: Object.fromEntries(platformQuotas.map(item => [item.platform, item.weight])),
      primaryPlatform: 'tiktok',
      youtubePolicy: 'targeted_only',
    },
    refreshIntervalMinutes: 24 * 60,
    stopConditions: ['连续三轮没有新增有效内容时暂停当前查询分支', '来源连续失败三次时熔断并等待复核', '达到单次结果、预算或超时上限时停止'],
    market: market || null,
    language: language || null,
    cultureTags: [],
    seasonTags: [],
    regionalPlatformWeights: {},
    createdBy: 'director_agent',
  };
}

/** Source reliability and content opportunity stay separate for legacy cards. */
export function scoreSocialInspirationCandidate(input: {
  platformWeight?: number;
  accountWeight?: number;
  accountTypeWeight?: number;
  industryRelevance?: number;
  strategyMatch?: number;
  currentPerformance?: number | null;
  accountPlatformBaseline?: number | null;
  engagementQuality?: number;
  freshness?: number;
  weeklyGoalRelevance?: number;
  structuralTransferability?: number;
  evidenceQuality?: number;
}): SocialInspirationScores {
  const baseline = Number(input.accountPlatformBaseline);
  const current = Number(input.currentPerformance);
  const relativePerformance = Number.isFinite(current) && current >= 0 && Number.isFinite(baseline) && baseline > 0 ? current / baseline : null;
  const relativeSignal = relativePerformance === null ? 0 : Math.min(1, relativePerformance / 5);
  const sourcePriority = Math.round(100 * (
    clamp01(input.platformWeight) * 0.25
    + clamp01(input.accountWeight) * 0.2
    + clamp01(input.accountTypeWeight) * 0.15
    + clamp01(input.industryRelevance) * 0.25
    + clamp01(input.strategyMatch) * 0.15
  ));
  const contentOpportunityScore = Math.round(100 * (
    relativeSignal * 0.32
    + clamp01(input.engagementQuality) * 0.18
    + clamp01(input.freshness) * 0.12
    + clamp01(input.weeklyGoalRelevance) * 0.16
    + clamp01(input.structuralTransferability) * 0.14
    + clamp01(input.evidenceQuality) * 0.08
  ));
  const reasons = [
    ...(relativePerformance === null ? ['账号同平台基线不足，只能标记高表现候选，不能声称正在起量'] : [`相对账号同平台基线 ${relativePerformance.toFixed(1)} 倍`]),
    ...(clamp01(input.weeklyGoalRelevance) >= 0.7 ? ['与本周经营目标高度相关'] : []),
    ...(clamp01(input.structuralTransferability) >= 0.7 ? ['结构具有较强可迁移性'] : []),
    ...(clamp01(input.evidenceQuality) < 0.4 ? ['证据质量偏低，不能直接进入事实型表达'] : []),
  ];
  return { sourcePriority, contentOpportunityScore, relativePerformance, reasons };
}

export function evaluateSocialCandidateEvidence(input: {
  inspirationId: string;
  discoveryPath: SocialCandidateEvidence['discoveryPath'];
  sceneIds?: string[];
  taskRelevance?: number;
  currentPerformance?: number | null;
  accountPlatformBaseline?: number | null;
  hasTimeSeries?: boolean;
  transferability?: number;
  mechanisms?: string[];
  limitations?: string[];
  evidenceRefs?: string[];
  novelty?: number | null;
}): SocialCandidateEvidence {
  const relevanceScore = clamp01(input.taskRelevance);
  const transferScore = clamp01(input.transferability);
  const current = Number(input.currentPerformance);
  const baseline = Number(input.accountPlatformBaseline);
  const relative = Number.isFinite(current) && current >= 0 && Number.isFinite(baseline) && baseline > 0 ? current / baseline : null;
  const momentumLevel = input.hasTimeSeries && relative !== null && relative >= 1.5
    ? 'rising' as const
    : relative !== null && relative >= 1.5
      ? 'high_performance' as const
      : 'unknown' as const;
  const level = (score: number): 'high' | 'medium' | 'low' => score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';
  return {
    inspirationId: input.inspirationId,
    discoveryPath: unique(input.discoveryPath) as SocialCandidateEvidence['discoveryPath'],
    sceneIds: unique(input.sceneIds ?? []),
    relevance: { level: level(relevanceScore), reasons: relevanceScore >= 0.7 ? ['与当前产品、市场和沟通对象高度相关'] : ['需要结合当前任务进一步确认'] },
    momentum: {
      level: momentumLevel,
      reasons: relative === null ? ['缺少可用账号基线'] : [`相对账号基线 ${relative.toFixed(1)} 倍${input.hasTimeSeries ? '，且有时间序列证据' : '，但没有连续增长证据'}`],
      confidence: relative === null ? 0.25 : input.hasTimeSeries ? 0.85 : 0.55,
    },
    ...(Number.isFinite(input.novelty) ? { novelty: { level: level(clamp01(input.novelty)), reasons: ['与当前场景库相比存在可解释的新内容'], confidence: clamp01(input.novelty) } } : {}),
    transferability: { level: level(transferScore), mechanisms: unique(input.mechanisms ?? []), limitations: unique(input.limitations ?? []) },
    evidenceRefs: unique(input.evidenceRefs ?? []),
  };
}

export function inspirationReadinessForAnalysis(input: {
  hasMetadata: boolean;
  hasQuickAnalysis: boolean;
  hasStrategyAnalysis: boolean;
  hasExactTimeline: boolean;
  rightsClear: boolean;
}): SocialInspirationReadiness {
  if (input.hasExactTimeline && input.rightsClear) return 'production_reference';
  if (input.hasStrategyAnalysis) return 'strategy_reference';
  return 'discovery_reference';
}

export function buildSocialInspirationHandoff(input: Omit<SocialInspirationHandoff, 'readiness'> & {
  analysisState: Parameters<typeof inspirationReadinessForAnalysis>[0];
}): SocialInspirationHandoff {
  const { analysisState, ...handoff } = input;
  return { ...handoff, readiness: inspirationReadinessForAnalysis(analysisState) };
}
