export function hasStoredValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function storedCompleteness(value: Record<string, unknown>): number {
  return Object.values(value).reduce<number>((score, item) => score + (hasStoredValue(item) ? 1 : 0), 0);
}

export function mergeStoredObjects<T extends Record<string, unknown>>(fallback: T, preferred: T): T {
  const merged = { ...fallback } as Record<string, unknown>;
  for (const [key, value] of Object.entries(preferred)) {
    if (!hasStoredValue(value) && hasStoredValue(merged[key])) continue;
    const prior = merged[key];
    if (
      value && prior
      && typeof value === 'object' && !Array.isArray(value)
      && typeof prior === 'object' && !Array.isArray(prior)
    ) {
      merged[key] = mergeStoredObjects(prior as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged as T;
}
