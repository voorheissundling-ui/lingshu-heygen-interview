import type { ReferenceSemanticPlanning } from './socialContentSemanticConsolidation.js';
import type { SocialTaskSource, SocialContentThemeId, SocialReferenceReuseBinding } from '../../shared/contracts/socialContentWorkflow.js';
export type { SocialReferenceReuseBinding } from '../../shared/contracts/socialContentWorkflow.js';
import type { VerifiedSocialScriptContext } from './socialContentScriptBaseline.js';
import { buildSocialTaskReferencePackage, type ResolvedSocialTaskReference } from './socialContentScriptSources.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';

function fail(reason: string): never {
  throw new SocialContentWorkflowError(`social_reference_reuse_gap:${reason}`, 409);
}

/** Derive a pin from a customer's selected cache record on the server. Client
 * hashes are neither inputs nor authority; the exact active source must match. */
export async function buildSocialReferenceReuseBinding(input: {
  tenantId: string;
  recordId: string;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
  source: Pick<SocialTaskSource, 'sourceId' | 'sourceRef' | 'sourceVersion' | 'createdAt'>;
}, ports: { readRecord(id: string): Promise<Record<string, unknown> | null> }): Promise<SocialReferenceReuseBinding> {
  if (!socialText(input.recordId)) fail('invalid_selection');
  const record = await ports.readRecord(input.recordId);
  if (!record || record.id !== input.recordId) fail('cache_missing');
  if (socialText(record.tenantId ?? record.tenant_id) !== input.tenantId) fail('tenant_mismatch');
  const analysis = socialObject(socialJson(record.aiAnalysis));
  const binding: SocialReferenceReuseBinding = { recordId: input.recordId,
    contentSha256: socialText(analysis?.contentSha256), analysisId: socialText(analysis?.analysisRunId),
    analysisHash: socialRequestHash(analysis) };
  // Validate the very same snapshot, avoiding a read-to-read race. Execution
  // will re-read and compare this pin against current authoritative data.
  await resolveSocialReferenceReuseOnly({ ...input, referenceSources: [input.source], binding },
    { readRecord: async () => record });
  return binding;
}

/** Pins the complete persisted analysis object, not a newly projected script ID. */
export async function resolveSocialReferenceReuseOnly(input: {
  tenantId: string;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
  referenceSources: Array<Pick<SocialTaskSource, 'sourceId' | 'sourceRef' | 'sourceVersion' | 'createdAt'>>;
  binding: SocialReferenceReuseBinding;
  planning?: ReferenceSemanticPlanning;
}, ports: { readRecord(id: string): Promise<Record<string, unknown> | null> }): Promise<ResolvedSocialTaskReference> {
  const pin = input.binding;
  if (!pin || !socialText(pin.recordId) || !socialText(pin.analysisId)
    || !/^[a-f0-9]{64}$/.test(pin.contentSha256) || !/^[a-f0-9]{64}$/.test(pin.analysisHash)) fail('invalid_binding');
  if (input.referenceSources.length !== 1) fail('exact_active_source_required');
  const record = await ports.readRecord(pin.recordId);
  if (!record || record.id !== pin.recordId) fail('cache_missing');
  if (socialText(record.tenantId ?? record.tenant_id) !== input.tenantId) fail('tenant_mismatch');
  const analysis = socialObject(socialJson(record.aiAnalysis));
  if (!analysis || socialText(analysis.contentSha256) !== pin.contentSha256
    || (record.contentSha256 && record.contentSha256 !== pin.contentSha256)) fail('source_hash_changed');
  // The trend record also carries mutable queue/retry/preview bookkeeping.
  // Those fields may change after a task has pinned the same immutable media
  // and analysis run, and must not invalidate production. A real re-analysis
  // receives a new analysisRunId; changed source bytes are checked above.
  // Keep analysisHash in the binding as audit evidence and for compatibility
  // with existing records, but do not use whole-record metadata drift as a
  // production gate.
  if (socialText(analysis.analysisRunId) !== pin.analysisId) fail('analysis_changed');
  const resolved = buildSocialTaskReferencePackage({ record, source: input.referenceSources[0]!,
    themeId: input.themeId, verifiedContext: input.verifiedContext, planning: input.planning });
  if (!resolved) fail('exact_analysis_or_source_match_missing');
  return resolved;
}
