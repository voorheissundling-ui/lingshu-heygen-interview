export function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

export function safeError(error: unknown): { code: string; message: string; retryable: boolean } {
  const record = error && typeof error === 'object' ? error as Record<string, any> : {};
  const response = jsonObject(record.response);
  const responseData = jsonObject(response.data);
  const providerError = jsonObject(responseData.error);
  const status = Number(response.status || 0);
  const code = String(providerError.code || record.code || (error instanceof Error ? error.message : 'whatsapp_send_failed')).slice(0, 120);
  const message = String(providerError.message || (error instanceof Error ? error.message : 'WhatsApp send failed'))
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 1000);
  const retryable = status === 429; // Only explicit provider throttling proves the request was rejected.
  return { code, message, retryable };
}

export function timestamp(value: unknown): number {
  const numeric = Number(value || 0);
  if (numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function latestInboundAt(customer: Record<string, unknown>): number {
  const timeline = Array.isArray(customer.timeline) ? customer.timeline as Array<Record<string, unknown>> : [];
  return timeline.filter(item => item.actor === 'buyer' || item.type === 'msg_in')
    .reduce((latest, item) => Math.max(latest, timestamp(item.timestamp)), timestamp(customer.lastInboundAt));
}

export function customerRiskReason(customer: Record<string, unknown>): string {
  const bant = jsonObject(customer.bant);
  const authenticity = jsonObject(bant.authenticity);
  const qualification = String(bant.qualification_band || bant.band || '').toLowerCase();
  const authenticityBand = String(authenticity.band || bant.authenticity_band || '').toLowerCase();
  const markers = [...stringList(customer.tags), String(customer.blockedAutoReplyReason || '')].map(item => item.toLowerCase());
  if (String(customer.handlingMode || '') === 'human_needed') return 'human_handling_in_progress';
  if (qualification === 'black') return 'customer_qualification_black';
  if (['suspected_scraping', 'suspicious_scraping'].includes(authenticityBand)) return 'customer_suspected_scraping';
  if (markers.some(item => /unsubscribe|opt[ -]?out|do not contact|blacklist|退订|拒收|黑名单|勿扰/.test(item))) return 'customer_opted_out_or_blacklisted';
  return '';
}
