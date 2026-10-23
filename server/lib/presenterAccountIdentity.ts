import type { PresenterAsset } from '../../src/lib/shotProduction.js';

type PresenterAccountIdentity = Pick<PresenterAsset,
  'socialAccountId' | 'presenterProfileId' | 'presenterProfileVersion' |
  'presenterProfileStatus' | 'commercialRightsStatus' | 'consistencyKey'>;

export function normalizePresenterAccountIdentity(item: PresenterAsset): Partial<PresenterAccountIdentity> {
  const socialAccountId = String(item.socialAccountId || '').trim().slice(0, 160);
  const presenterProfileId = String(item.presenterProfileId || '').trim().slice(0, 160);
  const presenterProfileVersion = String(item.presenterProfileVersion || '').trim().slice(0, 80);
  const hasAccountProfile = Boolean(socialAccountId || presenterProfileId || presenterProfileVersion || item.consistencyKey);
  if (!hasAccountProfile) return {};
  if (!(socialAccountId && presenterProfileId && presenterProfileVersion)) {
    throw new Error('账号数字人必须同时绑定账号、身份档案和版本');
  }

  const expectedConsistencyKey = `${socialAccountId}:${presenterProfileId}:${presenterProfileVersion}`;
  const consistencyKey = String(item.consistencyKey || expectedConsistencyKey).trim().slice(0, 420);
  if (consistencyKey !== expectedConsistencyKey) throw new Error('账号数字人一致性标识与身份版本不匹配');

  const presenterProfileStatus = item.presenterProfileStatus === 'retired' ? 'retired' as const : 'published' as const;
  const commercialRightsStatus = ['cleared', 'restricted', 'expired'].includes(item.commercialRightsStatus || '')
    ? item.commercialRightsStatus as NonNullable<PresenterAsset['commercialRightsStatus']>
    : item.rightsEvidence?.authorizationRef && item.rightsEvidence?.consentRef && !item.rightsEvidence?.revokedAt
        && item.rightsEvidence?.subjectAdultConfirmed === true
        && item.rightsEvidence?.permittedUses?.includes('digital_presenter')
      ? 'cleared' as const
      : 'restricted' as const;
  if (presenterProfileStatus === 'published' && commercialRightsStatus === 'cleared'
    && (!item.rightsEvidence?.authorizationRef || !item.rightsEvidence?.consentRef || item.rightsEvidence?.revokedAt
      || item.rightsEvidence?.subjectAdultConfirmed !== true
      || !item.rightsEvidence?.permittedUses?.includes('digital_presenter'))) {
    throw new Error('发布账号数字人前必须补齐有效的商业授权与主体同意凭证');
  }

  return { socialAccountId, presenterProfileId, presenterProfileVersion,
    presenterProfileStatus, commercialRightsStatus, consistencyKey };
}
