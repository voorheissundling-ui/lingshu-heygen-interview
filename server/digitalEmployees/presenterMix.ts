export interface MixClip { name: string; type: string; url: string; targetDuration: number; trimStart?: number; trimEnd?: number; speed?: number }
/** Keep the presenter on the original audio clock when returning after B-roll. */
export function buildPresenterMixTimeline(avatarUrl: string, durations: number[], middle: MixClip[]) {
  if (!avatarUrl || durations.length < 3 || middle.length !== durations.length - 2 || durations.some(value => !Number.isFinite(value) || value < 0.5)) throw Error('数字人混剪分镜或素材不完整');
  if (middle.some(clip => !clip.url || clip.url === avatarUrl)) throw Error('数字人混剪必须包含独立的产品素材');
  let cursor = 0;
  return durations.map((targetDuration, index) => {
    const start = cursor; cursor += targetDuration;
    if (index === 0 || index === durations.length - 1) return { index, name: 'HeyGen 数字人', type: 'video', url: avatarUrl, targetDuration, trimStart: start, trimEnd: cursor, speed: 1 };
    return { ...middle[index - 1], index, targetDuration };
  });
}

export function buildPresentationTimeline(mode: 'material' | 'avatar' | 'heygen', avatarUrl: string, durations: number[], choices: Array<{ source: 'avatar' | 'material'; clip?: MixClip }>) {
  if (!durations.length || choices.length !== durations.length || durations.some(value => !Number.isFinite(value) || value < .5)) throw Error('分镜时间线不完整');
  const hasAvatar = choices.some(choice => choice.source === 'avatar');
  const hasMaterial = choices.some(choice => choice.source === 'material');
  if (mode === 'avatar' && hasMaterial || mode === 'material' && hasAvatar || mode === 'heygen' && (!hasAvatar || !hasMaterial)) throw Error('分镜画面与所选成片方式不一致');
  let cursor = 0;
  return choices.map((choice, index) => {
    const start = cursor; cursor += durations[index];
    if (choice.source === 'avatar') {
      if (!avatarUrl) throw Error('数字人视频尚未生成');
      return { index, name: 'HeyGen 数字人', type: 'video', url: avatarUrl, targetDuration: durations[index], trimStart: start, trimEnd: cursor, speed: 1 };
    }
    if (choice.source !== 'material' || !choice.clip?.url || choice.clip.url === avatarUrl) throw Error('指定素材缺失，不能自动替换为数字人');
    return { ...choice.clip, index, targetDuration: durations[index] };
  });
}
