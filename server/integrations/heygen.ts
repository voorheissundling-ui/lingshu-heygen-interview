import fs from 'node:fs';
import path from 'node:path';

export const heygenConfigured = () => Boolean(String(process.env.HEYGEN_API_KEY || '').trim());
export const heygenPrivateAvatarsEnabled = () => String(process.env.HEYGEN_PRIVATE_AVATARS_ENABLED || '').trim().toLowerCase() === 'true';
export interface HeyGenAvatar {
  id: string;
  name: string;
  gender?: string;
  ownership: 'private' | 'public';
  avatarType?: string;
  defaultVoiceId?: string;
  status?: string;
}
export async function heygenRequest(route: string, init: RequestInit = {}, idempotencyKey?: string): Promise<any> {
  const key = String(process.env.HEYGEN_API_KEY || '').trim();
  if (!key) throw Error('尚未配置 HeyGen API Key，请在服务端配置 HEYGEN_API_KEY');
  const headers = new Headers(init.headers);
  headers.set('x-api-key', key);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  const response = await fetch(`https://api.heygen.com/v3/${route}`, { ...init, headers, signal: AbortSignal.timeout(60000), redirect: 'error' });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw Error(`HeyGen ${response.status}: ${String(payload.error?.message || '服务请求失败').slice(0, 240)}`);
  return payload;
}
export async function listHeygenAvatars(): Promise<HeyGenAvatar[]> {
  const listOwnership = async (ownership: HeyGenAvatar['ownership']): Promise<HeyGenAvatar[]> => {
    const items: HeyGenAvatar[] = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const result = await heygenRequest(`avatars/looks?ownership=${ownership}&limit=50${token ? '&token=' + encodeURIComponent(token) : ''}`);
      items.push(...(Array.isArray(result.data) ? result.data : [])
        .filter((avatar: any) => !avatar.status || avatar.status === 'completed')
        .map((avatar: any) => ({
          id: String(avatar.id),
          name: String(avatar.name || avatar.id),
          gender: String(avatar.gender || '').toLowerCase() || undefined,
          ownership,
          avatarType: String(avatar.avatar_type || '') || undefined,
          defaultVoiceId: String(avatar.default_voice_id || '') || undefined,
          status: String(avatar.status || '') || undefined,
        })));
      if (!result.has_more || !result.next_token || result.next_token === token) break;
      token = String(result.next_token);
    }
    return items;
  };
  // Private account assets are opt-in because a platform-shared key otherwise exposes
  // the service account's private inventory to every tenant using this deployment.
  const combined = [
    ...(heygenPrivateAvatarsEnabled() ? await listOwnership('private') : []),
    ...await listOwnership('public'),
  ];
  return [...new Map(combined.map(item => [item.id, item])).values()];
}
export async function submitHeygenVideo(input: { id: string; avatarId: string; audioPath: string; title: string }): Promise<string> {
  if (!fs.existsSync(input.audioPath)) throw Error('当前企业的口播音频不存在');
  const bytes = fs.readFileSync(input.audioPath);
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('HeyGen 音频需小于 32MB');
  const form = new FormData();
  const extension = path.extname(input.audioPath).toLowerCase();
  const mime = extension === '.mp3' ? 'audio/mpeg' : extension === '.m4a' ? 'audio/mp4' : 'audio/wav';
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `voiceover${extension || '.wav'}`);
  const upload = await heygenRequest('assets', { method: 'POST', body: form }, `audio:${input.id}`);
  if (!upload.data?.asset_id) throw Error('HeyGen 未返回音频资源 ID');
  const result = await heygenRequest('videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'avatar', avatar_id: input.avatarId, audio_asset_id: upload.data.asset_id, title: input.title, aspect_ratio: '9:16', fit: 'cover', output_format: 'mp4', caption: { file_format: 'srt' } }) }, `video:${input.id}`);
  if (!result.data?.video_id) throw Error('HeyGen 未返回视频任务 ID');
  return String(result.data.video_id);
}
export function safeHeygenOutputUrl(raw: string): string {
  try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'heygen.ai' || url.hostname.endsWith('.heygen.ai') || url.hostname === 'heygen.com' || url.hostname.endsWith('.heygen.com')) ? url.href : ''; } catch { return ''; }
}
export async function downloadHeygenOutput(raw: string): Promise<Buffer> {
  let url = safeHeygenOutputUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (!url) throw Error('HeyGen 返回了不受信任的输出地址');
    // Never forward the HeyGen API key to a media CDN.
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = safeHeygenOutputUrl(new URL(response.headers.get('location') || '', url).href); continue; }
    if (!response.ok || !response.body) throw Error(`HeyGen 成片下载失败 (${response.status})`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any) { size += chunk.length; if (size > 110 * 1024 * 1024) throw Error('HeyGen 成片超过 110MB'); chunks.push(chunk); }
    if (size < 10000) throw Error('HeyGen 成片文件异常');
    return Buffer.concat(chunks);
  }
  throw Error('HeyGen 成片重定向过多');
}

export type HeygenCue = { start: number; end: number; text: string };
export function parseHeygenSubtitles(srt: string, duration: number, spoken: string): HeygenCue[] {
  const time = (value: string) => { const [h, m, s] = value.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + s; };
  const cues: HeygenCue[] = [];
  for (const block of srt.replace(/\r/g, '').trim().split(/\n\s*\n/)) {
    const lines = block.split('\n'); const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const match = lines[index].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) throw Error('HeyGen 字幕时间格式无效');
    const start = time(match[1]), end = time(match[2]);
    let text = lines.slice(index + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    // ASR may contract an unambiguous phrase. Keep the approved spelling.
    if (/\byou are\b/i.test(spoken)) text = text.replace(/\byou['’]re\b/gi, 'you are');
    if (!text || start < 0 || end <= start || end > duration + 0.3 || (cues.length && start < cues.at(-1)!.end - 0.05)) throw Error('HeyGen 字幕时间轴无效');
    cues.push({ start, end: Math.min(end, duration), text });
  }
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!cues.length || normalize(cues.map(cue => cue.text).join('')) !== normalize(spoken)) throw Error('HeyGen 字幕与已确认口播不一致，请复核，不能自动替换口播');
  return cues;
}
export async function downloadHeygenSubtitles(raw: string, duration: number, spoken: string): Promise<HeygenCue[]> {
  let url = safeHeygenOutputUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (!url) throw Error('HeyGen 未提供可信字幕地址');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if ([301,302,303,307,308].includes(response.status)) { url = safeHeygenOutputUrl(new URL(response.headers.get('location') || '', url).href); continue; }
    if (!response.ok || !response.body) throw Error('HeyGen 字幕下载失败');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any) { size += chunk.length; if (size > 1024 * 1024) throw Error('HeyGen 字幕文件过大'); chunks.push(chunk); }
    return parseHeygenSubtitles(Buffer.concat(chunks).toString('utf8'), duration, spoken);
  }
  throw Error('HeyGen 字幕重定向过多');
}
