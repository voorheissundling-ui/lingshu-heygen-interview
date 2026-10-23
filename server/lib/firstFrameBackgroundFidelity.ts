import sharp from 'sharp';

export type FirstFrameBackgroundFidelity = {
  passed: boolean;
  outerMae: number;
  threshold: number;
  evidence: string;
};

/**
 * Fail-closed structural guard for person replacement first frames. The center
 * is excluded because identity replacement is expected there; the outer bands
 * must remain close to the source plate after low-frequency normalization.
 */
export async function inspectFirstFrameBackgroundFidelity(
  source: Buffer,
  candidate: Buffer,
  threshold = 0.12,
): Promise<FirstFrameBackgroundFidelity> {
  const width = 64, height = 112;
  const normalize = (bytes: Buffer) => sharp(bytes).resize(width,height,{fit:'fill'}).greyscale().blur(2).raw().toBuffer();
  const [left,right] = await Promise.all([normalize(source),normalize(candidate)]);
  let difference = 0, samples = 0;
  for (let y=0;y<height;y+=1) for(let x=0;x<width;x+=1) {
    // Keep the ceiling/topology and both side bands; exclude the replaceable presenter core.
    if (!(y < 18 || x < 13 || x >= 51)) continue;
    const index=y*width+x; difference+=Math.abs(left[index]!-right[index]!); samples+=1;
  }
  if (!samples) throw new Error('背景锁定检查没有可比较像素');
  const outerMae=Number((difference/samples/255).toFixed(4));
  return {passed:outerMae<=threshold,outerMae,threshold,evidence:`outer-background-mae=${outerMae.toFixed(4)} threshold=${threshold.toFixed(4)}`};
}
