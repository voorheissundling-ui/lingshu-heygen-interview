import { readMaterialLibrary } from '../lib/materialLibrary.js';
import { materialAssetV2FromRecord } from '../../shared/contracts/materialAssetV2.js';

const PRESENTER_TRUST_REASON_ZH: Record<string, string> = {
  presenter_not_authorized: '人物尚未授权，请重新完成授权确认',
  presenter_id_missing: '人物资产标识缺失，请重新绑定人物',
  heygen_avatar_id_missing: 'HeyGen 人物映射缺失，请重新绑定人物',
  heygen_voice_id_missing: 'HeyGen 音色映射缺失，请重新绑定音色',
  authorization_evidence_ref_invalid: '人物授权依据格式无效，请重新完成授权确认',
  subject_consent_ref_invalid: '人物同意凭证无效，请重新完成授权确认',
  adult_subject_confirmation_missing: '未完成人物成年人确认，请重新完成授权确认',
  rights_granted_at_invalid: '人物授权时间无效，请重新完成授权确认',
  rights_expiry_invalid: '人物授权有效期无效，请重新完成授权确认',
  rights_expired: '人物授权已过期，请重新完成授权确认',
  rights_revoked: '人物授权已撤销，请重新完成授权确认',
  provider_not_authorized: '尚未授权 HeyGen 处理，请重新完成授权确认',
  use_not_authorized: '尚未授权数字人与音色用途，请重新完成授权确认',
};

export const presenterTrustReasonsForDisplay = (reasons: readonly string[]): string[] =>
  [...new Set(reasons.map(reason => PRESENTER_TRUST_REASON_ZH[reason] || '人物授权证据需要重新确认'))];

export async function materialIdentityEvidenceForTenant(tenantId: string): Promise<Record<string, {
  productId: string;
  productIdentityLevel: 'exact' | 'category' | 'none';
}>> {
  const inventory = await readMaterialLibrary(tenantId);
  return Object.fromEntries(inventory.items.flatMap(item => {
    if (String(item.scope || 'own') === 'shared') return [];
    const productId = String(item.productId || item.product_id || '').trim();
    let metadata: ReturnType<typeof materialAssetV2FromRecord>;
    try { metadata = materialAssetV2FromRecord(item); }
    catch { return []; }
    return productId && metadata
      ? [[String(item.id), { productId, productIdentityLevel: metadata.productIdentityLevel }] as const]
      : [];
  }));
}
