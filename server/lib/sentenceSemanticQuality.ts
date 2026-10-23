import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import OpenAI from 'openai';
import {qwenCompatibleBaseUrl} from './qwenCompatibleEndpoint.js';

const run = promisify(execFile);
const allowedFrameRefs = new Set(['presenter', ...['source', 'candidate'].flatMap(prefix => ['start', 'quarter', 'middle', 'three_quarters', 'end'].map(position => `${prefix}_${position}`))]);
export type SentenceSemanticDecision = { status: 'pass' | 'fail' | 'unknown'; confidence: number; evidence: string; frameRefs: string[] };
export interface SentenceSemanticQualityReport {
  version: 1;
  model: string;
  identity: SentenceSemanticDecision;
  actionMotion: SentenceSemanticDecision;
  productBrandText: SentenceSemanticDecision;
  limitations: string[];
}

function key(): string {
  const configured = String(process.env.DASHSCOPE_API_KEY || '').trim();
  if (configured) return configured;
  const file = String(process.env.DASHSCOPE_API_KEY_FILE || path.join(os.homedir(), '.config/lingshu/dashscope.key')).trim();
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function decision(value: unknown, name: string): SentenceSemanticDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`语义质检 ${name} 缺少结构化结论`);
  const raw = value as Record<string, unknown>;
  const status = String(raw.status || '');
  const confidence = Number(raw.confidence);
  const evidence = String(raw.evidence || '').trim();
  const frameRefs = Array.isArray(raw.frameRefs) ? [...new Set(raw.frameRefs.map(String))] : [];
  if (!['pass', 'fail', 'unknown'].includes(status) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !evidence) throw new Error(`语义质检 ${name} 结论无效`);
  if (status !== 'unknown' && (!frameRefs.length || frameRefs.some(ref => !allowedFrameRefs.has(ref)))) throw new Error(`语义质检 ${name} 缺少有效帧引用`);
  if (status !== 'unknown') {
    const sourceRefs = frameRefs.filter(ref => ref.startsWith('source_'));
    const candidateRefs = frameRefs.filter(ref => ref.startsWith('candidate_'));
    if (name === 'identity' && (!frameRefs.includes('presenter') || candidateRefs.length < 2)) throw new Error('语义质检 identity 缺少人物原图或跨帧候选证据');
    if (name === 'actionMotion' && (sourceRefs.length < 2 || candidateRefs.length < 2)) throw new Error('语义质检 actionMotion 缺少跨时间原片/候选帧证据');
    if (name === 'productBrandText' && (!sourceRefs.length || !candidateRefs.length)) throw new Error('语义质检 productBrandText 缺少原片/候选对照证据');
  }
  return { status: status as SentenceSemanticDecision['status'], confidence, evidence: evidence.slice(0, 500), frameRefs };
}

export function parseSentenceSemanticQuality(raw: unknown, model: string): SentenceSemanticQualityReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('语义质检没有返回 JSON 对象');
  const value = raw as Record<string, unknown>;
  if (Number(value.version) !== 1) throw new Error('语义质检版本不受支持');
  return { version: 1, model, identity: decision(value.identity, 'identity'), actionMotion: decision(value.actionMotion, 'actionMotion'), productBrandText: decision(value.productBrandText, 'productBrandText'),
    limitations: Array.isArray(value.limitations) ? value.limitations.map(String).map(item => item.trim()).filter(Boolean).slice(0, 8) : [] };
}

export async function sampleSemanticVideoFrames(filePath: string, prefix: 'source' | 'candidate'): Promise<Array<{ label: string; bytes: Buffer }>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lingshu-${prefix}-qa-`));
  try {
    let metadata = '';
    try { const result = await run(String(ffmpegStatic || ''), ['-hide_banner', '-nostdin', '-i', filePath, '-f', 'null', '-'], { timeout: 120_000 }); metadata = String(result.stderr || ''); }
    catch (error) { metadata = String((error as { stderr?: string }).stderr || error); }
    const match = metadata.match(/Duration: (\d+):(\d+):([\d.]+)/); if (!match) throw new Error(`${prefix} 镜头时长不可读`);
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]); if (!(duration > 0)) throw new Error(`${prefix} 镜头时长无效`);
    const samples = [['start', Math.min(.08, duration / 6)], ['quarter', duration / 4], ['middle', duration / 2], ['three_quarters', duration * .75], ['end', Math.max(.08, duration - .08)]] as const;
    const frames: Array<{ label: string; bytes: Buffer }> = [];
    for (const [position, time] of samples) { const output = path.join(dir, `${position}.jpg`); await run(String(ffmpegStatic || ''), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', filePath, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '3', '-y', output], { timeout: 120_000 }); if (fs.existsSync(output) && fs.statSync(output).size > 100) frames.push({ label: `${prefix}_${position}`, bytes: fs.readFileSync(output) }); }
    if (frames.length < 2) throw new Error(`${prefix} 镜头可用采样帧不足`);
    return frames;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function inspectSentenceSemanticQuality(input: {
  presenterBytes: Buffer;
  presenterMimeType: string;
  sourceVideoPath: string;
  candidateVideoPath: string;
  targetText: string;
}): Promise<SentenceSemanticQualityReport> {
  const apiKey = key();
  if (!apiKey) throw new Error('未配置 DASHSCOPE_API_KEY 或 DASHSCOPE_API_KEY_FILE');
  const model = String(process.env.QWEN_DIGITAL_HUMAN_QA_MODEL || 'qwen3-vl-plus').trim();
  const [source, candidate] = await Promise.all([sampleSemanticVideoFrames(input.sourceVideoPath, 'source'), sampleSemanticVideoFrames(input.candidateVideoPath, 'candidate')]);
  const images = [{ label: 'presenter', bytes: input.presenterBytes, mimeType: input.presenterMimeType },
    ...source.map(frame => ({ ...frame, mimeType: 'image/jpeg' })), ...candidate.map(frame => ({ ...frame, mimeType: 'image/jpeg' }))];
  const client = new OpenAI({ apiKey, baseURL: qwenCompatibleBaseUrl(),
    timeout: Math.max(30_000, Number(process.env.QWEN_REQUEST_TIMEOUT_MS || 120_000)), maxRetries: 0 });
  const completion = await client.chat.completions.create({ model, messages: [
    { role: 'system', content: `你是独立的视频候选质检员，不是生成模型。只依据提供的采样帧判断，不推断看不见的事实。presenter 是已授权人物照片；source_* 是参考镜头；candidate_* 是候选镜头。identity 比较 presenter 与 candidate_* 是否为同一人物且跨帧稳定，pass/fail 必须引用 presenter 和至少两幅 candidate_* 帧。actionMotion 比较 source_* 与 candidate_* 中实际可见的姿势、手势、物品交互与动作顺序是否保持，pass/fail 必须各引用至少两幅不同时间的 source_* 和 candidate_* 帧；静态采样无法证明时必须 unknown。productBrandText 比较 source_* 与 candidate_* 中实际可见的产品外形、品牌标识和文字是否保持；源片未出现可识别产品/品牌/文字时必须 unknown。不得用脸部相似度判断授权，不得声称检查了音频或口型。只输出 JSON：{"version":1,"identity":{"status":"pass|fail|unknown","confidence":0.0,"evidence":"具体可见观察","frameRefs":["presenter","candidate_start","candidate_end"]},"actionMotion":{"status":"pass|fail|unknown","confidence":0.0,"evidence":"具体可见的动作比较","frameRefs":["source_start","source_end","candidate_start","candidate_end"]},"productBrandText":{"status":"pass|fail|unknown","confidence":0.0,"evidence":"具体可见观察","frameRefs":["source_middle","candidate_middle"]},"limitations":["限制"]}。pass/fail 必须引用实际标签；遮挡、模糊、采样不足时用 unknown。` },
    { role: 'user', content: [{ type: 'text', text: `目标台词仅供镜头定位，不作为视觉结论：${input.targetText.slice(0, 500)}\n以下图片均带标签。` },
      ...images.flatMap(image => [{ type: 'text', text: image.label }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}` } }]) as any] },
  ], response_format: { type: 'json_object' }, max_tokens: 1200 } as any);
  const content = String(completion.choices[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let raw: unknown; try { raw = JSON.parse(content); } catch { throw new Error('语义质检没有返回合法 JSON'); }
  return parseSentenceSemanticQuality(raw, model);
}
