export interface ReferencePresenterComposition {
  referenceShotId: string;
  referenceFirstFrameUrl: string;
  background: string;
  framing: string;
  camera: string;
  composition: string;
}

const text = (value: unknown) => String(value || '').trim();

/** A presenter shot must be rebuilt from its matched reference shot. */
export function referencePresenterCompositionIssue(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!text(input.referenceShotId)) return '真人口播缺少绑定的对标分镜';
  if (!text(input.referenceFirstFrameUrl)) return '真人口播缺少对标分镜首帧';
  if (!text(input.background)) return '真人口播对标分镜缺少背景分析';
  if (!text(input.framing)) return '真人口播对标分镜缺少景别分析';
  if (!text(input.camera)) return '真人口播对标分镜缺少机位或运镜分析';
  if (!text(input.composition)) return '真人口播对标分镜缺少构图分析';
  return null;
}

export function assertReferencePresenterComposition(value: unknown): asserts value is ReferencePresenterComposition {
  const issue = referencePresenterCompositionIssue(value);
  if (issue) throw new Error(issue);
}
