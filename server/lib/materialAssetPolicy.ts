export type MaterialAssetOwnership = 'platform' | 'tenant';
export type MaterialAssetVisibility = 'platform_shared' | 'tenant_private';
export type MaterialSourceEntry = 'enterprise_knowledge' | 'studio_workspace' | 'platform_operations' | 'ai_generation' | 'legacy';

export interface MaterialAssetPolicyInput {
  scope?: unknown;
  tenantId?: unknown;
  sourceType?: unknown;
  provenance?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

export function materialSourceEntry(input: MaterialAssetPolicyInput): MaterialSourceEntry {
  const provenance = objectValue(input.provenance);
  const explicit = String(provenance.sourceEntry || '').trim();
  if (explicit === 'enterprise_knowledge' || explicit === 'studio_workspace' || explicit === 'platform_operations' || explicit === 'ai_generation') return explicit;
  if (String(input.scope || 'own') === 'shared') return 'platform_operations';
  if (/^ai[-_]/i.test(String(input.sourceType || ''))) return 'ai_generation';
  return 'legacy';
}

export function materialAssetPolicy(input: MaterialAssetPolicyInput) {
  const shared = String(input.scope || 'own') === 'shared';
  const ownership: MaterialAssetOwnership = shared ? 'platform' : 'tenant';
  const visibility: MaterialAssetVisibility = shared ? 'platform_shared' : 'tenant_private';
  return {
    ownership,
    visibility,
    knowledgeEligible: !shared && Boolean(String(input.tenantId || '').trim()),
    sourceEntry: materialSourceEntry(input),
  } as const;
}

export function assertMaterialKnowledgeEligible(input: MaterialAssetPolicyInput): void {
  if (!materialAssetPolicy(input).knowledgeEligible) throw new Error('platform material cannot enter enterprise knowledge');
}
