import fs from 'node:fs';
import type { MaterialScriptAnalysis, MaterialScriptRole } from '../../shared/materialScriptAnalysis.js';
/** Observations are visual evidence only; names, tags and product facts are not. */
export type EvidenceAsset = {
  id: string; type: 'image' | 'video'; duration: number;
  localPath?: string; objectKey?: string; url?: string;
  visualObservations: string[]; segments?: Array<Record<string, unknown>>;
  scriptAnalysis?: MaterialScriptAnalysis;
};
export type EvidenceClip = {
  assetId: string; identity: string; start: number; end: number;
  observations: string[]; segmentId: string; confidence: number;
  editorialTerms?: string[]; role?: MaterialScriptRole;
  editWindowStart?: number; editWindowEnd?: number; actionStart?: number; actionEnd?: number;
  actionPeak?: number | null; boundaryConfidence?: number; cleanEntry?: boolean; cleanExit?: boolean;
};
export function mediaIdentity(asset: EvidenceAsset): string {
  if (asset.localPath) { try { return fs.realpathSync(asset.localPath); } catch { return asset.localPath; } }
  return asset.objectKey || asset.url || asset.id;
}
export function observationStrings(segment: Record<string, unknown>): string[] {
  return [segment.observedFacts, segment.action, segment.visual, segment.environment, segment.subject]
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim());
}
export function evidenceClips(asset: EvidenceAsset): EvidenceClip[] {
  const identity = mediaIdentity(asset);
  const indexedShot = (segmentId: string, index = 0) => asset.scriptAnalysis?.shots.find(shot => shot.segmentId === segmentId)
    || asset.scriptAnalysis?.shots[index];
  if (asset.type === 'image') {
    const observations = asset.visualObservations.filter(value => !/^企业知识库产品.+的已上传(?:视频|图片)$/.test(value));
    const indexed = indexedShot(`${asset.id}-whole`);
    return observations.length ? [{ assetId: asset.id, identity, start: 0, end: Infinity, observations, segmentId: `${asset.id}:image`, confidence: 1,
      ...(indexed ? { role: indexed.role, editorialTerms: [...indexed.matchTags.filter(tag => tag !== indexed.role), ...indexed.editorial.subjects, ...indexed.editorial.actions, ...indexed.editorial.environments, ...indexed.editorial.shotLanguage] } : {}) }] : [];
  }
  return (asset.segments || []).flatMap((segment, index) => {
    const start = Number(segment.start ?? segment.startTime), end = Number(segment.end ?? segment.endTime);
    const confidence = Number(segment.confidence ?? 0);
    const observations = observationStrings(segment);
    if (segment.needsReview === true || !Number.isFinite(confidence) || confidence < .65 || confidence > 1
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
      || !Number.isFinite(asset.duration) || end > asset.duration + .05 || !observations.length) return [];
    const segmentId = String(segment.id || `${asset.id}:${index}`);
    const indexed = indexedShot(segmentId, index);
    const trim = indexed?.editorial.trim;
    const bounded = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? Math.max(start, Math.min(end, parsed)) : fallback;
    };
    const editWindowStart = bounded(trim?.preferredStartSeconds ?? segment.cleanStart, start);
    const editWindowEnd = Math.max(editWindowStart, bounded(trim?.preferredEndSeconds ?? segment.cleanEnd, end));
    const actionStart = bounded(segment.actionStart, editWindowStart);
    const actionEnd = Math.max(actionStart, bounded(segment.actionEnd, editWindowEnd));
    const peakValue = trim?.actionPeakSeconds ?? segment.actionPeak;
    const rawPeak = typeof peakValue === 'number' ? peakValue
      : typeof peakValue === 'string' && peakValue.trim() ? Number(peakValue) : Number.NaN;
    const actionPeak = Number.isFinite(rawPeak) && rawPeak >= editWindowStart && rawPeak <= editWindowEnd ? rawPeak : null;
    const boundaryConfidence = Math.max(0, Math.min(1, Number(trim?.boundaryConfidence ?? segment.boundaryConfidence) || 0));
    return [{ assetId: asset.id, identity, start, end, observations, segmentId, confidence,
      editWindowStart, editWindowEnd, actionStart, actionEnd, actionPeak, boundaryConfidence,
      cleanEntry: indexed?.editorial.trim.cleanEntry ?? segment.cleanEntry === true,
      cleanExit: indexed?.editorial.trim.cleanExit ?? segment.cleanExit === true,
      ...(indexed ? { role: indexed.role, editorialTerms: [...indexed.matchTags.filter(tag => tag !== indexed.role), ...indexed.editorial.subjects, ...indexed.editorial.actions, ...indexed.editorial.environments, ...indexed.editorial.shotLanguage] } : {}),
    }];
  });
}
const stopWords = new Set(['产品','画面','展示','镜头','环境','特写','全景','近景','product','scene','show','with','the','and','close','shot']);
const semanticConcepts: Array<[string, RegExp]> = [
  ['open', /打开|开启|掀开|开箱|open(?:ing|ed)?|unbox/i],
  ['close', /关闭|合上|封闭|close|shut/i],
  ['package', /盒盖|盒子|包装|纸箱|瓶盖|box|package|packaging|carton|lid/i],
  ['operate', /操作|使用|按下|安装|组装|operate|use|press|install|assemble/i],
  ['fill', /灌装|注入|装瓶|fill|filling|bottl/i],
  ['factory', /工厂|车间|产线|生产线|factory|workshop|production\s*line/i],
  ['machine', /机器|设备|机械|machine|equipment|device/i],
  ['detail', /细节|纹理|接口|焊点|detail|texture|connector|solder/i],
  ['test', /测试|检测|质检|测量|test|inspect|measurement|quality\s*check/i],
  ['move', /移动|旋转|拿起|放下|推进|横移|move|rotate|pick\s*up|put\s*down|pan/i],
];

function concepts(value: string): Set<string> {
  return new Set(semanticConcepts.filter(([, pattern]) => pattern.test(value)).map(([id]) => id));
}

export function visualEvidenceScore(intent: string, observations: string[]): number {
  const lower = intent.toLowerCase().replace(/产品|画面|展示|镜头|环境|特写|全景|近景/g, ' ');
  const tokens = [...(lower.match(/[a-z][a-z0-9_-]{2,}/g) || []),
    ...[...lower.matchAll(/[\u3400-\u9fff]{2,}/g)].flatMap(m => Array.from({length: m[0].length - 1}, (_, i) => m[0].slice(i, i + 2)))];
  const unique = [...new Set(tokens)].filter(token => !stopWords.has(token));
  const observed = observations.join(' ').toLowerCase();
  const literal = unique.filter(token => observed.includes(token)).length;
  const observedConcepts = concepts(observed);
  const semantic = [...concepts(lower)].filter(concept => observedConcepts.has(concept)).length;
  return literal + semantic * 2;
}

function intendedRole(intent: string): MaterialScriptRole | null {
  if (/钩子|开场|hook/i.test(intent)) return 'hook';
  if (/演示|操作|过程|demonstration|demo/i.test(intent)) return 'demonstration';
  if (/证明|证据|质检|proof/i.test(intent)) return 'proof';
  if (/讲解|解释|卖点|explanation|value/i.test(intent)) return 'explanation';
  if (/转场|过渡|transition/i.test(intent)) return 'transition';
  if (/收尾|行动|call.to.action|cta|closing/i.test(intent)) return 'closing';
  return null;
}

type EditorialEvidence = Pick<EvidenceClip, 'observations' | 'editorialTerms' | 'role' | 'boundaryConfidence'
  | 'actionStart' | 'actionEnd' | 'cleanEntry' | 'cleanExit' | 'confidence'>;

export function editorialEvidenceScore(intent: string, clip: EditorialEvidence, requestedDuration: number, start: number, end: number): number {
  const lexical = visualEvidenceScore(intent, [...clip.observations, ...(clip.editorialTerms || [])]);
  const role = intendedRole(intent);
  const roleFit = role && clip.role === role ? 6 : 0;
  const boundary = Math.max(0, Math.min(1, Number(clip.boundaryConfidence) || 0));
  const completeAction = Number.isFinite(clip.actionStart) && Number.isFinite(clip.actionEnd)
    && start <= Number(clip.actionStart) + .05 && end >= Number(clip.actionEnd) - .05 ? 3 : 0;
  const cleanEdges = Number(Boolean(clip.cleanEntry)) + Number(Boolean(clip.cleanExit));
  const durationFit = Math.max(0, 1 - Math.abs((end - start) - requestedDuration) / Math.max(.2, requestedDuration));
  return lexical * 10 + roleFit + boundary * 4 + completeAction + cleanEdges + durationFit + clip.confidence;
}
export function evidenceIntervalSupportsIntent(
  intent: string,
  clip: EvidenceClip,
  start: number,
  duration: number,
  image = false,
): boolean {
  const safeStart = (clip.boundaryConfidence || 0) >= .6 ? clip.editWindowStart ?? clip.start : clip.start;
  const safeEnd = (clip.boundaryConfidence || 0) >= .6 ? clip.editWindowEnd ?? clip.end : clip.end;
  return Number.isFinite(start) && Number.isFinite(duration) && duration > 0
    && start >= safeStart - .001
    && (image || start + duration <= safeEnd + .05)
    && visualEvidenceScore(intent, [...clip.observations, ...(clip.editorialTerms || [])]) > 0;
}
export function overlaps(a: Pick<EvidenceClip, 'identity' | 'start' | 'end'>, b: Pick<EvidenceClip, 'identity' | 'start' | 'end'>): boolean {
  return a.identity === b.identity && a.start < b.end - .001 && a.end > b.start + .001;
}
export type EvidenceRequest = { sceneIndex: number; intent: string; duration: number; materialId?: string; trimStart?: number };
/** Bounded backtracking reserves scarce clips before a flexible scene can consume them. */
export function allocateEvidenceClips(input: {
  scenes: EvidenceRequest[]; assets: EvidenceAsset[]; excluded?: Array<Pick<EvidenceClip, 'identity' | 'start' | 'end'>>;
}): { plan: Array<EvidenceClip & { sceneIndex: number; score: number }>; gaps: string[] } {
  const pools = input.scenes.map(scene => input.assets.filter(asset => !scene.materialId || asset.id === scene.materialId).flatMap(asset =>
    evidenceClips(asset).flatMap(clip => {
      const semanticScore = visualEvidenceScore(scene.intent, [...clip.observations, ...(clip.editorialTerms || [])]);
      if (!semanticScore || !Number.isFinite(scene.duration) || scene.duration <= 0) return [];
      const safeStart = (clip.boundaryConfidence || 0) >= .6 ? clip.editWindowStart ?? clip.start : clip.start;
      const safeEnd = (clip.boundaryConfidence || 0) >= .6 ? clip.editWindowEnd ?? clip.end : clip.end;
      const centered = clip.actionPeak == null ? NaN : clip.actionPeak - scene.duration / 2;
      const suggested = [safeStart, safeEnd - scene.duration, centered]
        .filter(value => Number.isFinite(value) && value >= safeStart && value + scene.duration <= safeEnd + .001);
      const grid = Array.from({ length: Math.min(32, Math.max(0, Math.floor((safeEnd - safeStart) / scene.duration))) }, (_, i) => safeStart + i * scene.duration);
      const starts = scene.trimStart !== undefined ? [scene.trimStart] : asset.type === 'image' ? [0]
        : [...new Set([...suggested, ...grid].map(value => Number(value.toFixed(3))))];
      return starts.flatMap(start => {
        const end = asset.type === 'image' ? Infinity : start + scene.duration;
        if (!evidenceIntervalSupportsIntent(scene.intent, clip, start, scene.duration, asset.type === 'image')) return [];
        const candidate = { ...clip, start, end, score: editorialEvidenceScore(scene.intent, clip, scene.duration, start, end), sceneIndex: scene.sceneIndex };
        return input.excluded?.some(excluded => overlaps(candidate, excluded)) ? [] : [candidate];
      });
    })).sort((a,b) => b.score - a.score || a.assetId.localeCompare(b.assetId) || a.start - b.start).slice(0, 64));
  const order = input.scenes.map((_, i) => i).sort((a,b) => pools[a].length - pools[b].length || a-b);
  const selected: Array<(typeof pools)[number][number]> = [];
  let visited = 0;
  const search = (depth: number): boolean => {
    if (depth === order.length) return true;
    if (++visited > 5000) return false;
    for (const candidate of pools[order[depth]]) {
      if (selected.some(other => overlaps(candidate, other))) continue;
      selected.push(candidate);
      if (search(depth + 1)) return true;
      selected.pop();
    }
    return false;
  };
  if (search(0)) return { plan: selected.sort((a,b) => a.sceneIndex-b.sceneIndex), gaps: [] };
  const missing = input.scenes.filter((_,i) => !pools[i].length);
  return { plan: [], gaps: missing.length ? missing.map(scene => `第 ${scene.sceneIndex + 1} 镜缺少支持「${scene.intent.slice(0,120)}」且覆盖 ${scene.duration.toFixed(1)} 秒的已确认素材片段`) : ['分镜可用片段相互重复或无法同时分配；请补充相关素材或缩短对应镜头'] };
}
