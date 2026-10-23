import { normalizePresenterAudio } from './presenterVideo.js';
import type { PresenterLook, PresenterPage, PresenterVoice } from '../../src/lib/presenterAssets.js';

export function mediaUrl(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function presenterLook(value: any): PresenterLook {
  if (!value || typeof value.id !== 'string') throw new Error('人物接口未返回有效形象');
  const w = Number(value.image_width), h = Number(value.image_height);
  const tags = Array.isArray(value.tags) ? value.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean).slice(0, 30) : [];
  return { id: value.id, name: String(value.name || '企业人物'), groupId: value.group_id || undefined,
    avatarType: ['digital_twin', 'photo_avatar', 'studio_avatar'].includes(value.avatar_type) ? value.avatar_type : undefined,
    voiceId: value.default_voice_id || undefined, imageUrl: mediaUrl(value.preview_image_url), videoUrl: mediaUrl(value.preview_video_url),
    gender: String(value.gender || '').trim().toLowerCase() || undefined,
    ethnicity: String(value.ethnicity || value.race || value.appearance || '').trim().toLowerCase() || undefined,
    tags,
    favorite: value.is_favorite === true || value.favorite === true || value.favorited === true || tags.some((tag: string) => /^(favorite|favourite|收藏)$/i.test(tag)),
    orientation: w > 0 && h > 0 ? (w === h ? 'square' : w > h ? 'landscape' : 'portrait') : 'unknown', status: value.status || 'completed' };
}

export function asianPresenterLook(look: PresenterLook): boolean {
  return /(?:^|[ _-])(asian|east[ _-]?asian|chinese|japanese|korean)(?:$|[ _-])|亚洲|东亚|中国|日本|韩国/i.test([look.ethnicity, ...(look.tags || [])].filter(Boolean).join(' '));
}

export class HeyGenRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly definitive: boolean) {
    super(message);
    this.name = 'HeyGenRequestError';
  }
}

function providerErrorMessage(result: any): string {
  const candidate = [result?.error?.message, result?.error?.detail, result?.message, result?.detail]
    .find(value => typeof value === 'string' && value.trim());
  if (!candidate) return '';
  const clean = candidate.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 240);
  // Do not surface upstream identifiers, URLs, keys, or opaque debug dumps.
  if (/https?:\/\/|api[_ -]?key|authorization|bearer|stack|traceback|[A-Za-z0-9_-]{48,}/i.test(clean)) return '';
  return clean;
}

/** Defaults to public assets. Private catalogs require an explicit tenant binding in the router. */
export class HeyGenPresenterClient {
  constructor(private key: string, private transport: typeof fetch = fetch) {}
  async call(route: string, body?: unknown, requestId?: string, timeoutMs = 60000): Promise<any> {
    if (!this.key) throw new Error('管理员尚未配置 HeyGen 服务密钥');
    const form = body instanceof FormData;
    const readOnly = body === undefined;
    let response: Response | undefined;
    for (let attempt = 0; attempt < (readOnly ? 3 : 1); attempt += 1) {
      try {
        response = await this.transport(`https://api.heygen.com/v3/${route}`, {
          method: readOnly ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'x-api-key': this.key, ...(!form ? { 'Content-Type': 'application/json' } : {}), ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
          ...(readOnly ? {} : { body: form ? body : JSON.stringify(body) }),
        });
        if (!readOnly || ![502, 503, 504].includes(response.status) || attempt === 2) break;
      } catch (error) {
        if (attempt < 2 && readOnly) {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error(route === 'assets' ? 'HeyGen 素材上传超时，请保持文件不变后重试' : 'HeyGen 请求超时，请稍后刷新原任务');
        throw new Error('HeyGen 网络连接失败，请稍后刷新原任务');
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!response) throw new Error('HeyGen 网络连接失败，请稍后刷新原任务');
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error) {
      const upstream = providerErrorMessage(result);
      const hint = response.status === 401 ? '密钥无效或已过期' : response.status === 403 ? '当前账号未开通此接口权限' : response.status === 429 ? '调用频率受限，请稍后刷新' : upstream || '请求未被受理，请检查素材是否符合官方要求';
      throw new HeyGenRequestError(`HeyGen ${response.status}：${hint}`, response.status, response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429);
    }
    if (!result || !('data' in result)) throw new Error('HeyGen 返回结果不完整，请刷新原任务核实');
    return result;
  }
  async looks(token = '', ownership: 'public' | 'private' = 'public'): Promise<PresenterPage<PresenterLook>> {
    const result = await this.call(`avatars/looks?ownership=${ownership}&limit=50${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    if (!Array.isArray(result.data)) throw new Error('人物列表格式异常');
    return { items: result.data.map(presenterLook), nextToken: result.has_more ? String(result.next_token || '') : '' };
  }
  async voices(token = '', language = '', scope: 'public' | 'private' = 'public'): Promise<PresenterPage<PresenterVoice>> {
    const result = await this.call(`voices?type=${scope}&limit=100${token ? `&token=${encodeURIComponent(token)}` : ''}${language ? `&language=${encodeURIComponent(language)}` : ''}`);
    if (!Array.isArray(result.data)) throw new Error('声音列表格式异常');
    return { items: result.data.map((v: any) => ({ id: String(v.voice_id), name: String(v.name), language: String(v.language || ''), previewUrl: mediaUrl(v.preview_audio_url) })), nextToken: result.has_more ? String(result.next_token || '') : '' };
  }
  async voice(id: string): Promise<{ id: string; name: string; language: string; status: string; previewUrl?: string; type: string }> {
    const result = await this.call(`voices/${encodeURIComponent(id)}`);
    const voice = result.data || {};
    return { id: String(voice.voice_id || ''), name: String(voice.name || ''), language: String(voice.language || ''), status: String(voice.status || ''), previewUrl: mediaUrl(voice.preview_audio_url), type: String(voice.type || '') };
  }
  async cloneVoice(name: string, bytes: Buffer, mime: string, language: string, requestId: string): Promise<string[]> {
    const mp3 = await normalizePresenterAudio(bytes);
    const result = await this.call('voices/clone', { voice_name: name, audio: { type: 'base64', media_type: 'audio/mpeg', data: mp3.toString('base64') }, ...(language ? { language } : {}) }, requestId);
    const ids = [...new Set([
      result.data?.voice_clone_id,
      ...(Array.isArray(result.data?.voice_clone_ids) ? result.data.voice_clone_ids : []),
      ...(Array.isArray(result.data?.voices) ? result.data.voices.map((voice: any) => voice?.voice_id || voice?.id) : []),
    ].map(value => String(value || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('HeyGen 已受理录音但未返回音色任务 ID，请核查原任务');
    return ids;
  }
  async upload(bytes: Buffer, mime: string, requestId: string, onStage?: (stage: string, remoteAssetId?: string) => Promise<void>): Promise<string> {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[mime];
    if (!ext || !bytes.length || bytes.length > 200 * 1024 * 1024) throw new Error('请上传 200MB 以内的 JPG、PNG、MP4、MOV 或 WebM 文件');
    if (bytes.length > 32 * 1024 * 1024) {
      await onStage?.('preparing_direct_upload');
      const init = (await this.call('assets/direct-uploads', { filename: `presenter.${ext}`, content_type: mime, size_bytes: bytes.length }, requestId)).data;
      const url = mediaUrl(init?.upload_url);
      if (!init?.asset_id || !url || !/(^|\.)(amazonaws\.com|heygen\.ai|heygen\.com|storage\.googleapis\.com|blob\.core\.windows\.net)$/.test(new URL(url).hostname)) throw new Error('供应商直传地址无效，未发送素材');
      const headers = init.upload_headers && typeof init.upload_headers === 'object' ? init.upload_headers : {};
      if (Object.keys(headers).some(key => ['x-api-key', 'authorization', 'cookie'].includes(key.toLowerCase()))) throw new Error('供应商直传头无效');
      await onStage?.('uploading_to_provider', String(init.asset_id));
      const response = await this.transport(url, { method: 'PUT', headers, body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('人物素材直传未完成，请核对原上传');
      await onStage?.('confirming_upload', String(init.asset_id));
      const completed = await this.call(`assets/${encodeURIComponent(init.asset_id)}/complete`, {}, `${requestId}:complete`);
      if (completed.data?.asset_id !== init.asset_id) throw new Error('供应商素材尚未完成登记');
      return String(init.asset_id);
    }
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `presenter.${ext}`);
    await onStage?.('uploading_to_provider');
    const result = await this.call('assets', form, requestId, 180000);
    if (!result.data?.asset_id) throw new Error('素材上传结果未知，请重新选择文件');
    return String(result.data.asset_id);
  }
  async create(type: 'photo' | 'digital_twin', name: string, assetId: string, requestId: string, groupId?: string) {
    return (await this.call('avatars', { type, name, file: { type: 'asset_id', asset_id: assetId }, ...(groupId ? { avatar_group_id: groupId } : {}) }, requestId)).data;
  }
  async group(id: string) { return (await this.call(`avatars/${encodeURIComponent(id)}`)).data; }
  async look(id: string) { return presenterLook((await this.call(`avatars/looks/${encodeURIComponent(id)}`)).data); }
  async groupLooks(id: string): Promise<PresenterLook[]> {
    const result = await this.call(`avatars/looks?group_id=${encodeURIComponent(id)}&limit=50`);
    if (!Array.isArray(result.data)) throw new Error('人物形象列表格式异常');
    return result.data.map(presenterLook);
  }
  async consent(groupId: string, requestId: string, assetId?: string, rerouteUrl?: string) {
    return (await this.call(`avatars/${encodeURIComponent(groupId)}/consent`, assetId
      ? { consent_video: { type: 'asset_id', asset_id: assetId } }
      : { ...(rerouteUrl ? { reroute_url: rerouteUrl } : {}) }, requestId)).data;
  }
}
