import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertCurrentContentExecutionActive, readCurrentContentExecutionCheckpoint, recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import type { SocialContentAutoProductionRuntime } from './socialContentProductionExecution.js';
import { socialRequestHash } from './socialContentValidation.js';
import type { SocialDirectorContentHandoff } from './socialContentDirectorPlan.js';
import type { ProductionAsset } from './socialContentProductionMaterials.js';
import {readSocialRenderFrameContract,type SocialRenderFrameContract} from './socialRenderFrameContract.js';
import type { VideoProductionGraphPhase } from '../../shared/contracts/videoProductionSupervisor.js';

export type SocialProductionGraphPhase = Exclude<VideoProductionGraphPhase, 'delivery'>;
type RenderPort = NonNullable<SocialContentAutoProductionRuntime['renderComposite']>;
async function mediaHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Bind the render to actual bytes, rather than OS-temporary path names. */
async function stableMediaInput(value: unknown): Promise<unknown> {
  if (typeof value === 'string' && path.isAbsolute(value) && existsSync(value)) {
    const stat = await fsp.stat(value);
    if (stat.isFile()) return { mediaSha256: await mediaHash(value) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(stableMediaInput));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(
    Object.entries(value).map(async ([key, item]) => [key, await stableMediaInput(item)] as const),
  ));
  return value;
}

export interface SocialRenderStageReceipt {
  cachePath: string;
  sha256: string;
  inputHash: string;
  subtitleRenderEvidence?: {schemaVersion:'rendered-subtitle-track.v1';outputSha256:string;assSha256:string|null;filterApplied:boolean};
  rendererAttestation?: RendererSubtitleAttestation;
  frameRenderEvidence?: {schemaVersion:'renderer-frame-attestation.v1';outputSha256:string;fps:30;durationSeconds:number;expectedFrames:number};
  /** Private render-stage evidence, not a pixel-level caption approval. */
  subtitleAssSidecar?: {path:string;sha256:string;byteLength:number;outputSha256:string;subtitleCueSha256:string};
  /** Same-graph caption-free visual branch; still needs independent frame/mask verification. */
  captionBaselineSidecar?: {path:string;sha256:string;byteLength:number;outputSha256:string;filterGraphSha256:string};
}
interface RendererSubtitleAttestation {
  schemaVersion:'renderer-subtitle-attestation.v2';outputSha256:string;assSha256:string|null;
  filterApplied:boolean;subtitleCueSha256:string;filterGraphSha256:string;
}
const sha256Text=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const digestFormat=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function verifySocialFrameRenderAttestation(input:{raw:unknown;outputSha256:string;manifest:unknown}):SocialRenderStageReceipt['frameRenderEvidence']{
 const frozen=readSocialRenderFrameContract(input.manifest);
 const raw=(input.raw as {frameRenderEvidence?:Record<string,unknown>})?.frameRenderEvidence;
 if(!frozen||!raw||raw.schemaVersion!=='renderer-frame-attestation.v1'||raw.outputSha256!==input.outputSha256||raw.fps!==frozen.fps||raw.durationSeconds!==frozen.durationSeconds||raw.expectedFrames!==frozen.expectedFrames)return undefined;
 return raw as unknown as NonNullable<SocialRenderStageReceipt['frameRenderEvidence']>;
}
const MAX_ASS_SIDECAR_BYTES=128*1024;
const MAX_CAPTION_BASELINE_BYTES=256*1024*1024;
export async function persistPrivateCaptionBaseline(input:{directory:string;raw:unknown;attestation:RendererSubtitleAttestation;outputSha256:string}):Promise<SocialRenderStageReceipt['captionBaselineSidecar']>{
  const source=(input.raw as {captionBaselineEvidence?:Record<string,unknown>})?.captionBaselineEvidence;
  if(!source||source.schemaVersion!=='renderer-caption-baseline.v1'||source.outputSha256!==input.outputSha256
    ||source.filterGraphSha256!==input.attestation.filterGraphSha256||!digestFormat(source.sha256)
    ||!Number.isInteger(source.byteLength)||Number(source.byteLength)<1||Number(source.byteLength)>MAX_CAPTION_BASELINE_BYTES
    ||typeof source.path!=='string'||path.basename(path.dirname(source.path))!=='.private-render-evidence'
    ||!path.basename(source.path).endsWith('.caption-base.mp4'))return undefined;
  const sourceParent=await fsp.lstat(path.dirname(source.path)).catch(()=>null);
  const sourceStat=await fsp.lstat(source.path).catch(()=>null);
  if(!sourceParent?.isDirectory()||sourceParent.isSymbolicLink()||(sourceParent.mode&0o077)!==0
    ||!sourceStat?.isFile()||sourceStat.isSymbolicLink()||(sourceStat.mode&0o077)!==0
    ||sourceStat.size!==source.byteLength||await mediaHash(source.path)!==source.sha256)return undefined;
  await fsp.mkdir(input.directory,{recursive:true,mode:0o700});
  const directoryStat=await fsp.lstat(input.directory);
  if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink())throw Error('graph_render_baseline_directory_invalid');
  await fsp.chmod(input.directory,0o700);
  const sidecarPath=path.join(input.directory,`${input.outputSha256}.${source.sha256}.caption-base.mp4`);
  const temporary=path.join(input.directory,`${randomUUID()}.baseline.tmp`);
  await fsp.copyFile(source.path,temporary,constants.COPYFILE_EXCL);
  try{
    await fsp.chmod(temporary,0o600);
    if(await mediaHash(temporary)!==source.sha256)throw Error('graph_render_baseline_copy_changed');
    await fsp.link(temporary,sidecarPath).catch(async error=>{
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const existing=await fsp.lstat(sidecarPath);
      if(!existing.isFile()||existing.isSymbolicLink()||existing.size!==source.byteLength||await mediaHash(sidecarPath)!==source.sha256)throw Error('graph_render_baseline_integrity_conflict');
    });
  }finally{await fsp.rm(temporary,{force:true});}
  return {path:sidecarPath,sha256:source.sha256,byteLength:Number(source.byteLength),outputSha256:input.outputSha256,filterGraphSha256:input.attestation.filterGraphSha256};
}
export async function verifyPrivateCaptionBaseline(input:{directory:string;sidecar:SocialRenderStageReceipt['captionBaselineSidecar'];attestation:RendererSubtitleAttestation;outputSha256:string}):Promise<boolean>{
  const value=input.sidecar;
  if(!value||value.path!==path.join(input.directory,`${input.outputSha256}.${value.sha256}.caption-base.mp4`)
    ||value.outputSha256!==input.outputSha256||value.filterGraphSha256!==input.attestation.filterGraphSha256
    ||!digestFormat(value.sha256)||!Number.isInteger(value.byteLength)||value.byteLength<1||value.byteLength>MAX_CAPTION_BASELINE_BYTES)return false;
  try{const parent=await fsp.lstat(input.directory),stat=await fsp.lstat(value.path);
    return parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o077)===0&&stat.isFile()&&!stat.isSymbolicLink()
      &&(stat.mode&0o077)===0&&stat.size===value.byteLength&&await mediaHash(value.path)===value.sha256;
  }catch{return false;}
}
export async function persistPrivateAssSidecar(input:{directory:string;raw:unknown;attestation:RendererSubtitleAttestation;outputSha256:string}):Promise<SocialRenderStageReceipt['subtitleAssSidecar']>{
  const text=(input.raw as {subtitleAssUtf8?:unknown})?.subtitleAssUtf8;
  if(typeof text!=='string'||!text.includes('[Events]')||!text.includes('Dialogue:'))return undefined;
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length===0||bytes.length>MAX_ASS_SIDECAR_BYTES||createHash('sha256').update(bytes).digest('hex')!==input.attestation.assSha256)return undefined;
  await fsp.mkdir(input.directory,{recursive:true,mode:0o700});
  if((await fsp.lstat(input.directory)).isSymbolicLink())throw new Error('graph_render_sidecar_directory_symlink');
  await fsp.chmod(input.directory,0o700);
  const sidecarPath=path.join(input.directory,`${input.outputSha256}.${input.attestation.assSha256}.ass`);
  const temporary=path.join(input.directory,`${randomUUID()}.ass.tmp`);
  const handle=await fsp.open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{
    await fsp.link(temporary,sidecarPath).catch(async error=>{
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const existing=await fsp.lstat(sidecarPath);
      if(!existing.isFile()||existing.isSymbolicLink()||existing.size!==bytes.length||await mediaHash(sidecarPath)!==input.attestation.assSha256)throw new Error('graph_render_sidecar_integrity_conflict');
    });
  }finally{await fsp.rm(temporary,{force:true});}
  return {path:sidecarPath,sha256:input.attestation.assSha256,byteLength:bytes.length,outputSha256:input.outputSha256,subtitleCueSha256:input.attestation.subtitleCueSha256};
}
export async function verifyPrivateAssSidecar(input:{directory:string;sidecar:SocialRenderStageReceipt['subtitleAssSidecar'];attestation:RendererSubtitleAttestation;outputSha256:string}):Promise<boolean>{
  const value=input.sidecar;
  if(!value||value.path!==path.join(input.directory,`${input.outputSha256}.${input.attestation.assSha256}.ass`)
    ||value.sha256!==input.attestation.assSha256||value.outputSha256!==input.outputSha256
    ||value.subtitleCueSha256!==input.attestation.subtitleCueSha256||!Number.isInteger(value.byteLength)
    ||value.byteLength<1||value.byteLength>MAX_ASS_SIDECAR_BYTES)return false;
  try{
    const parent=await fsp.lstat(input.directory);
    if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)return false;
    const stat=await fsp.lstat(value.path);
    return stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.size===value.byteLength&&await mediaHash(value.path)===value.sha256;
  }catch{return false;}
}
/** A renderer report becomes G4-visible only when its independently read output
 * and frozen cue bytes agree. The graph hash is provenance, not a pixel proof. */
export function verifySocialSubtitleRenderAttestation(input:{
  raw:unknown;outputSha256:string;manifest:unknown;
}):Pick<SocialRenderStageReceipt,'subtitleRenderEvidence'|'rendererAttestation'>|null{
  const value=(input.raw as {subtitleRenderEvidence?:Record<string,unknown>})?.subtitleRenderEvidence;
  const manifest=input.manifest as {subtitles?:{mode?:string;cues?:unknown}}|null;
  const cues=manifest?.subtitles&&manifest.subtitles.mode!=='off'?manifest.subtitles.cues:[];
  if(!value||value.schemaVersion!=='renderer-subtitle-attestation.v2'
    ||value.outputSha256!==input.outputSha256||!digestFormat(value.outputSha256)
    ||value.subtitleCueSha256!==sha256Text(JSON.stringify(cues??null))
    ||!digestFormat(value.filterGraphSha256)||typeof value.filterApplied!=='boolean'
    ||(value.filterApplied?!digestFormat(value.assSha256):value.assSha256!==null))return null;
  const rendererAttestation=value as unknown as RendererSubtitleAttestation;
  return {rendererAttestation,subtitleRenderEvidence:{
    schemaVersion:'rendered-subtitle-track.v1',outputSha256:input.outputSha256,
    assSha256:rendererAttestation.assSha256,filterApplied:rendererAttestation.filterApplied,
  }};
}

/** A persisted filter claim is not recoverable subtitle evidence without the
 * exact private ASS bytes. This deliberately does not assert pixel coverage. */
export function recoveredSubtitleTrackEvidenceUsable(attested:ReturnType<typeof verifySocialSubtitleRenderAttestation>,sidecarValid:boolean):boolean{
  return Boolean(attested)&&(attested?.rendererAttestation?.filterApplied===true?sidecarValid:true);
}

export interface SocialBgmAudibilityEvidence {
  required: boolean;
  configuredVolume: number;
  inputMeanDb: number | null;
  inputMaxDb: number | null;
  normalizedMeanDb: number | null;
  normalizedMaxDb: number | null;
  finalMixMeanDb: number | null;
  finalMixMaxDb: number | null;
  passed: boolean;
  failure: string | null;
}

function volumeReading(stderr: string): { meanDb: number | null; maxDb: number | null } {
  const read = (label: string) => {
    const match = stderr.match(new RegExp(`${label}:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf))\\s*dB`, 'i'));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  return { meanDb: read('mean_volume'), maxDb: read('max_volume') };
}

async function inspectBgmAudibility(input: {
  source: string;
  volume: number;
  outputPath: string;
  runFfmpeg: NonNullable<SocialContentAutoProductionRuntime['runFfmpeg']>;
}): Promise<SocialBgmAudibilityEvidence> {
  const volume = Math.max(0, Math.min(100, Number(input.volume) || 0));
  const base = { required: true, configuredVolume: volume };
  const source = await input.runFfmpeg(['-i', input.source, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], false, { logLevel: 'info' });
  const normalized = await input.runFfmpeg(['-i', input.source, '-map', '0:a:0', '-af', `loudnorm=I=-16:TP=-2:LRA=11,volume=${(volume / 100).toFixed(2)},volumedetect`, '-f', 'null', '-'], false, { logLevel: 'info' });
  const mixed = await input.runFfmpeg(['-i', input.outputPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], false, { logLevel: 'info' });
  const sourceLevel = volumeReading(source.stderr);
  const normalizedLevel = volumeReading(normalized.stderr);
  const mixedLevel = volumeReading(mixed.stderr);
  const failure = !source.ok || sourceLevel.meanDb === null || sourceLevel.maxDb === null || sourceLevel.maxDb < -80
    ? '配乐输入为空、静音或无法测量'
    : volume <= 0
      ? '编导方案的配乐音量为零'
      : !normalized.ok || normalizedLevel.meanDb === null || normalizedLevel.maxDb === null || normalizedLevel.meanDb < -42
        ? '配乐按冻结音量混合后不可闻'
        : !mixed.ok || mixedLevel.meanDb === null || mixedLevel.maxDb === null || mixedLevel.meanDb < -50
          ? '成片最终混合音轨不可闻'
          : null;
  return {
    ...base,
    inputMeanDb: sourceLevel.meanDb,
    inputMaxDb: sourceLevel.maxDb,
    normalizedMeanDb: normalizedLevel.meanDb,
    normalizedMaxDb: normalizedLevel.maxDb,
    finalMixMeanDb: mixedLevel.meanDb,
    finalMixMaxDb: mixedLevel.maxDb,
    passed: failure === null,
    failure,
  };
}

/** Director records retain immutable semantic lineage. OS workspace locations
 * are rehydrated only from the same verified asset identity and content bytes. */
export async function rebindSocialGraphRenderSources(handoff: SocialDirectorContentHandoff, assets: ProductionAsset[]): Promise<SocialDirectorContentHandoff> {
  const rebound = structuredClone(handoff);
  for (const scene of rebound.scenes) {
    const asset = assets.find(item => item.id === scene.source.assetId && item.sourceId === scene.source.sourceId);
    if (!asset || asset.contentHash !== scene.source.contentHash) throw new Error(`user_input_required:graph_director_asset_changed:${scene.sceneId}`);
    const renderUrl = asset.localPath || asset.url;
    if (path.isAbsolute(renderUrl)) {
      if (!existsSync(renderUrl) || await mediaHash(renderUrl) !== scene.source.contentHash)
        throw new Error(`user_input_required:graph_director_asset_bytes_changed:${scene.sceneId}`);
    }
    scene.source.renderUrl = renderUrl;
  }
  return rebound;
}

/** Rendering is its own real stage. Its output survives cleanup of the render
 * workspace; restoration validates bytes before downstream QA consumes them.
 * A missing worker-local cache permits a local rerender, never paid resubmission.
 */
export async function executeSocialRenderStage(input: {
  tenantId: string; taskId: string; runId: string;
  manifest: Parameters<RenderPort>[0]; outputDirectory: string; render: RenderPort;
  checkpointEnabled?: boolean;
}): Promise<{ ok: true; outputPath: string; receipt: SocialRenderStageReceipt; reused: boolean }> {
  if (input.checkpointEnabled === false) {
    const rendered = await input.render(input.manifest, undefined, input.outputDirectory);
    if (!rendered.ok || !rendered.outputPath || !existsSync(rendered.outputPath)) throw new Error(rendered.error || '视频渲染没有生成输出文件');
    const sha256=await mediaHash(rendered.outputPath);
    return { ok: true, outputPath: rendered.outputPath, receipt: { cachePath: '', sha256, inputHash: '', ...verifySocialSubtitleRenderAttestation({raw:rendered,outputSha256:sha256,manifest:input.manifest}),frameRenderEvidence:verifySocialFrameRenderAttestation({raw:rendered,outputSha256:sha256,manifest:input.manifest}) }, reused: false };
  }
  const inputHash = socialRequestHash(await stableMediaInput(input.manifest));
  const scope = createHash('sha256').update(JSON.stringify([input.tenantId, input.taskId, input.runId])).digest('hex');
  const directory = path.resolve('data/content-execution-render', scope);
  const saved = readCurrentContentExecutionCheckpoint<SocialRenderStageReceipt>({ stage: 'social.graph_render', version: '1', inputHash });
  if (saved && saved.inputHash === inputHash && /^[a-f0-9]{64}$/.test(saved.sha256)
    && saved.cachePath === path.join(directory, `${saved.sha256}.mp4`)) {
    try {
      if (await mediaHash(saved.cachePath) === saved.sha256) {
        await assertCurrentContentExecutionActive();
        const attested=verifySocialSubtitleRenderAttestation({raw:{subtitleRenderEvidence:saved.rendererAttestation},outputSha256:saved.sha256,manifest:input.manifest});
        const sidecarValid=attested?.rendererAttestation&&saved.subtitleAssSidecar
          ?await verifyPrivateAssSidecar({directory,sidecar:saved.subtitleAssSidecar,attestation:attested.rendererAttestation,outputSha256:saved.sha256})
          :false;
        const baselineValid=attested?.rendererAttestation&&saved.captionBaselineSidecar
          ?await verifyPrivateCaptionBaseline({directory,sidecar:saved.captionBaselineSidecar,attestation:attested.rendererAttestation,outputSha256:saved.sha256})
          :false;
        // A renderer's hash-only report cannot stand in for the private ASS
        // bytes after restart. Older checkpoints lacking the sidecar remain
        // usable as video caches, but lose their subtitle-track evidence.
        const trackUsable=recoveredSubtitleTrackEvidenceUsable(attested,Boolean(sidecarValid));
        return { ok: true, outputPath: saved.cachePath, receipt: {...saved,
          frameRenderEvidence:verifySocialFrameRenderAttestation({raw:saved,outputSha256:saved.sha256,manifest:input.manifest}),
          subtitleRenderEvidence:trackUsable?attested?.subtitleRenderEvidence:undefined,
          rendererAttestation:trackUsable?attested?.rendererAttestation:undefined,
          subtitleAssSidecar:sidecarValid?saved.subtitleAssSidecar:undefined,
          captionBaselineSidecar:baselineValid?saved.captionBaselineSidecar:undefined}, reused: true };
      }
    } catch { /* Rebuild local rendering from verified domain inputs. */ }
  }
  await assertCurrentContentExecutionActive();
  const rendered = await input.render(input.manifest, undefined, input.outputDirectory);
  if (!rendered.ok || !rendered.outputPath || !existsSync(rendered.outputPath)) throw new Error(rendered.error || '视频渲染没有生成输出文件');
  const sha256 = await mediaHash(rendered.outputPath);
  await fsp.mkdir(directory, { recursive: true });
  const cachePath = path.join(directory, `${sha256}.mp4`);
  const temporary = path.join(directory, `${sha256}.${randomUUID()}.tmp`);
  try {
    await fsp.copyFile(rendered.outputPath, temporary, constants.COPYFILE_EXCL);
    await fsp.link(temporary, cachePath).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await mediaHash(cachePath) !== sha256) throw new Error('graph_render_cache_integrity_conflict');
    });
  } finally { await fsp.rm(temporary, { force: true }); }
  const attested=verifySocialSubtitleRenderAttestation({raw:rendered,outputSha256:sha256,manifest:input.manifest});
  const subtitleAssSidecar=attested?.rendererAttestation?.filterApplied
    ?await persistPrivateAssSidecar({directory,raw:rendered,attestation:attested.rendererAttestation,outputSha256:sha256})
    :undefined;
  const captionBaselineSidecar=attested?.rendererAttestation?.filterApplied
    ?await persistPrivateCaptionBaseline({directory,raw:rendered,attestation:attested.rendererAttestation,outputSha256:sha256})
    :undefined;
  const receipt:SocialRenderStageReceipt = { cachePath, sha256, inputHash, ...attested,frameRenderEvidence:verifySocialFrameRenderAttestation({raw:rendered,outputSha256:sha256,manifest:input.manifest}),subtitleAssSidecar,captionBaselineSidecar };
  await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_render', version: '1', inputHash, payload: receipt });
  return { ok: true, outputPath: cachePath, receipt, reused: false };
}

/** Technical QA can resume independently of rendering. A cached report is
 * valid only for these exact output bytes and scene timings. */
export async function executeSocialQualityStage(input: {
  outputPath: string; duration: number;
  scenes: Parameters<NonNullable<SocialContentAutoProductionRuntime['inspectScenes']>>[0]['scenes'];
  expectedUniqueScenes: number;
  inspectVisuals: NonNullable<SocialContentAutoProductionRuntime['inspectVisuals']>;
  inspectScenes: NonNullable<SocialContentAutoProductionRuntime['inspectScenes']>;
  runFfmpeg: NonNullable<SocialContentAutoProductionRuntime['runFfmpeg']>;
  checkpointEnabled?: boolean;
  verifyDuration?: boolean;
  expectedBgm?: { source: string; sourceHash: string; volume: number };
}) {
  const sha256 = input.checkpointEnabled === false ? '' : await mediaHash(input.outputPath);
  const inputHash = socialRequestHash({ sha256, duration: input.duration, scenes: input.scenes, expectedUniqueScenes: input.expectedUniqueScenes, verifyDuration: input.verifyDuration === true,
    expectedBgm: input.expectedBgm ? { sourceHash: input.expectedBgm.sourceHash, volume: input.expectedBgm.volume } : null });
  type Report = { quality: Awaited<ReturnType<typeof input.inspectVisuals>>; sceneQuality: Awaited<ReturnType<typeof input.inspectScenes>>; audio: { ok: boolean; bgm?: SocialBgmAudibilityEvidence }; measuredDurationSeconds?: number };
  const saved = input.checkpointEnabled === false ? null : readCurrentContentExecutionCheckpoint<Report>({ stage: 'social.graph_quality', version: '1', inputHash });
  if (input.checkpointEnabled !== false) await assertCurrentContentExecutionActive();
  if (saved) return saved;
  const quality = await input.inspectVisuals({ outputPath: input.outputPath, expectedDuration: input.duration, expectedUniqueScenes: input.expectedUniqueScenes });
  const sceneQuality = await input.inspectScenes({ outputPath: input.outputPath, scenes: input.scenes, requireDistinct: true });
  const audio = await input.runFfmpeg(['-i', input.outputPath, '-map', '0:a:0', '-t', String(Math.min(2, input.duration)), '-f', 'null', '-']);
  const bgm = input.expectedBgm
    ? await inspectBgmAudibility({ source: input.expectedBgm.source, volume: input.expectedBgm.volume, outputPath: input.outputPath, runFfmpeg: input.runFfmpeg })
    : undefined;
  if (bgm && !bgm.passed) {
    quality.passed = false;
    quality.failures.push(bgm.failure || '配乐可闻性检查失败');
  }
  let measuredDurationSeconds: number | undefined;
  if (input.verifyDuration) {
    // Decode the video stream through EOF: container/audio duration cannot prove
    // that the visual timeline actually reached the locked end.
    const decoded = await input.runFfmpeg(['-i', input.outputPath, '-map', '0:v:0', '-an', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], true);
    const progress = decoded.stdout.toString();
    const times = [...progress.matchAll(/out_time_us=(\d+)/g)].map(match => Number(match[1]) / 1e6);
    measuredDurationSeconds = decoded.ok && /progress=end/.test(progress) && times.length ? Math.max(...times) : 0;
    if (!measuredDurationSeconds || Math.abs(measuredDurationSeconds - input.duration) > 0.25) {
      quality.passed = false;
      quality.failures.push(`实际视频时长 ${measuredDurationSeconds.toFixed(3)} 秒与锁定 ${input.duration.toFixed(3)} 秒不一致`);
    }
  }
  const report: Report = { quality, sceneQuality, audio: { ok: audio.ok, ...(bgm ? { bgm } : {}) }, ...(input.verifyDuration ? { measuredDurationSeconds } : {}) };
  if (input.checkpointEnabled !== false) await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_quality', version: '1', inputHash, payload: report });
  return report;
}
