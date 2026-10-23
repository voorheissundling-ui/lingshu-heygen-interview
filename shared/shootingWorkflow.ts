/** Shared, side-effect-free shot identity and refill policy. */
export interface ShootingSlot {
  id: string;
  slotId: string;
  detail: string;
  requirements: string;
  duration: number;
  observedPresenterRole?: import('./contracts/presenterShotRecognition.js').ObservedPresenterRole;
  personContinuityId?: string;
  salesPresenterConfirmed?: boolean;
  needsReview?: boolean;
}

/** Rebuild the editable storyboard timeline from durable production shots.
 * Viral replication can have many visual cuts under one spoken sentence, so
 * reparsing narration blocks must not collapse those cuts during rendering. */
export function storyboardTimelineFromShootingSlots(previous: ShootingSlot[]): Array<{
  id: string; time: string; start: number; end: number; title: string; detail: string;
}> {
  let cursor = 0;
  return previous.map((shot, index) => {
    const duration = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 0.5;
    const start = cursor;
    const end = start + duration;
    cursor = end;
    const detail = String(shot.detail || '').trim();
    const compact = detail.replace(/\s+/g, ' ');
    const title = compact.match(/(?:景别|Shot)\s*[：:]\s*([^；;。]+)/i)?.[1]
      || compact.match(/(?:画面|Visual)\s*[：:]\s*([^；;。]+)/i)?.[1]
      || compact.split(/[；;。]/)[0]
      || `分镜 ${index + 1}`;
    return { id: shot.slotId, time: `${start.toFixed(2)}s-${end.toFixed(2)}s`, start, end,
      title: title.trim().slice(0, 24), detail: detail || `分镜 ${index + 1}` };
  });
}

export interface ScriptGapTask {
  id: string;
  origin: 'script_gap';
  title: string;
  productLabel: string;
  themeTitle: string;
  shotBrief: string;
  suggestedDurationSec: number;
  ratio?: string;
  sourceProjectId?: string;
  sourceStoryboardSlotId?: string;
  sourceAssemblyId?: string;
  sourceShotId?: string;
  requirements?: string;
  /** Initial refill accepts silent footage; recorded dialogue needs transcription/alignment. */
  soundMode?: 'voiceover' | 'source' | 'silent';
  expectedNarration?: string;
  createdAt: string;
  uploadedMaterialIds: string[];
}

export function reconcileShootingSlots(
  previous: ShootingSlot[],
  slots: Array<{ id: string; detail: string; start: number; end: number }>,
  context: string | ((slotId: string) => string),
  newId: () => string,
): ShootingSlot[] {
  const sameOrder = previous.length === slots.length && previous.every((item, i) => item.detail === slots[i].detail);
  return slots.map((slot, i) => {
    // Unique unchanged content survives reorder. Ambiguous repeated shots fail closed after edits.
    const matches = previous.filter(item => item.detail === slot.detail);
    const unique = slots.filter(item => item.detail === slot.detail).length === 1;
    const old = sameOrder ? previous[i] : unique && matches.length === 1 ? matches[0] : undefined;
    const duration = Math.round(Math.max(0.5, slot.end - slot.start) * 100) / 100;
    return {
      id: old?.id || newId(), slotId: slot.id, detail: slot.detail, duration,
      requirements: JSON.stringify({ detail: slot.detail, duration, context: typeof context === 'function' ? context(slot.id) : context }),
    };
  });
}

export function transcriptMatches(actual: string | undefined, expected: string | undefined): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
  return Boolean(actual?.trim() && expected?.trim() && normalize(actual) === normalize(expected));
}

export function shootingRefillTarget(
  task: ScriptGapTask,
  context: { projectId: string; assemblyId: string; slots: ShootingSlot[]; assignments: Record<string, string>; confirmed: Record<string, boolean> },
): { slot?: ShootingSlot; reason: string } {
  if (task.sourceProjectId !== context.projectId || task.sourceAssemblyId !== context.assemblyId) return { reason: '不属于当前草稿版本' };
  if (!task.sourceShotId || !task.requirements) return { reason: '旧任务缺少稳定分镜绑定，请手动选用' };
  const slot = context.slots.find(item => item.id === task.sourceShotId);
  if (!slot) return { reason: '原分镜已删除或内容已变化，素材保留为候选' };
  if (slot.requirements !== task.requirements) return { reason: '拍摄要求已变化，请人工确认候选' };
  if (context.assignments[slot.slotId] || context.confirmed[slot.slotId]) return { reason: '当前镜头已有画面或已确认，不自动覆盖' };
  if (!task.uploadedMaterialIds.length) return { reason: '等待上传' };
  return { slot, reason: '' };
}

export type ShootingSoundMode = 'voiceover' | 'source' | 'silent';
export function shootingSoundLabel(mode?: ShootingSoundMode): string {
  return mode === 'source' ? '保留原声' : mode === 'silent' ? '无声画面' : '可后期配音';
}
export function shootingSoundInstructions(mode?: ShootingSoundMode): string {
  return mode === 'source' ? '录制完整口播，保留现场原声；上传后转写核对台词'
    : mode === 'silent' ? '此镜头无声：仅使用拍摄画面，不混入口播或配乐'
    : '保留草稿旁白，补拍视频作为无声画面使用';
}
/** Display-only information. Mobile does not have the current draft, so it must never infer refill eligibility. */
export function shootingTaskPresentation(task: { uploadedMaterialIds?: unknown; suggestedDurationSec?: number; soundMode?: ShootingSoundMode; sourceProjectId?: string; sourceAssemblyId?: string; sourceShotId?: string; requirements?: string }) {
  const duration = task.suggestedDurationSec;
  const uploadedCount = Array.isArray(task.uploadedMaterialIds) ? task.uploadedMaterialIds.filter(id => typeof id === 'string' && id.trim()).length : 0;
  const hasStableBinding = Boolean(task.sourceProjectId && task.sourceAssemblyId && task.sourceShotId && task.requirements);
  return {
    done: uploadedCount > 0, uploadedCount,
    durationText: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration + ' 秒' : '不限',
    soundText: shootingSoundLabel(task.soundMode), soundInstructions: shootingSoundInstructions(task.soundMode),
    bindingText: hasStableBinding ? '已绑定原草稿分镜；返回网页草稿后核对要求，已有画面不覆盖' : '上传后作为任务素材保留；需在网页草稿中手动选用',
  };
}
