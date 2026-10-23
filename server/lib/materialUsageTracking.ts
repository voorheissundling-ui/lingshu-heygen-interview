import { createHash } from 'node:crypto';
import {
  EMPTY_MATERIAL_PERFORMANCE,
  MATERIAL_USAGE_MANIFEST_VERSION,
  MATERIAL_USAGE_ROLES,
  type MaterialPerformanceMetrics,
  type MaterialUsageHistoryItem,
  type MaterialUsageManifest,
  type MaterialUsageManifestItem,
  type MaterialUsageRole,
  type MaterialUsageSummary,
} from '../../shared/contracts/materialUsageTracking.js';

type RecordValue = Record<string, unknown>;

export interface StudioMaterialUsageProject {
  id: string;
  title?: string;
  spec?: unknown;
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface StudioMaterialPublishLink {
  id?: string;
  projectId?: string;
  platform?: string;
  publishedAt?: string;
  publishResult?: unknown;
  metrics?: unknown;
}

function object(value: unknown): RecordValue | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RecordValue;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RecordValue : null;
    } catch { return null; }
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function iso(value: unknown, fallback = ''): string {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => text(value)).filter(Boolean))];
}

function uniqueRoles(values: Iterable<MaterialUsageRole>): MaterialUsageRole[] {
  const allowed = new Set<string>(MATERIAL_USAGE_ROLES);
  return [...new Set(values)].filter(role => allowed.has(role));
}

function sourceRefMaterialId(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (!raw.startsWith('socialmaterial:')) return /^[A-Za-z0-9._:-]{1,240}$/.test(raw) ? raw : '';
  try {
    const decoded = Buffer.from(raw.slice('socialmaterial:'.length), 'base64url').toString('utf8').trim();
    return /^[A-Za-z0-9._:-]{1,240}$/.test(decoded) ? decoded : '';
  } catch { return ''; }
}

function slotRows(spec: RecordValue): Array<{ id: string; start: number | null; end: number | null; label: string }> {
  const analysis = object(spec.analysisResults);
  const storyboard = object(analysis?.storyboard);
  const raw = Array.isArray(storyboard?.slots) && storyboard.slots.length
    ? storyboard.slots
    : Array.isArray(spec.shootingSlots) ? spec.shootingSlots : [];
  return raw.flatMap((value, index) => {
    const row = object(value);
    if (!row) return [];
    const id = text(row.id || row.slotId || row.shotId) || `slot-${index + 1}`;
    const startValue = Number(row.start ?? row.startSeconds);
    const endValue = Number(row.end ?? row.endSeconds);
    return [{
      id,
      start: Number.isFinite(startValue) ? startValue : null,
      end: Number.isFinite(endValue) ? endValue : null,
      label: [row.title, row.detail, row.purpose, row.function, row.narrativeRole].map(text).filter(Boolean).join(' '),
    }];
  });
}

function rolesForSlot(slot: { start: number | null; end: number | null; label: string } | undefined, index: number): MaterialUsageRole[] {
  const hook = slot
    ? slot.start !== null && slot.end !== null ? slot.start < 3 && slot.end > 0 : index === 0
    : index === 0;
  const label = slot?.label || '';
  const roles: MaterialUsageRole[] = [hook ? 'three_second_hook' : 'body'];
  if (/proof|evidence|证明|证据|实证|工厂|检测/.test(label)) roles.push('proof');
  if (/\bcta\b|call.to.action|行动|咨询|联系|私信|下单/.test(label.toLowerCase())) roles.push('cta');
  return uniqueRoles(roles);
}

function manifestItemsFromStudioSpec(spec: RecordValue): MaterialUsageManifestItem[] {
  const slots = slotRows(spec);
  const slotById = new Map(slots.map(slot => [slot.id, slot]));
  const slotIndex = new Map(slots.map((slot, index) => [slot.id, index]));
  const byMaterial = new Map<string, { sceneIds: Set<string>; roles: Set<MaterialUsageRole> }>();
  const add = (rawMaterialId: unknown, sceneId: string, roles: MaterialUsageRole[]) => {
    const materialId = sourceRefMaterialId(rawMaterialId);
    if (!materialId) return;
    const current = byMaterial.get(materialId) || { sceneIds: new Set<string>(), roles: new Set<MaterialUsageRole>() };
    if (sceneId) current.sceneIds.add(sceneId);
    roles.forEach(role => current.roles.add(role));
    byMaterial.set(materialId, current);
  };

  const assignments = object(spec.storyboardAssignments) || {};
  Object.entries(assignments).forEach(([sceneId, materialId], index) => {
    const resolvedIndex = slotIndex.get(sceneId) ?? index;
    add(materialId, sceneId, rolesForSlot(slotById.get(sceneId), resolvedIndex));
  });

  const sourcePlans = object(spec.storyboardSourcePlans) || {};
  Object.entries(sourcePlans).forEach(([sceneId, rawPlan], index) => {
    const plan = object(rawPlan);
    if (!plan) return;
    const resolvedIndex = slotIndex.get(sceneId) ?? index;
    const sceneRoles = rolesForSlot(slotById.get(sceneId), resolvedIndex);
    add(plan.generatedClipId, sceneId, sceneRoles);
    add(plan.referenceClipId, sceneId, uniqueRoles([...sceneRoles, 'generation_reference']));
    add(plan.firstFrameMaterialId, sceneId, ['generation_reference']);
  });

  const socialBindings = Array.isArray(spec.socialShotMaterialBindings) ? spec.socialShotMaterialBindings : [];
  socialBindings.forEach((rawBinding, index) => {
    const binding = object(rawBinding);
    if (!binding) return;
    const sceneId = text(binding.shotId) || `shot-${finite(binding.shotIndex) + 1}`;
    const resolvedIndex = Number.isFinite(Number(binding.shotIndex)) ? Number(binding.shotIndex) : index;
    add(binding.materialId, sceneId, rolesForSlot(slotById.get(sceneId), resolvedIndex));
  });

  const hookMaterialId = text(spec.hookMaterialId) || text(object(spec.freeCreation)?.hookMaterialId);
  add(hookMaterialId, slots[0]?.id || 'hook', ['three_second_hook']);

  if (text(spec.contentMode) === 'poster') {
    const outputMaterialId = text(spec.posterImageMaterialId);
    const selected = Array.isArray(spec.selected) ? spec.selected : [];
    selected.forEach(value => {
      if (text(value) !== outputMaterialId) add(value, 'poster-reference', ['generation_reference']);
    });
  }

  return [...byMaterial.entries()].map(([materialId, value]) => ({
    materialId,
    sceneIds: unique(value.sceneIds),
    roles: uniqueRoles(value.roles),
  })).sort((a, b) => a.materialId.localeCompare(b.materialId));
}

export function buildStudioMaterialUsageManifest(input: {
  projectId: string;
  projectTitle: string;
  artifactId: string;
  usedAt: string;
  spec: unknown;
}): MaterialUsageManifest | null {
  const spec = object(input.spec);
  if (!spec || !text(input.projectId) || !text(input.artifactId)) return null;
  const items = manifestItemsFromStudioSpec(spec);
  if (!items.length) return null;
  return {
    schemaVersion: MATERIAL_USAGE_MANIFEST_VERSION,
    artifactId: text(input.artifactId),
    projectId: text(input.projectId),
    projectTitle: text(input.projectTitle) || '未命名内容',
    platform: text(spec.platform) || null,
    usedAt: iso(input.usedAt, new Date().toISOString()),
    items,
  };
}

export function buildSocialMaterialUsageManifest(input: {
  projectId: string;
  projectTitle: string;
  artifactId: string;
  usedAt: string;
  platform?: string;
  assetSupplyExecution: unknown;
  scenes?: unknown;
}): MaterialUsageManifest | null {
  const execution = object(input.assetSupplyExecution);
  const shots = Array.isArray(execution?.shots) ? execution.shots : [];
  const sceneRows = Array.isArray(input.scenes) ? input.scenes.map(object).filter((row): row is RecordValue => Boolean(row)) : [];
  const sceneById = new Map(sceneRows.map(row => [text(row.sceneId || row.id), row]));
  const byMaterial = new Map<string, { sceneIds: Set<string>; roles: Set<MaterialUsageRole> }>();
  shots.forEach((rawShot, index) => {
    const shot = object(rawShot);
    if (!shot) return;
    const materialId = sourceRefMaterialId(shot.sourceRef);
    if (!materialId) return;
    const sceneId = text(shot.sceneId || shot.shotId) || `scene-${index + 1}`;
    const scene = sceneById.get(sceneId);
    const duration = object(scene?.duration);
    const start = Number(duration?.startSeconds ?? scene?.startSeconds);
    const end = Number(duration?.endSeconds ?? scene?.endSeconds);
    const isHook = text(shot.function) === 'hook'
      || (Number.isFinite(start) && Number.isFinite(end) && start < 3 && end > 0)
      || (!Number.isFinite(start) && index === 0);
    const current = byMaterial.get(materialId) || { sceneIds: new Set<string>(), roles: new Set<MaterialUsageRole>() };
    current.sceneIds.add(sceneId);
    current.roles.add(isHook ? 'three_second_hook' : 'body');
    if (text(shot.function) === 'proof') current.roles.add('proof');
    if (text(shot.function) === 'call_to_action') current.roles.add('cta');
    byMaterial.set(materialId, current);
  });
  const items = [...byMaterial.entries()].map(([materialId, value]) => ({
    materialId,
    sceneIds: unique(value.sceneIds),
    roles: uniqueRoles(value.roles),
  }));
  if (!items.length) return null;
  return {
    schemaVersion: MATERIAL_USAGE_MANIFEST_VERSION,
    artifactId: text(input.artifactId),
    projectId: text(input.projectId),
    projectTitle: text(input.projectTitle) || '自动生产内容',
    platform: text(input.platform) || null,
    usedAt: iso(input.usedAt, new Date().toISOString()),
    items,
  };
}

export function appendMaterialUsageManifest(specValue: unknown, manifest: MaterialUsageManifest | null): RecordValue {
  const spec = object(specValue) || {};
  if (!manifest) return spec;
  const existing = Array.isArray(spec.materialUsageManifests)
    ? spec.materialUsageManifests.filter(value => object(value)) as MaterialUsageManifest[]
    : [];
  return {
    ...spec,
    materialUsageManifests: [manifest, ...existing.filter(value => value.artifactId !== manifest.artifactId)].slice(0, 50),
  };
}

function normalizedManifest(value: unknown): MaterialUsageManifest | null {
  const raw = object(value);
  if (!raw || raw.schemaVersion !== MATERIAL_USAGE_MANIFEST_VERSION) return null;
  const items = Array.isArray(raw.items) ? raw.items.flatMap(rawItem => {
    const item = object(rawItem);
    const materialId = sourceRefMaterialId(item?.materialId);
    const roles = Array.isArray(item?.roles) ? uniqueRoles(item.roles.map(text) as MaterialUsageRole[]) : [];
    if (!materialId || !roles.length) return [];
    return [{ materialId, sceneIds: unique(Array.isArray(item?.sceneIds) ? item.sceneIds.map(text) : []), roles }];
  }) : [];
  const artifactId = text(raw.artifactId);
  const projectId = text(raw.projectId);
  if (!artifactId || !projectId || !items.length) return null;
  return {
    schemaVersion: MATERIAL_USAGE_MANIFEST_VERSION,
    artifactId,
    projectId,
    projectTitle: text(raw.projectTitle) || '未命名内容',
    platform: text(raw.platform) || null,
    usedAt: iso(raw.usedAt, new Date(0).toISOString()),
    items,
  };
}

function metrics(value: unknown): MaterialPerformanceMetrics {
  const row = object(value) || {};
  const available = (['views', 'likes', 'comments', 'shares', 'leads'] as const)
    .filter(key => (typeof row[key] === 'number' || typeof row[key] === 'string' && text(row[key]))
      && Number.isFinite(Number(row[key])) && Number(row[key]) >= 0);
  const result = {
    views: finite(row.views),
    likes: finite(row.likes),
    comments: finite(row.comments),
    shares: finite(row.shares),
    leads: finite(row.leads),
    engagementRate: 0,
    available,
  };
  result.engagementRate = result.views
    ? Number((((result.likes + result.comments + result.shares) / result.views) * 100).toFixed(2))
    : 0;
  return result;
}

function sumMetrics(values: MaterialPerformanceMetrics[]): MaterialPerformanceMetrics {
  const result = values.reduce((sum, value) => ({
    views: sum.views + value.views,
    likes: sum.likes + value.likes,
    comments: sum.comments + value.comments,
    shares: sum.shares + value.shares,
    leads: sum.leads + value.leads,
    engagementRate: 0,
    available: unique([...sum.available, ...value.available]) as MaterialPerformanceMetrics['available'],
  }), { ...EMPTY_MATERIAL_PERFORMANCE });
  result.engagementRate = result.views
    ? Number((((result.likes + result.comments + result.shares) / result.views) * 100).toFixed(2))
    : 0;
  return result;
}

function projectManifests(project: StudioMaterialUsageProject, links: StudioMaterialPublishLink[]): MaterialUsageManifest[] {
  const spec = object(project.spec) || {};
  const stored = Array.isArray(spec.materialUsageManifests)
    ? spec.materialUsageManifests.map(normalizedManifest).filter((value): value is MaterialUsageManifest => Boolean(value))
    : [];
  if (stored.length) return stored;
  const hasArtifact = links.length > 0
    || object(spec.manualRenderJob)?.status === 'completed'
    || object(spec.renderAcceptance)?.accepted === true
    || Boolean(object(spec.socialProductionOutput)?.fileSha256)
    || Object.values(object(spec.languageRenderOutputs) || {}).some(value => object(value)?.status === 'done');
  if (!hasArtifact) return [];
  const latestLink = [...links].sort((a, b) => Date.parse(text(b.publishedAt)) - Date.parse(text(a.publishedAt)))[0];
  const artifactId = text(object(spec.manualRenderJob)?.id)
    || text(object(spec.socialProductionOutput)?.artifactId)
    || text(latestLink?.id)
    || createHash('sha256').update(`${project.id}:${text(project.updated_at || project.updatedAt)}`).digest('hex').slice(0, 24);
  const manifest = buildStudioMaterialUsageManifest({
    projectId: project.id,
    projectTitle: text(project.title),
    artifactId,
    usedAt: text(project.updated_at || project.updatedAt || project.created_at || project.createdAt || latestLink?.publishedAt),
    spec,
  });
  return manifest ? [manifest] : [];
}

export function materialUsageSummariesFromProjects(input: {
  projects: StudioMaterialUsageProject[];
  publishLinks: StudioMaterialPublishLink[];
  knownMaterialIds?: Iterable<string>;
}): Map<string, MaterialUsageSummary> {
  const known = input.knownMaterialIds ? new Set(unique(input.knownMaterialIds)) : null;
  const histories = new Map<string, MaterialUsageHistoryItem[]>();
  for (const project of input.projects) {
    const links = input.publishLinks.filter(link => text(link.projectId) === project.id);
    const manifests = projectManifests(project, links);
    const publishedMetrics = links.map(link => metrics(link.metrics));
    const aggregateMetrics = sumMetrics(publishedMetrics);
    const publishedAt = links.map(link => iso(link.publishedAt)).filter(Boolean).sort().at(-1) || null;
    const latestArtifactId = [...manifests].sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt))[0]?.artifactId;
    for (const manifest of manifests) {
      for (const item of manifest.items) {
        if (known && !known.has(item.materialId)) continue;
        const publicationCount = manifest.artifactId === latestArtifactId ? links.length : 0;
        const hasSyncedMetrics = publicationCount > 0 && aggregateMetrics.available.length > 0;
        const history: MaterialUsageHistoryItem = {
          usageId: createHash('sha256').update(`${manifest.projectId}:${manifest.artifactId}:${item.materialId}`).digest('hex').slice(0, 24),
          artifactId: manifest.artifactId,
          projectId: manifest.projectId,
          contentTitle: manifest.projectTitle,
          platform: manifest.platform || text(links[0]?.platform) || null,
          roles: item.roles,
          sceneIds: item.sceneIds,
          isThreeSecondHook: item.roles.includes('three_second_hook'),
          usedAt: manifest.usedAt,
          publishedAt: publicationCount ? publishedAt : null,
          publicationCount,
          metricsStatus: publicationCount ? hasSyncedMetrics ? 'synced' : 'awaiting_sync' : 'not_published',
          metrics: publicationCount ? aggregateMetrics : { ...EMPTY_MATERIAL_PERFORMANCE },
        };
        histories.set(item.materialId, [...(histories.get(item.materialId) || []), history]);
      }
    }
  }

  return new Map([...histories.entries()].map(([materialId, values]) => {
    const history = values.sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt));
    return [materialId, {
      totalUses: history.length,
      hookUses: history.filter(item => item.isThreeSecondHook).length,
      publishedUses: history.filter(item => item.publicationCount > 0).length,
      lastUsedAt: history[0]?.usedAt || null,
      metrics: sumMetrics(history.map(item => item.metrics)),
      history: history.slice(0, 50),
    } satisfies MaterialUsageSummary];
  }));
}
