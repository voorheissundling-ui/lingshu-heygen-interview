import { readTenantEnterpriseFacts } from '../routes/enterprise.js';

const FACT_HASH = /^[a-f0-9]{64}$/i;
const PUBLISH_PLATFORMS = new Set(['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin']);

export type PublishingCopyAudit = {
  enterpriseFactVersion: string;
  enterpriseFactsHash: string;
  sourceHash: string;
  outputHash: string;
  checkedAt: string;
  projectId?: string | null;
  targetPlatforms: string[];
};

type EnterpriseFactsLoader = (tenantId: string) => Promise<{ version: { id: string } }>;

export class PublishingCopyFactVersionError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: 'publishing_copy_audit_invalid' | 'enterprise_fact_version_conflict', message: string) {
    super(message);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  }
  return null;
}

export function normalizePublishingCopyAudit(value: unknown): PublishingCopyAudit | null {
  const audit = objectValue(value);
  if (!audit) return null;
  const enterpriseFactVersion = String(audit.enterpriseFactVersion || '').trim();
  const enterpriseFactsHash = String(audit.enterpriseFactsHash || '').trim();
  const sourceHash = String(audit.sourceHash || '').trim();
  const outputHash = String(audit.outputHash || '').trim();
  const checkedAt = String(audit.checkedAt || '').trim();
  const projectId = audit.projectId == null ? null : String(audit.projectId).trim() || null;
  const targetPlatforms = Array.isArray(audit.targetPlatforms)
    ? Array.from(new Set(audit.targetPlatforms.map(String).map(item => item.trim()).filter(item => PUBLISH_PLATFORMS.has(item))))
    : [];
  if (!enterpriseFactVersion || !FACT_HASH.test(enterpriseFactsHash) || !FACT_HASH.test(sourceHash)
    || !FACT_HASH.test(outputHash) || !Number.isFinite(Date.parse(checkedAt)) || !targetPlatforms.length) return null;
  return { enterpriseFactVersion, enterpriseFactsHash, sourceHash, outputHash, checkedAt, projectId, targetPlatforms };
}

export async function assertPublishingCopyFactVersion(
  tenantId: string,
  input: { enterpriseFactVersion?: unknown; copyAudit?: unknown; projectId?: unknown; contentId?: unknown; platform?: unknown },
  loadFacts: EnterpriseFactsLoader = readTenantEnterpriseFacts,
): Promise<PublishingCopyAudit | null> {
  const declaredVersion = String(input.enterpriseFactVersion || '').trim();
  const auditSupplied = input.copyAudit !== undefined && input.copyAudit !== null;
  if (!declaredVersion && !auditSupplied) return null;
  const audit = normalizePublishingCopyAudit(input.copyAudit);
  if (!declaredVersion || !audit || declaredVersion !== audit.enterpriseFactVersion) {
    throw new PublishingCopyFactVersionError('publishing_copy_audit_invalid', '发布文案的企业事实审计信息不完整，请重新生成或人工核对文案。');
  }
  const requestedProjectId = String(input.projectId || input.contentId || '').trim();
  if (audit.projectId && requestedProjectId && audit.projectId !== requestedProjectId) {
    throw new PublishingCopyFactVersionError('publishing_copy_audit_invalid', '发布文案审计与当前 Studio 项目不匹配，请为该作品重新生成文案。');
  }
  const requestedPlatform = String(input.platform || '').trim().toLowerCase();
  if (requestedPlatform && !audit.targetPlatforms.includes(requestedPlatform)) {
    throw new PublishingCopyFactVersionError('publishing_copy_audit_invalid', '发布文案审计未覆盖当前平台，请为该平台重新生成或人工核对文案。');
  }
  const current = await loadFacts(tenantId);
  if (current.version.id !== declaredVersion) {
    throw new PublishingCopyFactVersionError('enterprise_fact_version_conflict', '企业资料已更新，该发布文案的事实校验已过期，请重新生成或人工核对。');
  }
  return audit;
}
