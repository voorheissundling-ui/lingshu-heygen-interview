export interface StudioProjectMergeSnapshot {
  id: string;
  title: string;
  status: 'draft' | 'ready_for_approval' | 'published' | 'template';
  spec: Record<string, unknown>;
  thumbSeed?: string;
  updatedAt: string;
}

export interface StudioProjectMergeWrite {
  id?: string;
  title: string;
  status: StudioProjectMergeSnapshot['status'];
  spec: Record<string, unknown>;
  thumbSeed?: string;
}

export type StudioProjectMergeResult =
  | { ok: true; write: StudioProjectMergeWrite }
  | { ok: false; conflictPaths: string[] };

const missing = Symbol('studio-project-merge-missing');
type MergeValue = unknown | typeof missing;

function plainObject(value: MergeValue): value is Record<string, unknown> {
  if (!value || value === missing || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function equal(left: MergeValue, right: MergeValue): boolean {
  if (left === right) return true;
  if (left === missing || right === missing || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => equal(item, right[index]));
  }
  if (plainObject(left) || plainObject(right)) {
    if (!plainObject(left) || !plainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
  }
  return false;
}

function clone(value: MergeValue): MergeValue {
  if (value === missing) return missing;
  if (Array.isArray(value)) return value.map(item => clone(item) as unknown);
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function mergeValue(
  base: MergeValue,
  local: MergeValue,
  remote: MergeValue,
  path: string,
  conflicts: string[],
): MergeValue {
  if (equal(local, base)) return clone(remote);
  if (equal(remote, base) || equal(local, remote)) return clone(local);

  const objectsCanMerge = plainObject(local) && plainObject(remote) && (plainObject(base) || base === missing);
  if (!objectsCanMerge) {
    conflicts.push(path);
    return clone(remote);
  }

  const baseObject = plainObject(base) ? base : {};
  const keys = new Set([...Object.keys(baseObject), ...Object.keys(local), ...Object.keys(remote)]);
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    // The server regenerates this read-only transport marker on every read.
    if (key === '_baseUpdatedAt') continue;
    const child = mergeValue(
      Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : missing,
      Object.prototype.hasOwnProperty.call(local, key) ? local[key] : missing,
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : missing,
      `${path}.${key}`,
      conflicts,
    );
    if (child !== missing) merged[key] = child;
  }
  return merged;
}

/**
 * Three-way merge for a full Studio save. Arrays are deliberately atomic:
 * silently combining reordered timelines or shot lists is unsafe. Plain
 * object branches merge only when their leaf edits are disjoint.
 */
export function mergeStudioProjectWrite(
  base: StudioProjectMergeSnapshot,
  local: StudioProjectMergeWrite,
  remote: StudioProjectMergeSnapshot,
): StudioProjectMergeResult {
  const conflicts: string[] = [];
  const title = mergeValue(base.title, local.title, remote.title, 'title', conflicts);
  const status = mergeValue(base.status, local.status, remote.status, 'status', conflicts);
  const thumbSeed = mergeValue(
    base.thumbSeed === undefined ? missing : base.thumbSeed,
    local.thumbSeed === undefined ? missing : local.thumbSeed,
    remote.thumbSeed === undefined ? missing : remote.thumbSeed,
    'thumbSeed',
    conflicts,
  );
  const spec = mergeValue(base.spec, local.spec, remote.spec, 'spec', conflicts);

  if (conflicts.length) return { ok: false, conflictPaths: [...new Set(conflicts)] };
  return {
    ok: true,
    write: {
      ...local,
      title: String(title),
      status: status as StudioProjectMergeWrite['status'],
      spec: spec as Record<string, unknown>,
      ...(thumbSeed === missing ? {} : { thumbSeed: String(thumbSeed) }),
    },
  };
}

export function studioProjectValueChanged(left: unknown, right: unknown): boolean {
  return !equal(left, right);
}
