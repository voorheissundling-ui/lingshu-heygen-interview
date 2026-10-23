import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { cueFirstFrameTime, type DigitalHumanReferenceCue } from '../../src/lib/digitalHumanPlan.js';
import { readLocalMaterials, saveLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { tenantAssetDir, tenantAssetRelativePath } from './assetAccess.js';
import { objectStorageDownload } from '../storage/objectStorage.js';
import { assertPersonCueShotBoundaries, hardSceneCutTimes, splitPersonCuesAtHardCuts } from './sentenceCueSceneCuts.js';

const run = promisify(execFile);

export async function extractSentenceFirstFrames(input: {
  tenantId: string;
  referenceMaterialId: string;
  cues: DigitalHumanReferenceCue[];
  mediaRoot?: string;
  ffmpegPath?: string;
  materials?: () => MaterialRecord[];
  saveMaterials?: (items: MaterialRecord[]) => void;
  downloadObject?: typeof objectStorageDownload;
  sourceMaterial?: MaterialRecord;
  autoSplitPhysicalCuts?: boolean;
}): Promise<DigitalHumanReferenceCue[]> {
  if (!input.cues.length) throw new Error('逐句首帧提取缺少口播时间轴');
  const materials = (input.materials || readLocalMaterials)();
  const source = (input.sourceMaterial?.id === input.referenceMaterialId ? input.sourceMaterial : undefined)
    || materials.find(item => item.id === input.referenceMaterialId
    && (item.scope === 'shared' || String(item.tenantId || item.tenant_id || '') === input.tenantId));
  if (!source || source.type !== 'video' || (source.scope !== 'shared' && String(source.tenantId || source.tenant_id || '') !== input.tenantId)) throw new Error('爆款参考视频不存在或不属于当前企业');
  const root = path.resolve(input.mediaRoot || path.join(process.cwd(), 'data/media'));
  const tenantRoot = tenantAssetDir(root, input.tenantId);
  fs.mkdirSync(tenantRoot, { recursive: true });
  let sourcePath = source.file ? path.resolve(root, String(source.file)) : '';
  if (source.verifyContentSha256 && sourcePath && (!sourcePath.startsWith(`${path.resolve(tenantRoot)}${path.sep}`) || (fs.existsSync(sourcePath) && !fs.realpathSync(sourcePath).startsWith(`${fs.realpathSync(tenantRoot)}${path.sep}`)))) throw new Error('爆款参考视频路径不属于当前企业');
  let temporary = '';
  try {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    if (!source.objectKey) throw new Error('爆款参考视频没有可读取的本地文件或对象');
    const object = await (input.downloadObject || objectStorageDownload)(String(source.objectKey));
    if (!object?.buf.length) throw new Error('爆款参考视频对象读取失败');
    temporary = path.join(tenantRoot, `.source-${createHash('sha256').update(String(source.objectKey)).digest('hex').slice(0, 16)}.mp4`);
    fs.writeFileSync(temporary, object.buf, { mode: 0o600 }); sourcePath = temporary;
  }
  if (source.verifyContentSha256) {
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(sourcePath)) digest.update(chunk);
    const actual = digest.digest('hex');
    if (actual !== source.contentSha256) throw new Error('爆款参考视频文件版本与入库记录不一致');
  }
  const ffmpeg = input.ffmpegPath || String(ffmpegStatic || '');
  if (!ffmpeg) throw new Error('逐句首帧提取缺少 FFmpeg');
  const cuts = await hardSceneCutTimes(ffmpeg, sourcePath);
  const preparedCues = input.autoSplitPhysicalCuts ? splitPersonCuesAtHardCuts(input.cues, cuts) : input.cues;
  assertPersonCueShotBoundaries(preparedCues, cuts);
  const created: MaterialRecord[] = [];
    const next: DigitalHumanReferenceCue[] = [];
    for (const cue of preparedCues) {
      if (cue.personShot === false) { next.push({ ...cue, sourceFirstFrame: undefined, targetFirstFrame: undefined }); continue; }
      const time = cueFirstFrameTime(cue);
      const digest = createHash('sha256').update(`${source.id}:${source.contentSha256 || source.objectEtag || source.file || source.objectKey}:${cue.id}:${time}`).digest('hex');
      const id = `sentence-frame-${digest.slice(0, 24)}`;
      const filename = `${id}.jpg`; const output = path.join(tenantRoot, filename);
      if (!fs.existsSync(output)) await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', time.toFixed(3), '-i', sourcePath, '-frames:v', '1', '-q:v', '2', '-y', output], { timeout: 30_000 });
      const bytes = fs.readFileSync(output); if (!bytes.length) throw new Error(`句 ${cue.id} 首帧提取结果为空`);
      const relative = tenantAssetRelativePath(input.tenantId, filename);
      const material: MaterialRecord = { id, name: `爆款逐句首帧 · ${cue.originalText}`.slice(0, 100), folder: 'presenter', type: 'image', duration: 0,
        size: `${Math.max(1, Math.round(bytes.length / 1024))} KB`, file: relative, url: `/media/${relative}`, poster: `/media/${relative}`,
        scope: 'own', tenantId: input.tenantId, usage: 'analysis', sourceType: 'viral-sentence-first-frame', sourceMaterialId: source.id,
        sourceTime: time, contentSha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() };
      created.push(material);
      next.push({ ...cue, sourceFirstFrame: { time, materialId: id, imageUrl: material.url },
        targetFirstFrame: cue.targetFirstFrame || { state: 'pending' } });
    }
    const ids = new Set(created.map(item => item.id));
    (input.saveMaterials || saveLocalMaterials)([...materials.filter(item => !ids.has(item.id)), ...created]);
    return next;
  } finally { if (temporary) fs.rmSync(temporary, { force: true }); }
}
