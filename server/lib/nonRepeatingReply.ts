export type TimelineLike = { actor?: unknown; type?: unknown; body?: unknown };

export function canonicalReply(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function recentSellerTexts(timeline: TimelineLike[], limit = 6): string[] {
  return timeline
    .filter(item => {
      const actor = String(item.actor || '').toLowerCase();
      return actor === 'seller' || actor === 'ai' || String(item.type || '').includes('msg_out');
    })
    .slice(-limit)
    .map(item => canonicalReply(String(item.body || '')))
    .filter(Boolean);
}

export function chooseNonRepeatedIndex(options: string[], timeline: TimelineLike[]): number {
  if (!options.length) return 0;
  const recent = recentSellerTexts(timeline);
  const index = options.findIndex(option => {
    const candidate = canonicalReply(option);
    return !recent.some(previous => previous === candidate || previous.startsWith(candidate.slice(0, 80)) || candidate.startsWith(previous.slice(0, 80)));
  });
  if (index >= 0) return index;
  const latest = recent.at(-1) || '';
  const nonConsecutive = options.findIndex(option => {
    const candidate = canonicalReply(option);
    return candidate !== latest
      && !latest.startsWith(candidate.slice(0, 80))
      && !candidate.startsWith(latest.slice(0, 80));
  });
  return nonConsecutive >= 0 ? nonConsecutive : options.length - 1;
}
