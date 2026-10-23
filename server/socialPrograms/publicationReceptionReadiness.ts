import { createHash } from 'node:crypto';
import type { CustomerMessagingAuthorization } from '../digitalEmployees/customerMessagingPolicy.js';

export interface ReceptionBinding {
  tenantId: string;
  programId: string;
  packageId: string;
  packageVersion: number;
  publicationId: string;
  cta: string;
  enterpriseFactHash: string;
  targets: Array<{
    id: string;
    required: boolean;
    ownerId: string;
    destination: { kind: 'messaging'; channel: 'whatsapp' | 'messenger' | 'instagram'; receptionMode: 'human' | 'draft' | 'automatic' } | { kind: 'url'; url: string };
    /** Exact document URL as saved in the confirmed enterprise profile. */
    requiredDocumentUrls: string[];
  }>;
}

export interface ReceptionCheckPorts {
  facts(tenantId: string): Promise<{ contentHash: string; revision: number; documentUrls: string[] }>;
  ownerExists(tenantId: string, ownerId: string): Promise<boolean>;
  messaging(tenantId: string, channel: 'whatsapp' | 'messenger' | 'instagram'): Promise<CustomerMessagingAuthorization>;
  /** Production implementation must prohibit SSRF, including DNS rebinding and redirects. */
  probePublicUrl?(url: string): Promise<{ accessible: boolean; checkedUrl: string; evidenceId: string; observation?: { checkedAt: string; visits: Array<{ url: string; address: string; status: number }>; bytes: number } }>;
}

/** No CTA inference, no success from configuration alone, and no external sending. */
export async function checkPublicationReception(binding: ReceptionBinding, ports: ReceptionCheckPorts, now = new Date()) {
  if (!binding.tenantId || !binding.programId || !binding.packageId || !Number.isSafeInteger(binding.packageVersion) || binding.packageVersion <= 0 || !binding.publicationId || !binding.cta.trim()
    || !binding.enterpriseFactHash || !Number.isFinite(now.getTime())) throw new Error('reception_binding_invalid');
  const bindingHash = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const facts = await ports.facts(binding.tenantId);
  const results: Array<{ targetId: string; required: boolean; passed: boolean; reasons: string[]; evidence: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const target of binding.targets) {
    const reasons: string[] = [];
    const evidence: Record<string, unknown> = {};
    if (!target.id || seen.has(target.id)) throw new Error('reception_target_identity_invalid');
    seen.add(target.id);
    if (facts.contentHash !== binding.enterpriseFactHash) reasons.push('enterprise_facts_changed');
    if (!target.ownerId || !await ports.ownerExists(binding.tenantId, target.ownerId)) reasons.push('reception_owner_missing');
    async function probe(url: string, label: string) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { reasons.push(`${label}_url_invalid`); return; }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) { reasons.push(`${label}_url_invalid`); return; }
      if (!ports.probePublicUrl) { reasons.push('public_url_probe_unavailable'); return; }
      try {
        const result = await ports.probePublicUrl(url);
        if (!result.accessible || result.checkedUrl !== url || !result.evidenceId) reasons.push(`${label}_not_accessible`);
        else evidence[url] = result.observation ? { evidenceId: result.evidenceId, observation: result.observation } : result.evidenceId;
      } catch { reasons.push(`${label}_probe_failed`); }
    }
    for (const url of target.requiredDocumentUrls) {
      if (!facts.documentUrls.includes(url)) reasons.push('required_document_not_in_confirmed_facts');
      else await probe(url, 'required_document');
    }
    if (target.destination.kind === 'url') await probe(target.destination.url, 'destination');
    else {
      const auth = await ports.messaging(binding.tenantId, target.destination.channel);
      evidence.messaging = { configVersion: auth.configVersion, channel: auth.channel, providerReady: auth.providerReady, inboundAutoSendAllowed: auth.inboundAutoSendAllowed };
      if (auth.tenantId !== binding.tenantId || auth.channel !== target.destination.channel) reasons.push('messaging_scope_mismatch');
      if (!auth.providerReady || (target.destination.receptionMode === 'automatic' && !auth.inboundAutoSendAllowed)) reasons.push('messaging_reception_not_ready');
      if (target.destination.receptionMode === 'draft' && (!auth.configActive || !auth.customerAgentEnabled)) reasons.push('messaging_draft_agent_not_ready');
      if (!['human', 'draft', 'automatic'].includes(target.destination.receptionMode)) reasons.push('messaging_reception_mode_invalid');
    }
    results.push({ targetId: target.id, required: target.required, passed: !reasons.length, reasons: [...new Set(reasons)], evidence });
  }
  return {
    tenantId: binding.tenantId, programId: binding.programId, packageId: binding.packageId, packageVersion: binding.packageVersion, publicationId: binding.publicationId,
    bindingHash, checkedAt: now.toISOString(), enterpriseFacts: { contentHash: facts.contentHash, revision: facts.revision },
    status: !binding.targets.some(target => target.required) || results.some(result => result.required && !result.passed) ? 'blocked' as const : 'passed' as const,
    reasons: binding.targets.some(target => target.required) ? [] : ['required_reception_target_missing'], results,
  };
}
