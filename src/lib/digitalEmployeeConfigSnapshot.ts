import type { DigitalEmployeeConfig } from './digitalEmployees';

/** Legacy snapshots remain authoritative; missing fields must not inherit new permissions. */
export function planConfigForDisplay(snapshot: DigitalEmployeeConfig | undefined, current: DigitalEmployeeConfig): DigitalEmployeeConfig {
  const source = snapshot || current;
  return {
    ...source,
    team: ['orchestrator', 'business', 'director', 'content', 'customer'],
    publishingTargets: Array.isArray(source.publishingTargets) ? source.publishingTargets : [],
    enabledWorkflows: Array.isArray(source.enabledWorkflows) ? source.enabledWorkflows : [],
    constraints: Array.isArray(source.constraints) ? source.constraints : [],
    allowRealPublishing: source.allowRealPublishing === true,
    allowRealCustomerMessages: source.allowRealCustomerMessages === true,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Short deterministic audit display ID, not a security hash or database version. */
export function digitalEmployeeConfigFingerprint(config?: DigitalEmployeeConfig | null): string {
  if (!config) return '';
  const source = canonicalJson(config);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `CFG-${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6).toUpperCase()}`;
}
