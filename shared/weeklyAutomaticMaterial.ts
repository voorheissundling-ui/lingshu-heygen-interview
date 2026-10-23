/** Stable semantic identity. Missing fields never imply that two shots share an asset. */
export interface WeeklyAssetRequirement {
  subjectRef: string;
  action: string;
  scene: string;
  evidenceRequirement: string;
  aspectRatio: string;
  minimumDurationSeconds: number;
  authorizationScope: string;
}
export function weeklyAssetRequirementIdentity(value: WeeklyAssetRequirement): string {
  const fields = [value.subjectRef, value.action, value.scene, value.evidenceRequirement, value.aspectRatio, value.authorizationScope];
  if (fields.some(field => typeof field !== 'string' || !field.trim())
    || !Number.isFinite(value.minimumDurationSeconds) || value.minimumDurationSeconds < 0)
    throw Error('weekly_asset_requirement_invalid');
  return JSON.stringify([...fields.map(field => field.normalize('NFKC').trim()), value.minimumDurationSeconds]);
}
export interface AutomaticMaterialEvidence {
  sha256: string;
  subjectRef: string;
  action: string;
  scene: string;
  evidenceRequirement: string;
  aspectRatio: string;
  durationSeconds: number;
  authorizationScopes: string[];
  rightsEvidenceRef: string;
  qualityPassed: boolean;
  model: string;
}
/** A server-generated, byte-bound analysis receipt; descriptions or upload completion are not quality receipts. */
export function checkWeeklyMaterialAutomatically(requirement: WeeklyAssetRequirement, sha256: string, evidence: AutomaticMaterialEvidence | null) {
  weeklyAssetRequirementIdentity(requirement);
  const valid = Boolean(evidence && evidence.sha256 === sha256 && /^[a-f0-9]{64}$/.test(sha256)
    && evidence.model?.trim() && evidence.rightsEvidenceRef?.trim() && evidence.qualityPassed === true);
  const fact = valid && evidence!.subjectRef === requirement.subjectRef && evidence!.evidenceRequirement === requirement.evidenceRequirement;
  const rights = valid && Array.isArray(evidence!.authorizationScopes) && evidence!.authorizationScopes.includes(requirement.authorizationScope);
  const visual = valid && evidence!.action === requirement.action && evidence!.scene === requirement.scene
    && evidence!.aspectRatio === requirement.aspectRatio && Number.isFinite(evidence!.durationSeconds)
    && evidence!.durationSeconds >= requirement.minimumDurationSeconds;
  return { accepted: Boolean(fact && rights && visual),
    factCheck: fact ? '自动检查：字节版本与主体及事实要求一致' : '自动检查：缺少当前字节的主体或事实证据',
    rightsCheck: rights ? `自动检查：授权覆盖 ${requirement.authorizationScope}` : '自动检查：缺少目标使用范围的授权证据',
    visualCheck: visual ? '自动检查：动作、场景、画幅、时长和质量符合要求' : '自动检查：缺少合格逐镜适配或质量证据' };
}
