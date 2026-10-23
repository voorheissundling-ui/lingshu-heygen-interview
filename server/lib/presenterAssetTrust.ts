export type PresenterProvider = 'heygen' | 'volcengine_ark' | 'dashscope';
export type PresenterUse = 'digital_presenter' | 'voice_synthesis' | 'person_replacement' | 'quality_inspection';

export interface PresenterRightsEvidence {
  authorizationRef: string;
  consentRef: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  subjectAdultConfirmed: boolean;
  permittedProviders: PresenterProvider[];
  permittedUses: PresenterUse[];
  providerScopes?: Array<{ provider: PresenterProvider; uses: PresenterUse[] }>;
}

export interface TrustedPresenterRecord {
  id?: unknown;
  authorized?: unknown;
  assetVersion?: unknown;
  referenceMaterialIds?: unknown;
  avatarId?: unknown;
  voiceId?: unknown;
  authorizationRef?: unknown;
  consentRef?: unknown;
  rightsEvidence?: unknown;
  toolMappings?: unknown;
}

const EVIDENCE_REF = /^(?:https:\/\/|pb:\/\/|document:\/\/|consent:\/\/|rights:\/\/)[^\s]+$/i;
const PROVIDERS = new Set<PresenterProvider>(['heygen', 'volcengine_ark', 'dashscope']);
const USES = new Set<PresenterUse>(['digital_presenter', 'voice_synthesis', 'person_replacement', 'quality_inspection']);

const nonEmptyStrings = <T extends string>(value: unknown, allowed: Set<T>): T[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values = [...new Set(value.map(item => String(item).trim() as T))];
  return values.every(item => allowed.has(item)) ? values : null;
};

const isoTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/**
 * Verifies the machine-readable consent envelope used before a real person's
 * image or cloned voice can be sent to a supplier. References identify retained
 * evidence; they are deliberately not treated as consent on their own.
 */
export function validatePresenterRightsEvidence(
  input: unknown,
  requirement: { provider: PresenterProvider; uses: PresenterUse[] },
  now = new Date(),
): { ok: true; evidence: PresenterRightsEvidence } | { ok: false; reasons: string[] } {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const reasons: string[] = [];
  const authorizationRef = String(value.authorizationRef || '').trim();
  const consentRef = String(value.consentRef || '').trim();
  if (!EVIDENCE_REF.test(authorizationRef)) reasons.push('authorization_evidence_ref_invalid');
  if (!EVIDENCE_REF.test(consentRef)) reasons.push('subject_consent_ref_invalid');
  if (value.subjectAdultConfirmed !== true) reasons.push('adult_subject_confirmation_missing');
  const grantedAt = isoTime(value.grantedAt);
  if (grantedAt === null || grantedAt > now.getTime()) reasons.push('rights_granted_at_invalid');
  const expiresAt = value.expiresAt === undefined || value.expiresAt === '' ? undefined : isoTime(value.expiresAt);
  if (value.expiresAt && expiresAt === null) reasons.push('rights_expiry_invalid');
  if (expiresAt !== undefined && expiresAt !== null && expiresAt <= now.getTime()) reasons.push('rights_expired');
  if (value.revokedAt) reasons.push('rights_revoked');
  const permittedProviders = nonEmptyStrings(value.permittedProviders, PROVIDERS);
  const permittedUses = nonEmptyStrings(value.permittedUses, USES);
  const rawScopes = Array.isArray(value.providerScopes) ? value.providerScopes : [];
  const providerScopes = rawScopes.flatMap(item => { if (!item || typeof item !== 'object') return []; const entry=item as Record<string,unknown>; const provider=String(entry.provider||'') as PresenterProvider; const uses=nonEmptyStrings(entry.uses,USES); return PROVIDERS.has(provider)&&uses?[{provider,uses}]:[]; });
  const scoped = providerScopes.find(item=>item.provider===requirement.provider);
  // New suppliers must use an exact provider→purpose grant. Legacy HeyGen and
  // Ark records retain their historic pair of flat allowlists during migration.
  const exactRequired = requirement.provider === 'dashscope';
  if (exactRequired ? !scoped : (!scoped && (!permittedProviders || !permittedProviders.includes(requirement.provider)))) reasons.push('provider_not_authorized');
  const allowedUses = scoped?.uses || (!exactRequired ? permittedUses : null);
  if (!allowedUses || requirement.uses.some(use => !allowedUses.includes(use))) reasons.push('use_not_authorized');
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, evidence: {
    authorizationRef, consentRef, grantedAt: String(value.grantedAt),
    ...(value.expiresAt ? { expiresAt: String(value.expiresAt) } : {}),
    subjectAdultConfirmed: true,
    permittedProviders: permittedProviders!, permittedUses: permittedUses!, ...(providerScopes.length ? { providerScopes } : {}),
  } };
}

export function validateHeyGenPresenterRecord(record: TrustedPresenterRecord, now = new Date()):
  | { ok: true; presenterAssetId: string; avatarId: string; voiceId: string; assetVersion: number; rights: PresenterRightsEvidence }
  | { ok: false; reasons: string[] } {
  const id = String(record.id || '').trim();
  const mappings = record.toolMappings && typeof record.toolMappings === 'object'
    ? record.toolMappings as { heygen?: { avatarId?: unknown; voiceId?: unknown } } : {};
  const avatarId = String(mappings.heygen?.avatarId || record.avatarId || '').trim();
  const voiceId = String(mappings.heygen?.voiceId || record.voiceId || '').trim();
  const reasons = [...(record.authorized === true ? [] : ['presenter_not_authorized']),
    ...(id ? [] : ['presenter_id_missing']), ...(avatarId || (Array.isArray(record.referenceMaterialIds) && record.referenceMaterialIds.length) ? [] : ['heygen_avatar_id_missing']),
    ...(voiceId ? [] : ['heygen_voice_id_missing'])];
  const rights = validatePresenterRightsEvidence(record.rightsEvidence, {
    provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis'],
  }, now);
  if (!rights.ok) reasons.push(...rights.reasons);
  if (reasons.length || !rights.ok) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, presenterAssetId: id, avatarId, voiceId,
    assetVersion: Math.max(1, Number(record.assetVersion) || 1), rights: rights.evidence };
}
