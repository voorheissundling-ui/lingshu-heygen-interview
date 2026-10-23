import type { DigitalHumanReferenceCue } from './digitalHumanPlan.js';

export interface PersonShotCluster {
  id: string;
  fingerprint: string;
  cueIds: string[];
  representativeCueId: string;
}

export interface PersonShotClusterPlan {
  state: 'ready' | 'needs_decision';
  clusters: PersonShotCluster[];
  personCueIds: string[];
  nonPersonCueIds: string[];
  blockers: string[];
  mergeSuggestions: Array<{ fromClusterId: string; intoClusterId: string; reason: string }>;
}

const normalized = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stableHash = (value: string) => { let hash = 2166136261; for (let index=0;index<value.length;index+=1) { hash^=value.charCodeAt(index); hash=Math.imul(hash,16777619); } return (hash>>>0).toString(16).padStart(8,'0'); };
export function compositionFingerprint(cue: DigitalHumanReferenceCue): string {
  if (cue.personShot === false) return '';
  const explicit = normalized(cue.compositionClusterId);
  const referenceShotId = normalized(cue.referenceShotId || cue.composition?.referenceShotId);
  const sourceComposition = normalized(cue.composition?.sourceComposition);
  const value = explicit ? { explicit, ...(referenceShotId ? { referenceShotId } : {}) } : cue.composition ? {
    ...(referenceShotId ? { referenceShotId } : {}),
    presenterKey: normalized(cue.composition.presenterKey), shotSize: normalized(cue.composition.shotSize), cameraAngle: normalized(cue.composition.cameraAngle),
    background: normalized(cue.composition.background), actionIntent: normalized(cue.composition.actionIntent), ...(sourceComposition ? { sourceComposition } : {}),
  } : null;
  if (!value || Object.values(value).some(item => !item)) return '';
  return JSON.stringify(value);
}

export function planPersonShotClusters(cues: DigitalHumanReferenceCue[], maxClusters = 3): PersonShotClusterPlan {
  const blockers: string[] = []; const groups = new Map<string, DigitalHumanReferenceCue[]>(); const personCueIds: string[] = []; const nonPersonCueIds: string[] = [];
  if (!Number.isSafeInteger(maxClusters) || maxClusters < 1) throw new Error('人物首帧构图上限无效');
  for (const cue of cues) {
    if (cue.personShot === undefined) { blockers.push(`句 ${cue.id} 尚未确认是否为人物镜头`); continue; }
    if (!cue.personShot) { nonPersonCueIds.push(cue.id); if (!String(cue.nonPersonMaterialId || '').trim()) blockers.push(`非人物镜头 ${cue.id} 尚未选择替换素材`); continue; }
    personCueIds.push(cue.id); const fingerprint = compositionFingerprint(cue);
    if (!fingerprint) { blockers.push(`人物镜头 ${cue.id} 缺少完整构图信息或构图簇`); continue; }
    groups.set(fingerprint, [...(groups.get(fingerprint) || []), cue]);
  }
  const clusters = [...groups.entries()].map(([fingerprint, items], index) => ({ id:`person-cluster-${index + 1}-${stableHash(fingerprint)}`, fingerprint, cueIds:items.map(item=>item.id), representativeCueId:items[0]!.id }));
  const mergeSuggestions = clusters.length > maxClusters ? clusters.slice(maxClusters).map((cluster, index) => ({ fromClusterId:cluster.id, intoClusterId:clusters[index % maxClusters]!.id, reason:'超过首帧上限；请确认两个构图是否可共用机位、景别与背景' })) : [];
  if (clusters.length > maxClusters) blockers.push(`人物镜头形成 ${clusters.length} 个构图簇，超过上限 ${maxClusters}；请人工合并或调整构图簇`);
  return { state:blockers.length ? 'needs_decision':'ready', clusters, personCueIds, nonPersonCueIds, blockers, mergeSuggestions };
}

export function clusterSourceFirstFrameMaterialId(cluster: PersonShotCluster, cues: DigitalHumanReferenceCue[]): string {
  const representative=cues.find(cue=>cue.id===cluster.representativeCueId);
  const materialId=String(representative?.sourceFirstFrame?.materialId||'').trim();
  if(!materialId)throw new Error(`构图簇 ${cluster.id} 缺少代表镜头源首帧素材`);
  return materialId;
}
