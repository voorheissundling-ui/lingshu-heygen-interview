import type { MaterialRecord } from './materialLibrary.js';
import { seedanceImageFirstFrameInput, seedanceTrustedAssetForMaterial } from './seedanceTrustedAsset.js';
import { validatePresenterRightsEvidence, type TrustedPresenterRecord } from './presenterAssetTrust.js';
import { isTenantPrivateObjectKey } from '../storage/materialAssets.js';

export interface AcceptedSeedancePortrait {
  presenterAssetId: string;
  materialId: string;
  trustedAssetUri: string;
  authorizationRef: string;
  consentRef: string;
}

/** A tenant-owned still can be used as a Seedream identity reference without an Ark Assets ID.
 * Ark Active image certification is only needed when submitting asset:// to Seedance video generation. */
export function acceptPresenterPortraitReference(input: {
  tenantId: string;
  presenter: TrustedPresenterRecord & { referenceMaterialIds?: unknown; toolMappings?: unknown };
  material: MaterialRecord & Record<string, unknown>;
  provider: 'volcengine_ark' | 'heygen';
  uses: Array<'person_replacement' | 'digital_presenter' | 'voice_synthesis'>;
  now?: Date;
}): void {
  const reasons: string[] = [];
  if (input.presenter.authorized !== true) reasons.push('presenter_not_authorized');
  if (String(input.material.tenantId || '') !== input.tenantId || input.material.scope !== 'own') reasons.push('portrait_not_owned_by_tenant');
  if (input.material.type !== 'image') reasons.push('portrait_material_must_be_image');
  if (!isTenantPrivateObjectKey(String(input.material.objectKey || ''), input.tenantId)) reasons.push('portrait_object_storage_not_tenant_scoped');
  const references = Array.isArray(input.presenter.referenceMaterialIds) ? input.presenter.referenceMaterialIds.map(String) : [];
  if (!references.includes(String(input.material.id))) reasons.push('portrait_not_bound_to_presenter');
  const rights = validatePresenterRightsEvidence(input.presenter.rightsEvidence, { provider: input.provider, uses: input.uses }, input.now);
  if (!rights.ok) reasons.push(...rights.reasons);
  if (reasons.length) throw new Error(`presenter_asset_rejected:${[...new Set(reasons)].join(',')}`);
}

/**
 * Binds an authorized presenter, a tenant-owned image, and the provider-issued
 * asset:// identifier. The provider URI cannot be accepted independently of
 * the original material and consent envelope.
 */
export function acceptSeedancePortrait(input: {
  tenantId: string;
  presenter: TrustedPresenterRecord & { referenceMaterialIds?: unknown; toolMappings?: unknown };
  material: MaterialRecord & Record<string, unknown>;
  now?: Date;
}): AcceptedSeedancePortrait {
  const reasons: string[] = [];
  const presenterAssetId = String(input.presenter.id || '').trim();
  if (input.presenter.authorized !== true) reasons.push('presenter_not_authorized');
  if (!presenterAssetId) reasons.push('presenter_id_missing');
  if (String(input.material.tenantId || '') !== input.tenantId || input.material.scope !== 'own') reasons.push('portrait_not_owned_by_tenant');
  if (input.material.type !== 'image') reasons.push('portrait_material_must_be_image');
  if (!String(input.material.objectKey || '').trim()) reasons.push('portrait_object_storage_key_missing');
  else if (!isTenantPrivateObjectKey(String(input.material.objectKey), input.tenantId)) reasons.push('portrait_object_storage_not_tenant_scoped');
  const mappings = input.presenter.toolMappings && typeof input.presenter.toolMappings === 'object'
    ? input.presenter.toolMappings as { seedance?: { referenceMaterialIds?: unknown }; sd?: { referenceMaterialIds?: unknown }; runway?: { referenceMaterialIds?: unknown } } : {};
  // The production worker accepts the same mapping precedence as
  // PresenterAsset.  Do not validate a Runway-bound portrait here and then
  // reject it later merely because Seedance is the final video step.
  const references = [mappings.seedance?.referenceMaterialIds, mappings.sd?.referenceMaterialIds,
    mappings.runway?.referenceMaterialIds, input.presenter.referenceMaterialIds]
    .flatMap(value => Array.isArray(value) ? value.map(String) : []);
  if (!references.includes(String(input.material.id))) reasons.push('portrait_not_bound_to_presenter');
  const rights = validatePresenterRightsEvidence(input.presenter.rightsEvidence, {
    provider: 'volcengine_ark', uses: ['digital_presenter', 'person_replacement'],
  }, input.now);
  if (!rights.ok) reasons.push(...rights.reasons);
  const trusted = seedanceTrustedAssetForMaterial(input.material);
  if (!trusted) reasons.push('seedance_trusted_asset_missing_or_inactive');
  else if (trusted.kind !== 'image') reasons.push('seedance_trusted_asset_must_be_image');
  if (reasons.length || !rights.ok || !trusted) throw new Error(`presenter_asset_rejected:${[...new Set(reasons)].join(',')}`);
  const firstFrame = seedanceImageFirstFrameInput(trusted);
  return { presenterAssetId, materialId: String(input.material.id), trustedAssetUri: firstFrame.url,
    authorizationRef: rights.evidence.authorizationRef, consentRef: rights.evidence.consentRef };
}
