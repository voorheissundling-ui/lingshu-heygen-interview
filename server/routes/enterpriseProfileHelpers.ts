export interface EnterpriseFactVerification {
  verified: boolean;
  mode: 'exact' | 'legacy_json_omitted_focus_products' | 'mismatch';
  persistedHash: string;
  confirmedHash: string;
  omittedPaths: string[];
}

export function verifyEnterpriseFactContentWithHash<T extends {
  factVersion?: { contentHash?: string };
  strategy?: Record<string, unknown>;
}>(profile: T, contentHash: (value: T) => string): EnterpriseFactVerification {
  const persistedHash = contentHash(profile), confirmedHash = profile.factVersion?.contentHash || '';
  if (confirmedHash && persistedHash === confirmedHash) return { verified: true, mode: 'exact', persistedHash, confirmedHash, omittedPaths: [] };
  if (confirmedHash && profile.strategy && !Object.hasOwn(profile.strategy, 'focusProducts')) {
    const replay = { ...profile, strategy: { ...profile.strategy, focusProducts: undefined } };
    if (contentHash(replay) === confirmedHash) return { verified: true, mode: 'legacy_json_omitted_focus_products',
      persistedHash, confirmedHash, omittedPaths: ['strategy.focusProducts'] };
  }
  return { verified: false, mode: 'mismatch', persistedHash, confirmedHash, omittedPaths: [] };
}

export function mergeEnterpriseProfilePatch(base: unknown, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const baseRecord = base && typeof base === 'object' && !Array.isArray(base) ? base as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(incoming as Record<string, unknown>).map(([key, value]) => [key,
    value && typeof value === 'object' && !Array.isArray(value) ? mergeEnterpriseProfilePatch(baseRecord[key], value) : value,
  ]).concat(Object.entries(baseRecord).filter(([key]) => !(key in (incoming as Record<string, unknown>)))));
}

export function profileWithSavedGovernance<T extends { dataGovernance?: Record<string, unknown> }>(
  profile: T,
  source: string | undefined,
): T {
  return { ...profile, dataGovernance: { ...profile.dataGovernance, aiAccessEnabled: true,
    lastSavedAt: new Date().toISOString(), lastSavedSource: source } };
}
