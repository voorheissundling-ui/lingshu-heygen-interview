import { matchEvidenceSegment, usableEvidenceSegment } from '../../src/lib/segmentEvidence.js';
import type { MaterialSegment } from '../../src/lib/studioApi.js';
export interface EvidenceGap { shotId: string; slotId: string; index: number; code: string; message: string; canShoot: boolean }
export function auditShotEvidence(spec: any, materials: Array<{ id: string; tenantId?: string; type: string; duration: number; segments?: MaterialSegment[]; usage?: string }>, tenantId: string): EvidenceGap[] {
  const slots = Array.isArray(spec.shootingSlots) ? spec.shootingSlots : [];
  const assembly = String(spec.activeAssemblyId || '');
  const assignments = spec.storyboardAssignments || {};
  const gaps: EvidenceGap[] = [];
  if (!slots.length) return [{ shotId: '', slotId: '', index: 0, code: 'no_storyboard', message: '草稿没有可核验的分镜', canShoot: false }];
  slots.forEach((slot: any, index: number) => {
    const production = spec.shotProductions?.[`${assembly}:${slot.id}`];
    const add = (code: string, message: string) => gaps.push({ shotId: slot.id, slotId: slot.slotId, index: index + 1, code, message, canShoot: !production?.locked && !['avatar', 'ai'].includes(production?.source) });
    const id = assignments[slot.slotId];
    if (!id) { add('missing', '缺少画面：选择素材、安排拍摄或生成候选'); return; }
    const material = materials.find(item => item.id === id && item.tenantId === tenantId && item.usage !== 'reference');
    if (!material) { add('unavailable', '素材不存在、非本企业可编辑素材或仅供参考'); return; }
    const edit = spec.clipEdits?.[`${slot.slotId}:${id}`];
    if (!edit || !Number.isFinite(edit.trimStart) || !Number.isFinite(edit.trimEnd)
      || edit.trimStart < 0 || edit.trimEnd <= edit.trimStart || edit.trimEnd > material.duration) {
      add('range', '素材入点/出点缺失或超出原文件范围'); return;
    }
    const speed = edit.speed ?? 1;
    const target = edit.targetDuration ?? slot.duration;
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4 || !Number.isFinite(target) || target <= 0
      || Math.abs((edit.trimEnd - edit.trimStart) / speed - target) > 0.12) {
      add('timing', '素材选段、播放速度与镜头时长不一致，需重新选段或调整时长'); return;
    }
    if (production?.source === 'avatar' || production?.source === 'ai') {
      add('generated_review', '生成画面需核对采用版本、构图和嘴型，不作为实拍动作证据'); return;
    }
    const contained = (material.segments || []).filter(segment => usableEvidenceSegment(segment, material.duration)
      && segment.start <= edit.trimStart && segment.end >= edit.trimEnd);
    const match = matchEvidenceSegment({ ...material, segments: contained }, { detail: slot.detail, start: 0, end: edit.trimEnd - edit.trimStart });
    if (!match) add('action_unverified', '所选时间段缺少匹配的动作观察，需分析或人工核验');
  });
  return gaps;
}
