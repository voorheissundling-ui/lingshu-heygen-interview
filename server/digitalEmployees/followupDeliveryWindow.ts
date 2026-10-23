/** Re-check the configured customer-local sending window after approval. */
export function nextFollowupDeliveryWindow(timeZone: string, rawPolicy: unknown, now: Date): Date {
  const policy = jsonObject(rawPolicy);
  if (policy.sendWindowStartHour === undefined || policy.sendWindowEndHour === undefined) return now;
  const start = Math.max(0, Math.min(23, Number(policy.sendWindowStartHour || 9)));
  const end = Math.max(start + 1, Math.min(24, Number(policy.sendWindowEndHour || 18)));
  const workdaysOnly = policy.workdaysOnly !== false;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23', minute: '2-digit',
  });
  let candidate = now;
  try { formatter.format(candidate); } catch { return now; }
  for (let index = 0; index < 8 * 48; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    const hour = Number(parts.hour || 0);
    const allowedDay = !workdaysOnly || !['Sat', 'Sun'].includes(parts.weekday || '');
    if (allowedDay && hour >= start && hour < end) return candidate;
    candidate = new Date(Math.ceil((candidate.getTime() + 1) / 1_800_000) * 1_800_000);
  }
  return candidate;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}
