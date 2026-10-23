import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { tenantPrivateObjectKey } from '../storage/materialAssets.js';
import { objectStorageHead, objectStorageSignedGetUrl, objectStorageUploadFile } from '../storage/objectStorage.js';

const run = promisify(execFile);
// Seedance 2.0 r2v requires at least 407,696 pixels. 480x854 clears that
// admission floor while the grayscale/blur/edge transform still removes identity texture.
export const MOTION_GUIDE_FILTER = 'scale=480:-2:flags=area,format=gray,gblur=sigma=18:steps=6,edgedetect=low=0.05:high=0.2,eq=contrast=2.0,fps=12';

export type MotionGuideAttestation = {
  version: 1;
  identityRemoved: true;
  motionOnly: true;
  sourceSha256: string;
  outputSha256: string;
  objectKey: string;
  parameters: { width: 480; grayscale: true; blurSigma: 18; edgeDetect: true; fps: 12; audioRemoved: true };
  createdAt: string;
};

export async function prepareLocalSeedanceMotionGuide(input: {
  tenantId: string;
  cueId: string;
  sourceVideoPath: string;
  workDir?: string;
  /** Provider reference-video admission follows the generated duration. Very
   * short physical beats are held on their last anonymized frame, while the
   * editing timeline still keeps the original beat length. */
  padToSeconds?: number;
}, dependencies: {
  ffmpegPath?: string;
  uploadFile?: typeof objectStorageUploadFile;
  head?: typeof objectStorageHead;
  signedGetUrl?: typeof objectStorageSignedGetUrl;
  attestationRoot?: string;
} = {}): Promise<{ url: string; identityRemoved: true; motionOnly: true; attestation: MotionGuideAttestation }> {
  const source = fs.readFileSync(input.sourceVideoPath);
  if (!source.length) throw new Error('Seedance motion-guide 源片段为空');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const workDir = path.resolve(input.workDir || path.dirname(input.sourceVideoPath));
  fs.mkdirSync(workDir, { recursive:true });
  const outputPath = path.join(workDir, `motion-guide-${sourceSha256.slice(0,24)}.mp4`);
  const padToSeconds = Number(input.padToSeconds || 0);
  const filter = padToSeconds > 0 ? `${MOTION_GUIDE_FILTER},tpad=stop_mode=clone:stop_duration=${padToSeconds}` : MOTION_GUIDE_FILTER;
  await run(String(dependencies.ffmpegPath || ffmpegStatic || ''), ['-hide_banner','-loglevel','error','-nostdin','-i',input.sourceVideoPath,
    '-map','0:v:0','-vf',filter,'-t',...(padToSeconds > 0 ? [String(padToSeconds)] : ['2147483647']),'-an','-map_metadata','-1','-c:v','libx264','-preset','medium','-crf','30','-pix_fmt','yuv420p','-movflags','+faststart','-y',outputPath], { timeout:120_000 });
  const output = fs.readFileSync(outputPath);
  if (output.length < 100) throw new Error('Seedance motion-guide 脱敏输出为空');
  const outputSha256 = createHash('sha256').update(output).digest('hex');
  if (outputSha256 === sourceSha256) throw new Error('Seedance motion-guide 脱敏输出与源片哈希相同，拒绝上传');
  const objectKey = tenantPrivateObjectKey('seedance-motion-guides', input.tenantId, `${outputSha256}.mp4`);
  await (dependencies.uploadFile || objectStorageUploadFile)({ key:objectKey, filePath:outputPath, contentType:'video/mp4', contentLength:output.length });
  const stored = await (dependencies.head || objectStorageHead)(objectKey);
  if (!stored?.size || stored.size !== output.length) throw new Error('Seedance motion-guide 上传完整性检查失败');
  const url = await (dependencies.signedGetUrl || objectStorageSignedGetUrl)(objectKey, 900);
  if (!/^https:\/\//i.test(url)) throw new Error('Seedance motion-guide 对象存储未提供 HTTPS 签名地址');
  const attestation: MotionGuideAttestation = { version:1, identityRemoved:true, motionOnly:true, sourceSha256, outputSha256, objectKey,
    parameters:{width:480,grayscale:true,blurSigma:18,edgeDetect:true,fps:12,audioRemoved:true}, createdAt:new Date().toISOString() };
  const attestationRoot = path.resolve(dependencies.attestationRoot || 'data/motion-guide-attestations');
  fs.mkdirSync(attestationRoot,{recursive:true});
  const attestationPath=path.join(attestationRoot,`${outputSha256}.json`), temporary=`${attestationPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(attestation,null,2),{mode:0o600}); fs.renameSync(temporary,attestationPath);
  return {url,identityRemoved:true,motionOnly:true,attestation};
}
