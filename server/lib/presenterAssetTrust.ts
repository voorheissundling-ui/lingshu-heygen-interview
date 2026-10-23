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

export interface PublicPresenterEvidence {
  ownership: 'public';
  publicCatalogRef: string;
  providerTermsRef: string;
  verifiedAt: string;
  accountId: string;
}

export interface PublicHyGenPresenterRecord {
  id?: unknown; ownership?: unknown; assetVersion?: unknown;
  avatarId?: unknown; voiceId?: unknown;
  publicCatalogRef?: unknown; providerTermsRef?: unknown; verifiedAt?: unknown; accountId?: unknown;
  toolMappings?: unknown;
}

const PUBLIC_CATALOG_REF = /^(?:https:\/\/api\.heygen\.com\/v3\/avatars\/looks\/([A-Za-z0-9_-]{8,128})|heygen-public-catalog:[a-f0-9]{64})$/;
const PROVIDER_TERMS_REF = /^(?:https:\/\/(?:www\.)?heygen\.com\/[^\s]+|document:\/\/[^\s]+|policy:\/\/[^\s]+)$/i;
const VERIFIED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PUBLIC_VERIFICATION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Public catalog entries are supplier-owned stock assets. They must not be
 * dressed up as a cloned person: no consentRef is fabricated. Instead the
 * record carries the public catalog URL/response hash, the provider terms
 * reference, a recent verification time and the provider account identity.
 * The clone path above stays unchanged and still requires authorization and
 * subject consent evidence.
 */
export function validatePublicHeyGenPresenterRecord(record: PublicHyGenPresenterRecord, now = new Date()):
  | { ok: true; presenterAssetId: string; avatarId: string; voiceId: string; assetVersion: number; evidence: PublicPresenterEvidence }
  | { ok: false; reasons: string[] } {
  const id = String(record.id || '').trim();
  const mappings = record.toolMappings && typeof record.toolMappings === 'object'
    ? record.toolMappings as { heygen?: { avatarId?: unknown; voiceId?: unknown } } : {};
  const avatarId = String(mappings.heygen?.avatarId || record.avatarId || '').trim();
  const voiceId = String(mappings.heygen?.voiceId || record.voiceId || '').trim();
  const ownership = String(record.ownership || '').trim().toLowerCase();
  const publicCatalogRef = String(record.publicCatalogRef || '').trim();
  const providerTermsRef = String(record.providerTermsRef || '').trim();
  const verifiedAtText = String(record.verifiedAt || '').trim();
  const verifiedAt = VERIFIED_AT.test(verifiedAtText) ? isoTime(verifiedAtText) : null;
  const accountId = String(record.accountId || '').trim();
  const assetVersion = record.assetVersion === undefined ? 1 : Number(record.assetVersion);
  const reasons: string[] = [];

  if (ownership !== 'public') reasons.push('public_ownership_required');
  if (!id) reasons.push('presenter_id_missing');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(avatarId)) reasons.push('heygen_avatar_id_missing');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(voiceId)) reasons.push('heygen_voice_id_missing');

  const catalog = publicCatalogRef.match(PUBLIC_CATALOG_REF);
  if (!catalog) reasons.push('public_catalog_ref_invalid');
  else if (catalog[1] && catalog[1] !== avatarId) reasons.push('public_catalog_ref_avatar_mismatch');
  if (!PROVIDER_TERMS_REF.test(providerTermsRef)) reasons.push('provider_terms_ref_invalid');
  if (!accountId || accountId.length > 160 || /\s/.test(accountId)) reasons.push('provider_account_id_invalid');
  if (verifiedAt === null || verifiedAt > now.getTime()) reasons.push('public_catalog_verified_at_invalid');
  else if (now.getTime() - verifiedAt > PUBLIC_VERIFICATION_MAX_AGE_MS) reasons.push('public_catalog_verification_stale');
  if (!Number.isSafeInteger(assetVersion) || assetVersion < 1) reasons.push('asset_version_invalid');

  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true, presenterAssetId: id, avatarId, voiceId, assetVersion,
    evidence: { ownership: 'public', publicCatalogRef, providerTermsRef, verifiedAt: verifiedAtText, accountId },
  };
}
