import type { PlannedProductionScene, SocialProductionAsset, SocialProductionPlan } from './socialContentProductionPlan.js';

export function buildPlannedSceneTimingCues(
  scenes: PlannedProductionScene[],
  duration: number,
): Array<{ start: number; end: number; text: string }> {
  const weights = scenes.map(scene => Math.max(1, scene.clip.type === 'image' ? 2.8 : scene.clip.sourceDuration / 0.82));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let elapsed = 0;
  return scenes.map((scene, index) => {
    const start = elapsed;
    elapsed = index === scenes.length - 1 ? duration : Math.min(duration, elapsed + duration * weights[index]! / total);
    return { start, end: elapsed, text: scene.narration };
  });
}

export function buildPlannedTimeline(input: {
  plan: SocialProductionPlan;
  assets: SocialProductionAsset[];
  duration: number;
}) {
  if (!input.plan.ok) throw new Error(input.plan.message);
  const byId = new Map(input.assets.map(asset => [asset.id, asset]));
  const cues = buildPlannedSceneTimingCues(input.plan.scenes, input.duration);
  return input.plan.scenes.map((scene, index) => {
    const asset = byId.get(scene.clip.assetId);
    if (!asset) throw new Error(`生产计划引用的素材不存在：${scene.clip.assetId}`);
    const targetStart = cues[index]!.start;
    const targetEnd = cues[index]!.end;
    const targetDuration = Math.max(0.5, targetEnd - targetStart);
    const lockedRange = scene.matchBasis?.lockedSourceRange;
    if (lockedRange && (lockedRange.evidenceShotId !== scene.clip.evidenceShotId
      || lockedRange.startSeconds !== scene.clip.start || lockedRange.endSeconds !== scene.clip.end)) {
      throw new Error('production_plan_locked_source_range_mismatch');
    }
    if (asset.type === 'image') {
      if (targetDuration > 4.2) throw new Error('production_input_required:单张图片停留时间过长，请补充动态素材或缩短脚本');
      return { name: asset.name, type: 'image' as const, url: asset.url, targetStart, targetEnd, targetDuration };
    }
    const lockedStart = lockedRange?.startSeconds ?? scene.clip.start;
    const lockedEnd = lockedRange?.endSeconds ?? scene.clip.end;
    const availableSourceDuration = lockedEnd - lockedStart;
    // A shorter spoken scene may take a shorter sub-range from the verified
    // clip. A longer spoken scene may slow the clip by at most 20%; it may not
    // clone the last frame or loop the same interval.
    const sourceDuration = Math.min(availableSourceDuration, targetDuration * 1.1);
    const speed = sourceDuration / targetDuration;
    if (!Number.isFinite(speed) || speed < 0.8 || speed > 1.25) {
      throw new Error('production_input_required:实际口播时长与可信素材覆盖不匹配，请补充素材或缩短脚本');
    }
    return {
      name: asset.name,
      type: 'video' as const,
      url: asset.url,
      trimStart: lockedStart,
      trimEnd: lockedStart + sourceDuration,
      speed,
      targetStart,
      targetEnd,
      targetDuration,
    };
  });
}
