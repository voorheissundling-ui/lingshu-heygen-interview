/** G5 observations must cover the actual continuous edit, including the opening hook.
 * Allow only sub-frame rounding (1 ms), never missing, overlapping or negative scenes.
 */
export function directorG5TimelineVerified(scenes: ReadonlyArray<{startSeconds:number;endSeconds:number}>): boolean {
  if (!scenes.length) return false;
  let previousEnd = 0;
  for (const scene of scenes) {
    if (!Number.isFinite(scene.startSeconds) || !Number.isFinite(scene.endSeconds)
      || scene.startSeconds < 0 || scene.endSeconds <= scene.startSeconds
      || Math.abs(scene.startSeconds - previousEnd) > .001) return false;
    previousEnd = scene.endSeconds;
  }
  return true;
}
