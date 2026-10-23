/**
 * Shared visual vocabulary used by reference analysis, the Director Agent and
 * material indexing.  Free-text descriptions are retained beside normalized
 * kinds so new visual situations do not require weakening the contract.
 */

export const SOCIAL_PRODUCT_POLICIES = ['locked', 'preferred', 'open'] as const;
export type SocialProductPolicy = typeof SOCIAL_PRODUCT_POLICIES[number];

export const SOCIAL_PRODUCT_POLICY_SOURCES = ['user_explicit', 'agent_inferred', 'inventory_open'] as const;
export type SocialProductPolicySource = typeof SOCIAL_PRODUCT_POLICY_SOURCES[number];

export const SOCIAL_VISUAL_SUBJECT_KINDS = [
  'person', 'product', 'factory', 'customer_case', 'environment', 'prop', 'screen_text', 'other',
] as const;
export type SocialVisualSubjectKind = typeof SOCIAL_VISUAL_SUBJECT_KINDS[number];

export const SOCIAL_INTERACTION_KINDS = [
  'none',
  'person_talking',
  'person_holding_product',
  'person_using_product',
  'apply_product_to_face',
  'person_factory_interaction',
  'product_only_display',
  'product_motion',
  'factory_process',
  'other',
] as const;
export type SocialInteractionKind = typeof SOCIAL_INTERACTION_KINDS[number];

export const SOCIAL_ENVIRONMENT_KINDS = [
  'factory', 'laboratory', 'warehouse', 'studio', 'bathroom', 'home', 'office', 'retail', 'outdoor', 'other', 'unknown',
] as const;
export type SocialEnvironmentKind = typeof SOCIAL_ENVIRONMENT_KINDS[number];

export const SOCIAL_PRODUCT_USAGE_KINDS = [
  'none', 'display', 'hold', 'open_close', 'dispense', 'apply_to_face', 'apply_to_hand', 'result_display', 'other',
] as const;
export type SocialProductUsageKind = typeof SOCIAL_PRODUCT_USAGE_KINDS[number];

/** Asset role is deliberately independent from a shot's narrative function. */
export const SOCIAL_MATERIAL_ROLES = [
  'factory', 'customer_case', 'product', 'person_usage', 'presenter', 'environment', 'general',
] as const;
export type SocialMaterialRole = typeof SOCIAL_MATERIAL_ROLES[number];

export interface SocialSceneVisualSubject {
  subjectId: string;
  kind: SocialVisualSubjectKind;
  description: string;
  identityRef: string | null;
  confidence: number | null;
}

export interface SocialSceneVisualContract {
  schemaVersion: 'social-scene-visual-contract.v1';
  subjects: SocialSceneVisualSubject[];
  interaction: {
    kind: SocialInteractionKind;
    description: string;
    actorSubjectId: string | null;
    objectSubjectId: string | null;
    contactArea: string | null;
  };
  environment: {
    kind: SocialEnvironmentKind;
    description: string;
    details: string[];
  };
  productUsage: {
    kind: SocialProductUsageKind;
    description: string;
    productId: string | null;
    productRef: string | null;
  };
  product: {
    policy: SocialProductPolicy;
    requestedProductId: string | null;
    requestedProductRef: string | null;
    source: SocialProductPolicySource;
  };
  action: {
    startState: string;
    path: string;
    peakState: string;
    endState: string;
    startSeconds: number | null;
    peakSeconds: number | null;
    endSeconds: number | null;
  };
  camera: {
    shotSize: string;
    angle: string;
    movement: string;
    composition: string;
  };
  precision: 'hook_high' | 'standard';
  evidence: {
    sourceRange: { startSeconds: number; endSeconds: number } | null;
    keyframeIds: string[];
    confidence: number | null;
  };
}

export type SocialSceneCapabilityRoute = 'digital_human' | 'product_aigc' | 'material_edit' | 'shooting_plan';

export interface SocialSceneCapabilitySignature {
  contractVersion: SocialSceneVisualContract['schemaVersion'];
  requiresPerson: boolean;
  requiresProductIdentity: boolean;
  requiresPersonProductContact: boolean;
  requiresEnvironmentInteraction: boolean;
  interaction: SocialInteractionKind;
  productUsage: SocialProductUsageKind;
  requiredCapabilities: string[];
}

export interface SocialSceneProductionAdmission {
  status: 'admitted' | 'fallback_only' | 'rejected';
  route: SocialSceneCapabilityRoute | null;
  executable: boolean;
  confidence: number;
  requiredCapabilities: string[];
  unsupportedRequirements: string[];
  fallbackRoutes: SocialSceneCapabilityRoute[];
}

export interface SocialProductCompatibility {
  compatible: boolean;
  score: number;
  reason: 'exact_product' | 'generic_material' | 'different_product' | 'policy_open' | 'product_not_required';
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown, maximum = 240): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function list(value: unknown, maximum = 24): string[] {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(source.map(item => text(item, 120)).filter(Boolean))].slice(0, maximum);
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function confidence(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.max(0, Math.min(1, parsed));
}

function normalizedRef(value: unknown): string {
  return text(value).normalize('NFKC').toLocaleLowerCase();
}

export function inferSocialVisualSubjectKind(value: unknown): SocialVisualSubjectKind {
  const source = text(value).toLocaleLowerCase();
  if (/字幕|文字|标题|screen.?text|caption|subtitle/.test(source)) return 'screen_text';
  if (/客户案例|合作案例|customer.?case/.test(source)) return 'customer_case';
  if (/工厂|车间|产线|生产线|设备|factory|workshop|production.?line/.test(source)) return 'factory';
  if (/人物|真人|员工|工人|模特|主播|脸|手|person|people|human|worker|presenter|model|face|hand/.test(source)) return 'person';
  if (/产品|商品|包装|瓶|罐|盒|膏体|液体|product|package|bottle|jar|box|cream|serum/.test(source)) return 'product';
  if (/环境|场景|背景|浴室|居家|办公室|户外|environment|scene|background|bathroom|home|office|outdoor/.test(source)) return 'environment';
  if (/道具|工具|桌|椅|prop|tool/.test(source)) return 'prop';
  return 'other';
}

export function inferSocialInteractionKind(value: unknown): SocialInteractionKind {
  const source = text(value).toLocaleLowerCase();
  if (!source || /^(?:none|无|没有交互)$/.test(source)) return 'none';
  if (/上脸|涂.*脸|脸.*涂|apply.*(?:face|skin)|facial.*application/.test(source)) return 'apply_product_to_face';
  if (/(?:人物|人|员工|工人|person|worker).*(?:工厂|车间|产线|设备|factory|machine)|(?:操作|使用).*(?:机器|设备|产线)/.test(source)) return 'person_factory_interaction';
  if (/拿|手持|握|举|hold|holding|pick.?up/.test(source) && /产品|瓶|罐|盒|product|bottle|jar|package/.test(source)) return 'person_holding_product';
  if (/使用|涂抹|挤压|开盖|操作|use|using|apply|dispense|open/.test(source) && /产品|瓶|罐|膏|液|product|bottle|cream|serum/.test(source)) return 'person_using_product';
  if (/口播|说话|讲话|对镜|talk|speak|presenter/.test(source)) return 'person_talking';
  if (/工厂|车间|产线|灌装|旋盖|质检|factory|production|filling|capping|inspection/.test(source)) return 'factory_process';
  if (/旋转|移动|推进|落下|飞入|product.?motion|rotate|orbit/.test(source) && /产品|商品|包装|product|package/.test(source)) return 'product_motion';
  if (/产品|商品|包装|瓶|罐|盒|product|package|bottle|jar/.test(source)) return 'product_only_display';
  return 'other';
}

export function inferSocialEnvironmentKind(value: unknown): SocialEnvironmentKind {
  const source = text(value).toLocaleLowerCase();
  if (!source) return 'unknown';
  if (/工厂|车间|产线|factory|workshop|production/.test(source)) return 'factory';
  if (/实验室|化验|laborator|\blab\b/.test(source)) return 'laboratory';
  if (/仓库|仓储|warehouse/.test(source)) return 'warehouse';
  if (/影棚|摄影棚|棚拍|studio/.test(source)) return 'studio';
  if (/浴室|洗手台|bathroom|vanity/.test(source)) return 'bathroom';
  if (/居家|卧室|客厅|厨房|home|bedroom|living.?room|kitchen/.test(source)) return 'home';
  if (/办公室|会议室|office/.test(source)) return 'office';
  if (/门店|商店|货架|retail|store/.test(source)) return 'retail';
  if (/户外|街道|公园|outdoor|street|park/.test(source)) return 'outdoor';
  return 'other';
}

export function inferSocialProductUsageKind(value: unknown): SocialProductUsageKind {
  const source = text(value).toLocaleLowerCase();
  if (!source || /^(?:none|无|未使用)$/.test(source)) return 'none';
  if (/上脸|涂.*脸|apply.*(?:face|skin)/.test(source)) return 'apply_to_face';
  if (/涂.*手|手背|掌心|apply.*hand/.test(source)) return 'apply_to_hand';
  if (/挤|按压|泵出|滴出|dispense|pump|squeeze|dropper/.test(source)) return 'dispense';
  if (/开盖|关盖|打开|关闭|open|close/.test(source)) return 'open_close';
  if (/拿|手持|握|hold|holding/.test(source)) return 'hold';
  if (/效果|结果|前后对比|before.?after|result/.test(source)) return 'result_display';
  if (/展示|陈列|特写|display|showcase|close.?up/.test(source)) return 'display';
  return 'other';
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const normalized = text(value, 80);
  return allowed.includes(normalized as T[number]) ? normalized as T[number] : fallback;
}

/** Accepts both v1 contracts and legacy action/shot-language/material shapes. */
export function normalizeSceneVisualContract(value: unknown): SocialSceneVisualContract {
  const source = record(value);
  const rawSubjects = Array.isArray(source.subjects) ? source.subjects : list(source.subject ?? source.primarySubject);
  const subjects = rawSubjects.map((item, index): SocialSceneVisualSubject => {
    const row = record(item);
    const description = text(row.description ?? item) || `主体 ${index + 1}`;
    return {
      subjectId: text(row.subjectId ?? row.id, 120) || `subject-${index + 1}`,
      kind: enumValue(row.kind, SOCIAL_VISUAL_SUBJECT_KINDS, inferSocialVisualSubjectKind(description)),
      description,
      identityRef: text(row.identityRef, 200) || null,
      confidence: confidence(row.confidence),
    };
  });
  const interactionRow = record(source.interaction);
  const interactionDescription = text(interactionRow.description ?? source.interaction ?? source.subjectRelations);
  const environmentRow = record(source.environment);
  const environmentDescription = text(environmentRow.description ?? source.environment)
    || list(source.environments)[0] || '';
  const usageRow = record(source.productUsage);
  const usageDescription = text(usageRow.description ?? source.productUsage);
  const actionRow = record(source.action);
  const actionPath = text(actionRow.path ?? source.action) || list(source.actions)[0] || '';
  const cameraRow = Object.keys(record(source.camera)).length ? record(source.camera) : record(source.shotLanguage);
  const productRow = record(source.product);
  const evidenceRow = record(source.evidence);
  const rangeRow = record(evidenceRow.sourceRange);
  const policy = enumValue(productRow.policy ?? source.productPolicy, SOCIAL_PRODUCT_POLICIES, 'open');
  const requestedProductId = text(productRow.requestedProductId ?? source.productId, 240) || null;
  const requestedProductRef = text(productRow.requestedProductRef ?? source.productRef, 240) || null;
  const inferredInteraction = inferSocialInteractionKind([
    interactionDescription,
    actionPath,
    subjects.map(item => item.description).join(' '),
  ].filter(Boolean).join(' '));
  const inferredUsage = inferSocialProductUsageKind([usageDescription, actionPath, interactionDescription].filter(Boolean).join(' '));
  return {
    schemaVersion: 'social-scene-visual-contract.v1',
    subjects,
    interaction: {
      kind: enumValue(interactionRow.kind ?? source.interaction, SOCIAL_INTERACTION_KINDS, inferredInteraction),
      description: interactionDescription || actionPath,
      actorSubjectId: text(interactionRow.actorSubjectId, 120) || null,
      objectSubjectId: text(interactionRow.objectSubjectId, 120) || null,
      contactArea: text(interactionRow.contactArea, 120) || null,
    },
    environment: {
      kind: enumValue(environmentRow.kind, SOCIAL_ENVIRONMENT_KINDS, inferSocialEnvironmentKind(environmentDescription)),
      description: environmentDescription,
      details: list(environmentRow.details),
    },
    productUsage: {
      kind: enumValue(usageRow.kind ?? source.productUsage, SOCIAL_PRODUCT_USAGE_KINDS, inferredUsage),
      description: usageDescription || (inferredUsage === 'none' ? '' : actionPath),
      productId: text(usageRow.productId ?? requestedProductId, 240) || null,
      productRef: text(usageRow.productRef ?? requestedProductRef, 240) || null,
    },
    product: {
      policy,
      requestedProductId,
      requestedProductRef,
      source: enumValue(productRow.source ?? source.productPolicySource, SOCIAL_PRODUCT_POLICY_SOURCES,
        policy === 'locked' ? 'user_explicit' : policy === 'preferred' ? 'agent_inferred' : 'inventory_open'),
    },
    action: {
      startState: text(actionRow.startState),
      path: actionPath,
      peakState: text(actionRow.peakState ?? source.actionPeakState),
      endState: text(actionRow.endState),
      startSeconds: finite(actionRow.startSeconds ?? source.actionStart),
      peakSeconds: finite(actionRow.peakSeconds ?? source.actionPeak),
      endSeconds: finite(actionRow.endSeconds ?? source.actionEnd),
    },
    camera: {
      shotSize: text(cameraRow.shotSize ?? cameraRow.shot),
      angle: text(cameraRow.angle ?? cameraRow.cameraAngle),
      movement: text(cameraRow.movement ?? cameraRow.camera),
      composition: text(cameraRow.composition),
    },
    precision: source.precision === 'hook_high' ? 'hook_high' : 'standard',
    evidence: {
      sourceRange: finite(rangeRow.startSeconds) !== null && finite(rangeRow.endSeconds) !== null
        ? { startSeconds: finite(rangeRow.startSeconds)!, endSeconds: finite(rangeRow.endSeconds)! }
        : null,
      keyframeIds: list(evidenceRow.keyframeIds),
      confidence: confidence(evidenceRow.confidence ?? source.confidence),
    },
  };
}

export function inferMaterialRoles(value: SocialSceneVisualContract | unknown): SocialMaterialRole[] {
  const contract = normalizeSceneVisualContract(value);
  const subjectKinds = new Set(contract.subjects.map(item => item.kind));
  const roles: SocialMaterialRole[] = [];
  if (subjectKinds.has('factory') || contract.environment.kind === 'factory' || contract.interaction.kind === 'factory_process') roles.push('factory');
  if (subjectKinds.has('customer_case')) roles.push('customer_case');
  if (subjectKinds.has('product') || contract.productUsage.kind !== 'none'
    || ['product_only_display', 'product_motion'].includes(contract.interaction.kind)) roles.push('product');
  if (contract.productUsage.kind !== 'none' && subjectKinds.has('person')) roles.push('person_usage');
  if (subjectKinds.has('person') && contract.interaction.kind === 'person_talking') roles.push('presenter');
  if (subjectKinds.has('environment') || contract.environment.kind !== 'unknown') roles.push('environment');
  const resolvedRoles: SocialMaterialRole[] = roles.length ? roles : ['general'];
  return [...new Set(resolvedRoles)];
}

export function resolveProductCompatibility(input: {
  policy: SocialProductPolicy;
  requestedProductId?: string | null;
  requestedProductRef?: string | null;
  candidateProductId?: string | null;
  candidateProductRef?: string | null;
  candidateMaterialRoles?: SocialMaterialRole[];
  enterpriseCommon?: boolean;
}): SocialProductCompatibility {
  const requestedId = normalizedRef(input.requestedProductId);
  const requested = normalizedRef(input.requestedProductRef);
  const candidateId = normalizedRef(input.candidateProductId);
  const candidate = normalizedRef(input.candidateProductRef);
  const showsProduct = (input.candidateMaterialRoles ?? []).some(role => role === 'product' || role === 'person_usage');
  if (input.policy === 'open' || (!requestedId && !requested)) return { compatible: true, score: 1, reason: input.policy === 'open' ? 'policy_open' : 'product_not_required' };
  if (requestedId && candidateId) {
    if (requestedId === candidateId) return { compatible: true, score: 1, reason: 'exact_product' };
    if (showsProduct && !input.enterpriseCommon) return input.policy === 'locked'
      ? { compatible: false, score: 0, reason: 'different_product' }
      : { compatible: true, score: 0.45, reason: 'different_product' };
  }
  if (candidate && candidate === requested) return { compatible: true, score: 1, reason: 'exact_product' };
  if ((!candidateId && !candidate) || input.enterpriseCommon || !showsProduct) return { compatible: true, score: input.policy === 'locked' ? 0.65 : 0.8, reason: 'generic_material' };
  return input.policy === 'locked'
    ? { compatible: false, score: 0, reason: 'different_product' }
    : { compatible: true, score: 0.45, reason: 'different_product' };
}

function tokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const chunks = normalized.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
  return new Set(chunks.filter(item => item.length > 0));
}

function textSimilarity(left: string, right: string, emptyScore = 0.65): number {
  if (!left && !right) return emptyScore;
  if (!left || !right) return 0.35;
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
}

function enumSimilarity(left: string, right: string, unset: string): number {
  if (left === right) return 1;
  if (left === unset || right === unset || left === 'other' || right === 'other') return 0.55;
  return 0;
}

/** 0..1 compatibility score; verbatim voiceover recall remains a separate primary score. */
export function scoreSceneVisualCompatibility(
  expectedValue: SocialSceneVisualContract | unknown,
  candidateValue: SocialSceneVisualContract | unknown,
): number {
  const expected = normalizeSceneVisualContract(expectedValue);
  const candidate = normalizeSceneVisualContract(candidateValue);
  const expectedKinds = new Set(expected.subjects.map(item => item.kind));
  const candidateKinds = new Set(candidate.subjects.map(item => item.kind));
  const union = new Set([...expectedKinds, ...candidateKinds]);
  const subjectScore = union.size
    ? [...expectedKinds].filter(item => candidateKinds.has(item)).length / union.size
    : 0.65;
  const product = resolveProductCompatibility({
    policy: expected.product.policy,
    requestedProductId: expected.product.requestedProductId ?? expected.productUsage.productId,
    requestedProductRef: expected.product.requestedProductRef ?? expected.productUsage.productRef,
    candidateProductId: candidate.productUsage.productId ?? candidate.product.requestedProductId,
    candidateProductRef: candidate.productUsage.productRef ?? candidate.product.requestedProductRef,
    candidateMaterialRoles: inferMaterialRoles(candidate),
    enterpriseCommon: candidate.product.policy === 'open' && !candidate.product.requestedProductRef,
  });
  if (!product.compatible) return 0;
  const actionScore = Math.max(
    textSimilarity(expected.action.path, candidate.action.path),
    textSimilarity(expected.interaction.description, candidate.interaction.description),
  );
  const cameraScore = (
    textSimilarity(expected.camera.shotSize, candidate.camera.shotSize)
    + textSimilarity(expected.camera.angle, candidate.camera.angle)
    + textSimilarity(expected.camera.movement, candidate.camera.movement)
    + textSimilarity(expected.camera.composition, candidate.camera.composition)
  ) / 4;
  const weighted = subjectScore * 0.22
    + enumSimilarity(expected.interaction.kind, candidate.interaction.kind, 'none') * 0.2
    + enumSimilarity(expected.environment.kind, candidate.environment.kind, 'unknown') * 0.1
    + enumSimilarity(expected.productUsage.kind, candidate.productUsage.kind, 'none') * 0.14
    + actionScore * 0.15
    + cameraScore * 0.09
    + product.score * 0.1;
  return Number(Math.max(0, Math.min(1, weighted)).toFixed(4));
}

export function buildSceneCapabilitySignature(value: SocialSceneVisualContract | unknown): SocialSceneCapabilitySignature {
  const contract = normalizeSceneVisualContract(value);
  const kinds = new Set(contract.subjects.map(subject => subject.kind));
  const requiresPersonProductContact = ['person_holding_product', 'person_using_product', 'apply_product_to_face']
    .includes(contract.interaction.kind) || ['hold', 'open_close', 'dispense', 'apply_to_face', 'apply_to_hand']
      .includes(contract.productUsage.kind);
  const requiresEnvironmentInteraction = contract.interaction.kind === 'person_factory_interaction';
  const requiresPerson = kinds.has('person') || contract.interaction.kind.startsWith('person_')
    || contract.interaction.kind === 'apply_product_to_face' || requiresPersonProductContact
    || requiresEnvironmentInteraction;
  const requiresProductIdentity = kinds.has('product') || contract.productUsage.kind !== 'none'
    || ['person_holding_product', 'person_using_product', 'apply_product_to_face', 'product_only_display', 'product_motion']
      .includes(contract.interaction.kind);
  const requiredCapabilities = [
    ...(requiresPerson ? ['digital_human'] : []),
    ...(requiresProductIdentity ? ['product_identity_reference'] : []),
    ...(requiresPersonProductContact ? ['person_product_interaction_control'] : []),
    ...(contract.interaction.kind === 'apply_product_to_face' ? ['face_contact_control'] : []),
    ...(requiresEnvironmentInteraction ? ['environment_interaction_control'] : []),
    ...(contract.camera.movement ? ['camera_trajectory_control'] : []),
  ];
  return {
    contractVersion: contract.schemaVersion,
    requiresPerson,
    requiresProductIdentity,
    requiresPersonProductContact,
    requiresEnvironmentInteraction,
    interaction: contract.interaction.kind,
    productUsage: contract.productUsage.kind,
    requiredCapabilities: [...new Set(requiredCapabilities)],
  };
}
