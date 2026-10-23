/**
 * Canonical shot taxonomy shared with benchmark analysis and viral replication.
 * `consumer_demo` is the persisted value for the product-facing “D to C” label.
 */
export const FREE_CREATION_SHOT_TYPES = ['presenter', 'factory', 'product', 'consumer_demo'] as const;
export type FreeCreationShotType = typeof FREE_CREATION_SHOT_TYPES[number];
export const FREE_CREATION_HOOK_SOURCES = ['upload', 'library', 'ai', 'none'] as const;
export type FreeCreationHookSource = typeof FREE_CREATION_HOOK_SOURCES[number];

export interface FreeCreationBrief {
  productIds: string[];
  goal: string;
  audience: string;
  platform: string;
  language: string;
  sellingPoints: string;
  durationSeconds: number;
  tone: string;
  cta: string;
  prohibitedClaims: string;
  notes: string;
}

export interface FreeCreationScriptLine {
  id: string;
  start: number;
  end: number;
  narration: string;
  silent: boolean;
  visualIntent: string;
  shotType: FreeCreationShotType;
  factReferences: string[];
  primaryHook: boolean;
}

export interface FreeCreationScriptVersion {
  version: number;
  status: 'draft' | 'confirmed' | 'needs_update';
  lines: FreeCreationScriptLine[];
  createdAt: string;
  invalidatedReasons: string[];
}

export interface FreeCreationState {
  schemaVersion: 1;
  manualWorkflow: true;
  currentStep: 1 | 2 | 3;
  hookSource: FreeCreationHookSource;
  hookMaterialId: string;
  brief: FreeCreationBrief;
  script: FreeCreationScriptVersion;
}

const clean = (value: unknown, max = 2_000) => String(value ?? '').trim().slice(0, max);
const cleanList = (value: unknown, limit = 100) => Array.isArray(value)
  ? [...new Set(value.map(item => clean(item, 500)).filter(Boolean))].slice(0, limit)
  : [];

export function normalizeFreeCreationState(value: unknown): FreeCreationState {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  const brief = source.brief && typeof source.brief === 'object' ? source.brief as Record<string, unknown> : {};
  const script = source.script && typeof source.script === 'object' ? source.script as Record<string, any> : {};
  const lines = Array.isArray(script.lines) ? script.lines.slice(0, 100).map((item: unknown, index: number) => {
    const line = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const rawShotType = String(line.shotType || '').trim().toLowerCase();
    // Read compatibility for drafts created before the global four-type taxonomy.
    const compatibleShotType = ['general', 'usage', 'd2c', 'd_to_c', 'consumer', 'consumer_usage'].includes(rawShotType)
      ? 'consumer_demo' : rawShotType === 'talking_head' ? 'presenter' : rawShotType;
    const shotType = FREE_CREATION_SHOT_TYPES.includes(compatibleShotType as FreeCreationShotType)
      ? compatibleShotType as FreeCreationShotType : 'product';
    const narration = clean(line.narration, 5_000);
    return {
      id: clean(line.id, 120) || `free-shot-${index + 1}`,
      start: Math.max(0, Number(line.start) || 0),
      end: Math.max(Math.max(0, Number(line.start) || 0), Number(line.end) || 0),
      narration,
      silent: line.silent === true || !narration,
      visualIntent: clean(line.visualIntent, 2_000),
      shotType,
      factReferences: cleanList(line.factReferences, 30),
      primaryHook: line.primaryHook === true,
    };
  }) : [];
  if (lines.length && !lines.some(line => line.primaryHook)) lines[0]!.primaryHook = true;
  let hookSeen = false;
  lines.forEach(line => { if (line.primaryHook && hookSeen) line.primaryHook = false; else if (line.primaryHook) hookSeen = true; });
  const hookSource = FREE_CREATION_HOOK_SOURCES.includes(String(source.hookSource) as FreeCreationHookSource)
    ? String(source.hookSource) as FreeCreationHookSource : 'none';
  return {
    schemaVersion: 1,
    manualWorkflow: true,
    currentStep: [1, 2, 3].includes(Number(source.currentStep)) ? Number(source.currentStep) as 1 | 2 | 3 : 1,
    hookSource,
    // AI hooks are real materials after the user adopts the generated video.
    // Keep that identity so a draft can restore its preview and provenance.
    hookMaterialId: hookSource === 'none' ? '' : clean(source.hookMaterialId, 200),
    brief: {
      productIds: cleanList(brief.productIds, 30), goal: clean(brief.goal), audience: clean(brief.audience),
      platform: clean(brief.platform, 80), language: clean(brief.language, 40), sellingPoints: clean(brief.sellingPoints, 5_000),
      durationSeconds: Math.max(5, Math.min(300, Number(brief.durationSeconds) || 30)), tone: clean(brief.tone, 500),
      cta: clean(brief.cta, 1_000), prohibitedClaims: clean(brief.prohibitedClaims, 3_000), notes: clean(brief.notes, 5_000),
    },
    script: {
      version: Math.max(1, Math.floor(Number(script.version) || 1)),
      status: ['draft', 'confirmed', 'needs_update'].includes(String(script.status)) ? script.status : 'draft',
      lines, createdAt: clean(script.createdAt, 80), invalidatedReasons: cleanList(script.invalidatedReasons, 30),
    },
  };
}

export function freeCreationCompletionIssues(state: FreeCreationState): string[] {
  const issues: string[] = [];
  if (!state.brief.productIds.length) issues.push('至少选择一个主推产品');
  if (!state.brief.goal) issues.push('缺少内容目标');
  if (!state.brief.audience) issues.push('缺少目标受众');
  if (!state.brief.platform) issues.push('缺少发布平台');
  if (!state.brief.language) issues.push('缺少内容语言');
  if (!state.script.lines.length) issues.push('至少需要一个分镜');
  if (state.script.lines.some(line => !line.silent && !line.narration)) issues.push('有声分镜缺少口播');
  if (state.script.lines.some(line => line.end <= line.start)) issues.push('分镜时间段无效');
  if (state.script.lines.filter(line => line.primaryHook).length !== 1) issues.push('必须且只能设置一个首要钩子');
  if (state.script.lines.some(line => !line.factReferences.length && (line.narration || state.brief.sellingPoints))) issues.push('口播或卖点分镜缺少事实引用');
  return [...new Set(issues)];
}

export function reconcileFreeCreationState(current: FreeCreationState, previous?: FreeCreationState): FreeCreationState {
  if (!previous) return current;
  const reasons = new Set(current.script.invalidatedReasons);
  if (JSON.stringify(current.brief.productIds) !== JSON.stringify(previous.brief.productIds)) reasons.add('主推产品已变化');
  if (current.brief.goal !== previous.brief.goal || current.brief.audience !== previous.brief.audience) reasons.add('创作目标或目标受众已变化');
  if (current.brief.language !== previous.brief.language) reasons.add('内容语言已变化');
  const previousLines = JSON.stringify(previous.script.lines);
  const linesChanged = JSON.stringify(current.script.lines) !== previousLines;
  if (linesChanged && current.script.version <= previous.script.version) current.script.version = previous.script.version + 1;
  if (reasons.size || linesChanged && previous.script.status === 'confirmed') {
    if (linesChanged && previous.script.status === 'confirmed') reasons.add('已确认脚本内容已变化');
    current.script.status = 'needs_update';
    current.script.invalidatedReasons = [...reasons];
  }
  return current;
}

export function normalizeFreeCreationProjectSpec(spec: Record<string, any>, previousSpec?: Record<string, any>): Record<string, any> {
  if (spec.creationPath !== 'free_creation' && spec.freeCreation == null) return spec;
  const current = normalizeFreeCreationState(spec.freeCreation);
  const previous = previousSpec?.freeCreation ? normalizeFreeCreationState(previousSpec.freeCreation) : undefined;
  return { ...spec, creationPath: 'free_creation', manualWorkflow: true, freeCreation: reconcileFreeCreationState(current, previous) };
}
