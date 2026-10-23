import type { CompareExpected, DataStore } from '../storage/datastore.js';

export function studioProjectRevisionConflict(baseUpdatedAt: unknown, currentUpdatedAt: unknown): boolean {
  const base = String(baseUpdatedAt || '').trim();
  const current = String(currentUpdatedAt || '').trim();
  return !base || !current || base !== current;
}

type StoredStudioProjectRevision = {
  id: string;
  tenant_id: string;
  spec?: unknown;
  title?: unknown;
  status?: unknown;
  thumb_seed?: unknown;
  updated_at?: unknown;
  updated?: unknown;
};

function own(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * A Studio project has a client-visible revision (`updated_at`) and a storage
 * revision (`updated`). Guard both, plus the full project payload, so a
 * production receipt cannot land between an editor's read and full-spec save.
 */
export function studioProjectCompareExpected(project: StoredStudioProjectRevision): CompareExpected {
  const expected: CompareExpected = {
    tenant_id: project.tenant_id,
    spec: project.spec,
  };
  for (const key of ['title', 'status', 'thumb_seed', 'updated_at', 'updated'] as const) {
    if (own(project, key)) expected[key] = project[key];
  }
  return expected;
}

export function nextStudioProjectRevision(
  project: Pick<StoredStudioProjectRevision, 'updated_at' | 'updated'>,
  now = Date.now(),
): string {
  const current = Date.parse(String(project.updated_at || project.updated || ''));
  return new Date(Math.max(now, Number.isFinite(current) ? current + 1 : now)).toISOString();
}

/**
 * Atomically writes a Studio project and always advances its client-visible
 * revision. Callers must treat `ok: false` as a concurrent update and reload;
 * falling back to an unconditional update would reintroduce lost writes.
 */
export async function compareAndSwapStudioProject(
  store: DataStore,
  project: StoredStudioProjectRevision,
  patch: Record<string, unknown>,
  requestedRevision?: string,
): Promise<{ ok: boolean; updatedAt: string }> {
  if (!store.compareAndSwap) throw new Error('STUDIO_PROJECT_ATOMIC_STORE_REQUIRED');
  const requestedTime = requestedRevision ? Date.parse(requestedRevision) : Number.NaN;
  const updatedAt = nextStudioProjectRevision(project, Number.isFinite(requestedTime) ? requestedTime : Date.now());
  const ok = await store.compareAndSwap(
    'studio_projects',
    project.id,
    studioProjectCompareExpected(project),
    { ...patch, updated_at: updatedAt },
  );
  return { ok, updatedAt };
}
