import axios from 'axios';
import { decryptSecret, getTenantPlatformApp } from '../lib/tenantPlatformApps.js';

export interface ApprovedFollowupTemplate {
  id: string; name: string; language: string; status: string; body: string; variableCount: number;
}

/** Only body-text templates can be represented by the current sender. Do not offer media/button parameter templates. */
export function supportedFollowupTemplate(raw: Record<string, unknown>): ApprovedFollowupTemplate | null {
  if (raw.status !== 'APPROVED' || !raw.id || !raw.name || !raw.language) return null;
  const components = Array.isArray(raw.components) ? raw.components as Array<Record<string, unknown>> : [];
  if (components.some(c => !['BODY', 'FOOTER'].includes(String(c.type)))) return null;
  const body = String(components.find(c => c.type === 'BODY')?.text || '');
  if (!body) return null;
  const placeholders = [...body.matchAll(/\{\{\s*(.*?)\s*\}\}/g)].map(m => m[1]);
  if (placeholders.some(p => !/^[1-9]\d*$/.test(p))) return null;
  const unique = [...new Set(placeholders.map(Number))].sort((a,b) => a-b);
  if (unique.some((n, i) => n !== i + 1)) return null;
  return { id: String(raw.id), name: String(raw.name), language: String(raw.language), status: 'APPROVED', body, variableCount: unique.length };
}

// Meta's official collection documents GET /{WABA-ID}/message_templates and status APPROVED:
// https://www.postman.com/meta/whatsapp-business-platform/request/7whkjje/get-template-by-name-default-fields
export async function listTenantFollowupTemplates(tenantId: string): Promise<ApprovedFollowupTemplate[]> {
  const app = await getTenantPlatformApp(tenantId, 'meta');
  const token = decryptSecret(app?.access_token);
  if (!app?.waba_id || !token) throw new Error('tenant_whatsapp_templates_not_configured');
  const version = process.env.META_GRAPH_VERSION?.trim() || 'v25.0';
  const items: ApprovedFollowupTemplate[] = [];
  let after = '';
  const seen = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    let data: { data?: Array<Record<string, unknown>>; paging?: { next?: string; cursors?: { after?: string } } };
    try {
      const response = await axios.get(`https://graph.facebook.com/${version}/${encodeURIComponent(app.waba_id)}/message_templates`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
        params: { fields: 'id,name,language,status,components', limit: 100, ...(after ? { after } : {}) },
      });
      data = response.data;
    } catch { throw new Error('whatsapp_template_catalog_unavailable'); }
    items.push(...(data.data || []).map(supportedFollowupTemplate).filter((t): t is ApprovedFollowupTemplate => Boolean(t)));
    if (!data.paging?.next) return items;
    after = String(data.paging.cursors?.after || '');
    if (!after || seen.has(after)) throw new Error('whatsapp_template_catalog_incomplete');
    seen.add(after);
  }
  throw new Error('whatsapp_template_catalog_incomplete');
}

export async function resolveTenantFollowupTemplate(tenantId: string, name: string, language: string): Promise<ApprovedFollowupTemplate | null> {
  return (await listTenantFollowupTemplates(tenantId)).find(t => t.name === name && t.language === language) || null;
}
