import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import { readTenantMaterialBytes } from '../lib/sentenceReplicationProduction.js';
import { measureAvatarSourceCaptions } from '../lib/avatarSourceCaptions.js';
import { studioPaidBudget } from '../lib/studioPaidBudget.js';
import { withPaidOperationLock } from '../lib/paidOperationLock.js';
import { synthesizeStudioVoiceForAutomation, voiceoverLineNeedsLanguageRepair } from '../routes/studio.js';
import { inspectRenderedVisuals, inspectRenderedScenes } from '../lib/renderVisualQuality.js';
import { paginateAlignedCues, subtitleCuesAreSafe } from '../lib/subtitleCues.js';
import { finishContent } from './contentFinish.js';
import { CONTENT_SCRIPT_QUALITY_RULE_VERSION } from './contentQualityContract.js';
import { store } from '../storage/index.js';
import { digitalHumanQualityState } from '../../src/lib/digitalHumanQuality.js';
import { shotFingerprint } from '../../src/lib/shotProduction.js';
import { replicationNarrationSegments } from './replicationWorkbenchPlan.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const composite = (require('../../desktop/render.cjs') as { composite: (manifest: any, progress?: unknown, outputDir?: string) => Promise<{ ok: boolean; outputPath?: string; error?: string }> }).composite;
type Cue = { start: number; end: number; text: string };
type Probe = { duration: number; hasAudio: boolean };
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const normalizedSpeech = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Pure preflight, before ASR/TTS intents or media IO. A rejected input is not
 * an uncertain paid operation. Never repair a frozen script by rewriting it,
 * dropping words, or independently voicing fragments of a continuous line. */
export function replicationNarrationPreflightIssue(spec: Record<string, any>): string | null {
  const language = String(spec.activeVoiceLang || spec.lang || 'en');
  const shots = Array.isArray(spec.automatedReplicationShots) ? spec.automatedReplicationShots : [];
  const lines = shots.map((shot: any) => String(spec.shotProductions?.[`${spec.activeAssemblyId}:${shot.shotId}`]?.narration || '').trim());
  const frozen = replicationNarrationSegments(String(spec.script || '')).filter(segment => segment.text);
  if (frozen.some(segment => voiceoverLineNeedsLanguageRepair(segment.text, language))) {
    return `冻结口播与目标语种 ${language} 不一致；请先确认完整目标语种脚本，未提交配音`;
  }
  // Non-person visuals may cut many times inside one complete spoken line.
  // Their narration is synthesized from the frozen timestamp track, not from
  // visual-shot fragments, so a camera cut can never split a TTS sentence.
  if (shots.length && shots.every((shot: any) => shot.kind === 'nonperson')) {
    const duration = Math.max(0, ...shots.map((shot: any) => Number(shot.end) || 0));
    return frozen.some(segment => !(segment.start >= 0 && segment.end > segment.start && segment.end <= duration + .05))
      ? '冻结口播时间超出逐镜装配范围；请修复完整脚本时间轴，未提交配音'
      : null;
  }
  if (lines.some(line => voiceoverLineNeedsLanguageRepair(line, language))) {
    return `逐镜人物口播与目标语种 ${language} 不一致；请先确认完整目标语种脚本，未提交配音`;
  }
  if (!frozen.length) return null;
  if (normalizedSpeech(frozen.map(segment => segment.text).join(' ')) !== normalizedSpeech(lines.join(' '))) {
    return '冻结口播文字覆盖不完整或顺序不一致；请修复完整脚本与镜头映射，未提交配音';
  }
  for (let index = 0; index < shots.length - 1; index++) {
    const boundary = Number(shots[index]?.end);
    const crossesLine = frozen.some(segment => segment.start < boundary - .001 && segment.end > boundary + .001);
    if (crossesLine && lines[index] && lines[index + 1] && !/[.!?。！？…][”’"']?$/.test(lines[index])) {
      return `冻结口播跨越第 ${index + 1}、${index + 2} 镜且被分割为半句；需保留完整句连续配音及实测对齐，未提交配音`;
    }
  }
  return null;
}

async function probe(file: string): Promise<Probe> {
  const result = await run(String(ffmpeg || 'ffmpeg'), ['-hide_banner', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const time = result.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!time || !/Stream .*Video:/.test(result.stderr)) throw new Error('逐镜复刻视频无法完整解码');
  return { duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]), hasAudio: /Stream .*Audio:/.test(result.stderr) };
}

export type ReplicationFinishDependencies = {
  materials?: () => MaterialRecord[] | Promise<MaterialRecord[]>;
  readMaterial?: typeof readTenantMaterialBytes;
  probe?: typeof probe;
  captions?: typeof measureAvatarSourceCaptions;
  reserveAsr?: (id: string) => Promise<unknown>;
  verifyPersonAdoption?: (value: { tenantId: string; projectId: string; assemblyId: string; shotId: string; materialId: string; contentSha256: string; adoption: any }) => Promise<void>;
  synthesize?: typeof synthesizeStudioVoiceForAutomation;
  render?: typeof composite;
  visuals?: typeof inspectRenderedVisuals;
  scenes?: typeof inspectRenderedScenes;
  finish?: typeof finishContent;
  workRoot?: string;
};

type PreparedReplicationVoice = Awaited<ReturnType<typeof synthesizeStudioVoiceForAutomation>> & { audioSha256?: string };
type VerifiedPreparedReplicationVoice = PreparedReplicationVoice & {
  localPath: string;
  duration: number;
  text: string;
  cues: Cue[];
  audioSha256: string;
  alignmentSource: 'synthesized_sentence_audio';
};

function continuousNarrationContext(spec: Record<string, any>) {
  const shots = Array.isArray(spec.automatedReplicationShots) ? spec.automatedReplicationShots : [];
  const segments = replicationNarrationSegments(String(spec.script || '')).filter(segment => segment.text);
  return {
    shots,
    segments,
    continuous: shots.length > 0 && shots.every((slot: any) => slot.kind === 'nonperson') && segments.length > 0,
    language: String(spec.activeVoiceLang || spec.lang || 'en'),
  };
}

async function ensureContinuousNarrationVoice(input: {
  tenantId: string;
  projectId: string;
  spec: Record<string, any>;
  root: string;
  segmentIndex: number;
  synthesize?: typeof synthesizeStudioVoiceForAutomation;
}): Promise<{ voice: VerifiedPreparedReplicationVoice; fingerprint: string }> {
  const context = continuousNarrationContext(input.spec);
  const segment = context.segments[input.segmentIndex];
  if (!context.continuous || !segment) throw new Error('连续配音预检缺少冻结口播段');
  const targetDuration = segment.end - segment.start;
  const voiceKey = digest(JSON.stringify({ tenantId: input.tenantId, projectId: input.projectId,
    segment: input.segmentIndex, text: segment.text, language: context.language,
    voice: input.spec.voice || 'v1', targetDuration }));
  const voiceReceipt = path.join(input.root, `${voiceKey}.voice.json`);
  const failureReceipt = path.join(input.root, `${voiceKey}.failure.json`);
  let voice: PreparedReplicationVoice;
  if (fs.existsSync(voiceReceipt)) {
    voice = JSON.parse(fs.readFileSync(voiceReceipt, 'utf8'));
  } else {
    const intent = path.join(input.root, `${voiceKey}.intent`);
    if (fs.existsSync(intent)) throw new Error(`第 ${input.segmentIndex + 1} 段连续配音请求状态未知，请核对原请求，禁止重复计费`);
    fs.writeFileSync(intent, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
    voice = await (input.synthesize || synthesizeStudioVoiceForAutomation)({ tenantId: input.tenantId,
      text: segment.text, language: context.language, voice: String(input.spec.voice || 'v1'),
      targetDuration, sentenceLines: [segment.text], measuredSentenceTiming: true });
    if (!voice.ok) {
      const diagnostic = { failedAt: new Date().toISOString(), segmentIndex: input.segmentIndex,
        textHash: digest(segment.text), error: String(voice.error || '未返回有效音频').slice(0, 1_000),
        qualityReport: voice.qualityReport || null };
      const temp = `${failureReceipt}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(diagnostic), { mode: 0o600 });
      fs.renameSync(temp, failureReceipt);
      fs.unlinkSync(intent);
      throw new Error(`第 ${input.segmentIndex + 1} 段连续配音服务已明确失败：${voice.error || '未返回有效音频'}`);
    }
    // A nominal provider success without complete measured evidence may have
    // consumed quota. Keep the intent fail-closed instead of resubmitting.
    if (!voice.localPath || !voice.duration || !voice.cues?.length || voice.text !== segment.text
      || voice.alignmentSource !== 'synthesized_sentence_audio' || voice.qualityReport?.passed !== true) {
      throw new Error(`第 ${input.segmentIndex + 1} 段连续配音未通过真实声音与实测对齐检查：${voice.error || '缺少证据'}`);
    }
    voice.audioSha256 = digest(fs.readFileSync(voice.localPath));
    fs.writeFileSync(voiceReceipt, JSON.stringify(voice), { mode: 0o600 });
    if (fs.existsSync(failureReceipt)) fs.unlinkSync(failureReceipt);
    fs.unlinkSync(intent);
  }
  if (!voice.localPath || !fs.existsSync(voice.localPath) || !voice.duration || !voice.cues?.length
    || voice.text !== segment.text || voice.qualityReport?.passed !== true
    || voice.alignmentSource !== 'synthesized_sentence_audio') {
    throw new Error(`第 ${input.segmentIndex + 1} 段连续配音缓存无效`);
  }
  if (!voice.audioSha256 || digest(fs.readFileSync(voice.localPath)) !== voice.audioSha256) {
    throw new Error(`第 ${input.segmentIndex + 1} 段连续配音文件版本已变化`);
  }
  if (voice.duration > targetDuration + .01) {
    throw new Error(`第 ${input.segmentIndex + 1} 段实测口播 ${voice.duration.toFixed(2)} 秒超过冻结区间 ${targetDuration.toFixed(2)} 秒，禁止自动截断`);
  }
  return { voice: voice as VerifiedPreparedReplicationVoice, fingerprint: voiceKey };
}

/** Run the exact first continuous narration segment before visual supplier
 * work.  The successful audio receipt is the same one finish uses later, so
 * this is an early, cached production step rather than a disposable paid
 * health check. Account/auth failures therefore surface before any new visual
 * spend and never cause duplicate speech generation. */
export async function preflightReplicationNarrationProvider(input: {
  tenantId: string;
  projectId: string;
  spec: Record<string, any>;
}, deps: Pick<ReplicationFinishDependencies, 'synthesize' | 'workRoot'> = {}): Promise<{
  prepared: boolean;
  fingerprint: string;
  source: string;
  segmentCount: number;
}> {
  const issue = replicationNarrationPreflightIssue(input.spec);
  if (issue) throw new Error(issue);
  const context = continuousNarrationContext(input.spec);
  if (!context.continuous) return { prepared: false, fingerprint: '', source: '', segmentCount: 0 };
  const root = path.resolve(deps.workRoot || 'data/replication-workbench-finish', digest(`${input.tenantId}:${input.projectId}`));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const prepared = await ensureContinuousNarrationVoice({ ...input, root, segmentIndex: 0, synthesize: deps.synthesize });
  return { prepared: true, fingerprint: prepared.fingerprint, source: String(prepared.voice.source || ''), segmentCount: context.segments.length };
}

/** Finish only a fully adopted, real-video workbench. Never borrow reference audio. */
export async function finishReplicationWorkbench(input: { tenantId: string; projectId: string; spec: Record<string, any> }, deps: ReplicationFinishDependencies = {}): Promise<Record<string, any>> {
  const { tenantId, projectId, spec } = input;
  const shots = spec.automatedReplicationShots as Array<{ shotId: string; slotId: string; kind: 'person' | 'nonperson' | 'blocked'; start: number; end: number; productionState?: 'ready' | 'blocked'; blocker?: string; fingerprintContext?: string }>;
  if (!tenantId || !projectId || !Array.isArray(shots) || !shots.length || shots.length > 32) throw new Error('逐镜装配缺少有效时间轴');
  const blocked = shots.filter(shot => shot.kind === 'blocked' || shot.productionState === 'blocked');
  if (blocked.length) throw new Error(`逐镜装配仍有必需镜头未就绪：${blocked.map(shot => shot.blocker || shot.shotId).join('；')}`);
  const narrationIssue = replicationNarrationPreflightIssue(spec);
  if (narrationIssue) throw new Error(narrationIssue);
  const root = path.resolve(deps.workRoot || 'data/replication-workbench-finish', digest(`${tenantId}:${projectId}`));
  return withPaidOperationLock(path.join(root, '.locks'), 'finish', async () => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const materials = deps.materials ? await deps.materials() : (await readMaterialLibrary(tenantId)).items;
    const timeline: any[] = [];
    const cues: Cue[] = [];
    const receipts: any[] = [];
    const voiceFiles: string[] = [];
    const narrationContext = continuousNarrationContext(spec);
    const frozenNarration = narrationContext.segments;
    const continuousNarration = narrationContext.continuous;
    const continuousVoiceFiles: Array<{ file: string; start: number; duration: number }> = [];
    let voiceCursor = 0, cursor = 0;
    const language = String(spec.activeVoiceLang || spec.lang || 'en');
    for (const [index, slot] of shots.entries()) {
      const materialId = String(spec.storyboardAssignments?.[slot.slotId] || '');
      const material = materials.find(item => String(item.id) === materialId);
      if (!material || material.type !== 'video' || String(material.tenantId || material.tenant_id || '') !== tenantId || material.scope !== 'own') throw new Error(`第 ${index + 1} 镜缺少本企业真实替换视频`);
      if (/reference|viral-sentence-first-frame|catalog/i.test(String(material.sourceType || '')) || material.usage === 'analysis') throw new Error(`第 ${index + 1} 镜仍是分析参考素材，禁止出片`);
      const production = spec.shotProductions?.[`${spec.activeAssemblyId}:${slot.shotId}`];
      const adopted = production?.candidates?.find((candidate: any) => candidate.id === production.adoptedId && candidate.materialId === materialId);
      const progress = spec.automatedReplicationProgress?.[slot.shotId];
      if (!adopted && !(progress?.adopted === true && progress.materialId === materialId && progress.qualityChecked === true)) throw new Error(`第 ${index + 1} 镜未采用当前替换视频候选`);
      const loaded = await (deps.readMaterial || readTenantMaterialBytes)(material, tenantId);
      const hash = digest(loaded.bytes);
      if (material.contentSha256 && material.contentSha256 !== hash) throw new Error(`第 ${index + 1} 镜素材哈希已变化`);
      if (progress?.videoContentSha256 && progress.videoContentSha256 !== hash) throw new Error(`第 ${index + 1} 镜已质检视频内容已变化`);
      const file = path.join(root, `${hash}.mp4`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, loaded.bytes, { mode: 0o600 });
      const media = await (deps.probe || probe)(file);
      const targetDuration = Number(slot.end) - Number(slot.start);
      const trimStart = slot.kind === 'person' ? 0 : Number(spec.clipEdits?.[slot.slotId]?.trimStart ?? spec.automatedReplicationMaterialMatches?.[slot.slotId]?.trimStart ?? progress?.trimStart ?? 0);
      if (!(targetDuration > 0) || !Number.isFinite(trimStart) || trimStart < 0 || media.duration + .05 < trimStart + targetDuration) throw new Error(`第 ${index + 1} 镜视频短于装配时长，禁止静帧补齐`);
      const base = { index, name: material.name, type: 'video', url: `data:video/mp4;base64,${loaded.bytes.toString('base64')}`, targetStart: cursor, targetDuration, trimStart, trimEnd: trimStart + targetDuration, speed: 1 };
      const narration = String(production?.narration || '').trim();
      if (continuousNarration) {
        timeline.push({ ...base, production: { sound: 'voiceover' } });
        receipts.push({ shotId: slot.shotId, materialId, contentSha256: hash, audioSource: 'continuous_frozen_narration', captionSource: 'timestamped_frozen_script' });
        cursor += targetDuration;
        continue;
      }
      if (!narration && slot.kind === 'nonperson') {
        timeline.push({ ...base, production: { sound: 'silent' } });
        receipts.push({ shotId: slot.shotId, materialId, contentSha256: hash, audioSource: 'intentional_silence', captionSource: 'no_frozen_narration' });
        cursor += targetDuration;
        continue;
      }
      if (slot.kind === 'person') {
        const adoption = spec.digitalHumanAssemblyAdoptions?.[`${spec.activeAssemblyId}:${slot.shotId}`];
        if (!adoption?.executionId || adoption.materialId !== materialId || adoption.candidateContentSha256 !== hash) throw new Error(`第 ${index + 1} 镜缺少当前数字人执行装配凭据`);
        if (shotFingerprint(production, String(slot.fingerprintContext || spec.shotProductionContext || ''), slot.shotId) !== adoption.fingerprint) throw new Error(`第 ${index + 1} 镜采用后参数已变化，请重新生成并采用当前版本`);
        const proof = { tenantId, projectId, assemblyId: String(spec.activeAssemblyId), shotId: slot.shotId, materialId, contentSha256: hash, adoption };
        if (deps.verifyPersonAdoption) await deps.verifyPersonAdoption(proof);
        else {
          const execution = await store.getById<any>('studio_digital_human_executions', adoption.executionId);
          const payload = execution?.payload;
          if (!execution || execution.tenant_id !== tenantId || execution.project_id !== projectId || payload?.state !== 'completed'
            || payload.assemblyId !== proof.assemblyId || payload.shotId !== slot.shotId || payload.materialId !== materialId
            || payload.candidateOutput?.contentSha256 !== hash || payload.adoption?.materialId !== materialId
            || payload.fingerprint !== adoption.fingerprint || digitalHumanQualityState(payload.quality?.checks || []) !== 'accepted') throw new Error(`第 ${index + 1} 镜数字人执行质量或版本凭据失效`);
        }
        const tasks = material.providerTaskId ? [material.providerTaskId] : material.providerTaskIds;
        if ((narration && !media.hasAudio) || !Array.isArray(tasks) || !tasks.length || !['digital-human-sentence-video', 'viral-sentence-replication'].includes(String(material.sourceType))) throw new Error(`第 ${index + 1} 镜缺少真实数字人原声音轨或供应商凭据`);
        if (!narration) {
          timeline.push({ ...base, production: { sound: 'silent' } });
          receipts.push({ shotId: slot.shotId, materialId, contentSha256: hash, providerTaskIds: tasks, executionId: adoption.executionId, audioSource: 'intentional_silence', captionSource: 'no_frozen_narration' });
          cursor += targetDuration;
          continue;
        }
        const captionFile = path.join(root, `${hash}.captions.json`);
        let measured: Awaited<ReturnType<typeof measureAvatarSourceCaptions>>;
        if (fs.existsSync(captionFile)) measured = JSON.parse(fs.readFileSync(captionFile, 'utf8'));
        else {
          await (deps.reserveAsr || (id => studioPaidBudget.reserve('qwen_asr', id, undefined, tenantId)))(`replication-finish:${tenantId}:${projectId}:${hash}`);
          measured = await (deps.captions || measureAvatarSourceCaptions)({ ...material, duration: media.duration }, tenantId, loaded.bytes);
          if (measured.sourceHash !== hash || !measured.cues.length) throw new Error(`第 ${index + 1} 镜原声字幕缺少实测绑定`);
          fs.writeFileSync(captionFile, JSON.stringify(measured), { mode: 0o600 });
        }
        if (measured.sourceHash !== hash || !measured.provenance || !measured.cues.length) throw new Error('人物原声字幕缓存与视频不符');
        const expectedSpeech = normalizedSpeech(String(production?.narration || ''));
        if (!expectedSpeech || normalizedSpeech(measured.transcript) !== expectedSpeech) throw new Error(`第 ${index + 1} 镜实测人物口播与冻结脚本不一致，请修复生成或转写`);
        if (measured.cues.some(cue => cue.end > targetDuration + .05)) throw new Error(`第 ${index + 1} 镜裁切会截断人物口播，需重新规划时长`);
        cues.push(...measured.cues.map(cue => ({ start: cursor + cue.start, end: cursor + cue.end, text: cue.text })));
        timeline.push({ ...base, production: { sound: 'source' } });
        receipts.push({ shotId: slot.shotId, materialId, contentSha256: hash, providerTaskIds: tasks, executionId: adoption.executionId, audioSource: 'generated_video', captionSource: measured.provenance });
      } else {
        const voiceKey = digest(JSON.stringify({ tenantId, projectId, slot: slot.shotId, narration, language, voice: spec.voice || 'v1' }));
        const voiceReceipt = path.join(root, `${voiceKey}.voice.json`);
        let voice: Awaited<ReturnType<typeof synthesizeStudioVoiceForAutomation>> & { audioSha256?: string };
        if (fs.existsSync(voiceReceipt)) voice = JSON.parse(fs.readFileSync(voiceReceipt, 'utf8'));
        else {
          // Reserve an intent before TTS. An interrupted request is reconciled instead of charged again.
          const intent = path.join(root, `${voiceKey}.intent`);
          if (fs.existsSync(intent)) throw new Error(`第 ${index + 1} 镜配音请求状态未知，请核对原请求，禁止重复计费`);
          fs.writeFileSync(intent, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
          voice = await (deps.synthesize || synthesizeStudioVoiceForAutomation)({ tenantId, text: narration, language, voice: String(spec.voice || 'v1'), targetDuration, sentenceLines: [narration], measuredSentenceTiming: true });
          if (!voice.ok) {
            fs.unlinkSync(intent);
            throw new Error(`第 ${index + 1} 镜配音服务已明确失败：${voice.error || '未返回有效音频'}`);
          }
          if (!voice.ok || !voice.localPath || !voice.duration || !voice.cues?.length || voice.text !== narration || voice.alignmentSource !== 'synthesized_sentence_audio' || voice.qualityReport?.passed !== true) throw new Error(`第 ${index + 1} 镜配音未通过真实声音与实测对齐检查：${voice.error || '缺少证据'}`);
          voice.audioSha256 = digest(fs.readFileSync(voice.localPath));
          fs.writeFileSync(voiceReceipt, JSON.stringify(voice), { mode: 0o600 });
          fs.unlinkSync(intent);
        }
        if (!voice.localPath || !fs.existsSync(voice.localPath) || !voice.duration || !voice.cues?.length || voice.text !== narration || voice.qualityReport?.passed !== true || voice.alignmentSource !== 'synthesized_sentence_audio') throw new Error(`第 ${index + 1} 镜实测配音缓存无效`);
        if (!voice.audioSha256 || digest(fs.readFileSync(voice.localPath)) !== voice.audioSha256) throw new Error(`第 ${index + 1} 镜配音文件版本已变化`);
        if (voice.duration > targetDuration + .01) throw new Error(`第 ${index + 1} 镜实测口播 ${voice.duration.toFixed(2)} 秒超过镜头 ${targetDuration.toFixed(2)} 秒，禁止自动加速或截断`);
        cues.push(...voice.cues.map(cue => ({ start: cursor + cue.start, end: cursor + cue.end, text: cue.text })));
        timeline.push({ ...base, production: { sound: 'voiceover' }, voiceAligned: true, voiceStart: voiceCursor, voiceEnd: voiceCursor + voice.duration });
        voiceFiles.push(voice.localPath); voiceCursor += voice.duration;
        receipts.push({ shotId: slot.shotId, materialId, contentSha256: hash, audioSource: voice.source, audioSha256: voice.audioSha256, captionSource: voice.alignmentSource });
      }
      cursor += targetDuration;
    }
    if (continuousNarration) {
      for (const [index, segment] of frozenNarration.entries()) {
        const targetDuration = segment.end - segment.start;
        const { voice } = await ensureContinuousNarrationVoice({ tenantId, projectId, spec, root,
          segmentIndex: index, synthesize: deps.synthesize });
        cues.push(...voice.cues.map(cue => ({ start: segment.start + cue.start, end: segment.start + cue.end, text: cue.text })));
        continuousVoiceFiles.push({ file: voice.localPath, start: segment.start, duration: voice.duration });
        receipts.push({ narrationSegment: index + 1, start: segment.start, end: segment.end, audioSource: voice.source,
          audioSha256: voice.audioSha256, captionSource: voice.alignmentSource });
      }
    }
    const subtitles = paginateAlignedCues(cues, cursor);
    if (!subtitles || !subtitleCuesAreSafe(subtitles, cursor)) throw new Error('最终字幕缺少有效的实测音频时间轴');
    let voiceover: { url: string } | undefined;
    if (continuousVoiceFiles.length) {
      const voicePath = path.join(root, `voice-track-${digest(JSON.stringify(continuousVoiceFiles.map(item => ({ hash: digest(fs.readFileSync(item.file)), start: item.start, duration: item.duration }))))}.wav`);
      if (!fs.existsSync(voicePath)) {
        const labels = continuousVoiceFiles.map((_, index) => `voice${index}`);
        const filters = continuousVoiceFiles.map((item, index) => `[${index}:a]adelay=${Math.round(item.start * 1000)}:all=1,apad,atrim=duration=${cursor.toFixed(3)},aformat=sample_rates=24000:channel_layouts=mono[${labels[index]}]`);
        filters.push(`${labels.map(label => `[${label}]`).join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,atrim=duration=${cursor.toFixed(3)}[out]`);
        await run(String(ffmpeg || 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...continuousVoiceFiles.flatMap(item => ['-i', item.file]),
          '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-y', voicePath], { timeout: 120_000 });
      }
      voiceover = { url: `data:audio/wav;base64,${fs.readFileSync(voicePath).toString('base64')}` };
    } else if (voiceFiles.length) {
      const voicePath = path.join(root, `voice-${digest(voiceFiles.join(':'))}.wav`);
      if (!fs.existsSync(voicePath)) await run(String(ffmpeg || 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...voiceFiles.flatMap(file => ['-i', file]), '-filter_complex', voiceFiles.map((_, i) => `[${i}:a]`).join('') + `concat=n=${voiceFiles.length}:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'pcm_s16le', '-y', voicePath], { timeout: 120_000 });
      voiceover = { url: `data:audio/wav;base64,${fs.readFileSync(voicePath).toString('base64')}` };
    }
    const fingerprint = digest(JSON.stringify({ receipts, subtitles, ratio: spec.ratio, duration: cursor }));
    const outputDir = path.resolve('data/publishing-uploads', tenantId.replace(/[^\w.-]+/g, '-'));
    fs.mkdirSync(outputDir, { recursive: true });
    const result = await (deps.render || composite)({ jobId: `replication-${fingerprint.slice(0, 24)}`, requireVisualAssets: true,
      spec: { ratio: spec.ratio || '9:16', resolution: spec.exportSpec?.resolution || '1080p', duration: cursor, language, voiceVol: 100, bgmVol: 0 }, timeline, voiceover,
      subtitles: { mode: 'target', cues: subtitles, style: spec.subtitleStyle || {} } }, undefined, outputDir);
    if (!result.ok || !result.outputPath || !fs.existsSync(result.outputPath)) throw new Error(`逐镜成片合成失败：${result.error || '无输出文件'}`);
    const visuals = await (deps.visuals || inspectRenderedVisuals)({ outputPath: result.outputPath, expectedDuration: cursor, expectedUniqueScenes: Math.min(2, shots.length), minSharpFrameRatio: .5, evidenceDir: path.join(outputDir, `${fingerprint}-quality`) });
    let sceneCursor = 0;
    const scenes = await (deps.scenes || inspectRenderedScenes)({ outputPath: result.outputPath, requireDistinct: false, scenes: timeline.map(item => { const start = sceneCursor; sceneCursor += item.targetDuration; return { start, end: sceneCursor }; }) });
    if (!visuals.passed || !scenes.passed) throw Object.assign(new Error(`逐镜成片自动质检失败：${[...visuals.failures, ...scenes.issues.map(issue => issue.reason)].join('；')}`), { code: 'FINAL_VIDEO_QA_FAILED' });
    const finished = await (deps.finish || finishContent)(result.outputPath, { ...spec, duration: cursor, bgm: null, bgmVol: 0 });
    return { ...finished, duration: cursor, renderOutputPath: result.outputPath, activeStepId: 'preview', subtitlesOn: true, subMode: 'target', alignedCuesByLang: { ...(spec.alignedCuesByLang || {}), [language]: subtitles }, subtitleAlignmentSource: 'replication_measured_audio',
      automatedReplicationFinish: { fingerprint, receipts, outputContentSha256: digest(fs.readFileSync(result.outputPath)), audioPolicy: 'generated_person_source_and_measured_nonperson_tts', checkedAt: new Date().toISOString() },
      automation: { ...spec.automation, stage: 'completed', status: 'ready_for_approval', approvalState: 'ready_for_approval', blocker: '', renderOutputPath: result.outputPath, completedAt: new Date().toISOString(), quality: { passed: true, ruleVersion: CONTENT_SCRIPT_QUALITY_RULE_VERSION, checks: { perShotReplication: true, actualVideoBound: true, voiceAndSubtitles: true, visualContent: true }, visualMetrics: visuals.metrics, evidenceFrames: visuals.evidenceFrames, sceneDiagnostics: scenes, outputBytes: fs.statSync(result.outputPath).size } } };
  }, {
    // A local hot restart is recoverable only when no provider intent remains.
    // If a request might have reached a paid supplier, the lock stays closed
    // and requires receipt reconciliation instead of a duplicate submission.
    recoverDeadOwner: () => !fs.readdirSync(root).some(name => name.endsWith('.intent')),
  });
}
