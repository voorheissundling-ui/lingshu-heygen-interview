import { effectiveDigitalHumanRequirements, type DigitalHumanRequirements } from './digitalHumanRequirements.js';
export function digitalHumanDecisionIssues(requirements?: DigitalHumanRequirements): string[] {
  requirements = effectiveDigitalHumanRequirements(requirements);
  if (requirements?.presenterMode) {
    const issues: string[] = [];
    if (!requirements.presenterSelected) issues.push('请选择企业人物');
    if (!requirements.contentConfirmed) issues.push('请确认数字人方案');
    const photoReplication = requirements.presenterMode === 'photo_talking' && requirements.workflow === 'viral_replication';
    if (photoReplication && (requirements.method !== 'reenact' || requirements.preferredProvider !== 'sd' || requirements.replicationMode !== 'sentence_first_frame')) issues.push('爆款照片口播需要 Seedream 首帧重建路线');
    if (!photoReplication && requirements.method !== 'talking') issues.push('视频分身与自由照片口播需要 HeyGen 口播路线');
    return issues;
  }
  if (!requirements || requirements.workflow !== 'viral_replication') return [];
  const issues: string[] = [];
  if (!requirements.presenterSelected) issues.push('请选择企业人物');
  if (!requirements.replacementScope) issues.push('请选择数字人替换范围');
  if (!requirements.targetEffect) issues.push('请选择数字人生成效果');
  if (requirements.replacementScope === 'face_only') issues.push('仅换脸能力尚未接入');
  if (requirements.replacementScope === 'person_keep_scene' && requirements.method !== 'replace') issues.push('保留原场景需要人物替换路线，不能用口播或场景重建替代');
  if (requirements.replacementScope === 'person_and_scene' && requirements.method !== 'reenact') issues.push('人物及场景重建需要重演路线，不能使用口播接口替代');
  if (requirements.targetEffect === 'natural_talking' && requirements.method !== 'talking') issues.push('当前重建路线不能保证自然口播目标');
  if (requirements.targetEffect === 'reference_motion' && requirements.method === 'talking') issues.push('口播接口不能还原原片动作');
  if (requirements.targetEffect === 'flexible_scene' && requirements.method !== 'reenact') issues.push('调整场景需要重演路线');
  if (!requirements.contentConfirmed) issues.push('请确认数字人方案');
  return issues;
}

export function enterpriseMaterialIssue(input: {
  material?: { type?: string; url?: string; duration?: number; width?: number; height?: number; aspectRatio?: number; usage?: string; transcript?: string };
  duration: number; ratio?: string; sound?: string; narration?: string;
}): string | null {
  const clip = input.material;
  if (!clip?.url || clip.usage === 'reference_only') return '请选择或上传企业素材';
  if (clip.type === 'video' && (!Number.isFinite(clip.duration) || Number(clip.duration) + .05 < input.duration)) return '素材时长不足';
  if (input.sound === 'source' && input.narration?.trim() && !/^(无|none)$/i.test(input.narration.trim())) {
    const normalize = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
    if (clip.type !== 'video' || !clip.transcript?.trim()) return '已开启素材原声，请确认素材台词';
    if (!normalize(clip.transcript).includes(normalize(input.narration))) return '素材原声台词与新口播不一致';
  }
  return null;
}
