/** HeyGen v3 adapter. Never retries a generation with a different idempotency key. */
export interface HeyGenInput { avatarId: string; voiceId: string; script: string; engine?: 'avatar_iv'; ratio: string; transparent: boolean; title: string; imageAssetId?: string; imageUrl?: string; audioAssetId?: string; audioRef?: { url: string; start: number; duration: number } }
export class HeyGenRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(`HeyGen ${status}: ${code}${message ? ` (${message.slice(0, 180)})` : ''}`);
  }
}
export class HeyGenClient {
  constructor(private key: string, private transport: typeof fetch = fetch, private paidSubmission?: {beforeSubmit(request:Record<string,unknown>,requestId:string):Promise<void>;onAccepted(taskId:string,requestId:string,receipt?:Record<string,unknown>):Promise<void>;onStatus?(taskId:string,receipt:Record<string,unknown>):Promise<void>}) {}
  private async call(path: string, body?: unknown, requestId?: string) {
    if (!this.key) throw new Error('尚未配置 HEYGEN_API_KEY');
    const response = await this.transport(`https://api.heygen.com/v3/videos${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'x-api-key': this.key, 'Content-Type': 'application/json', ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as { data?: Record<string, any>; error?: { code?: string; message?: string } };
    if (!response.ok || value.error) throw new HeyGenRequestError(response.status, value.error?.code || 'request_failed', value.error?.message);
    if (!value.data) throw new Error('HeyGen未返回有效任务数据');
    return value.data;
  }
  async create(input: HeyGenInput, requestId: string): Promise<string> {
    if ((!input.avatarId && !input.imageAssetId && !input.imageUrl) || (!input.audioAssetId && (!input.voiceId || !input.script.trim()))) throw new Error('数字人、声音和台词不能为空');
    if (input.audioAssetId && (input.script.trim() || input.voiceId)) throw new Error('HeyGen音频模式不能同时指定台词或声音');
    if (input.engine && input.engine !== 'avatar_iv') throw new Error('HeyGen受控音频镜头仅允许Avatar IV');
    const image = input.imageAssetId ? { type: 'asset_id', asset_id: input.imageAssetId } : input.imageUrl ? { type: 'url', url: input.imageUrl } : null;
    const request = { ...(image ? { type: 'image', image } : { type: 'avatar', avatar_id: input.avatarId }), ...(input.audioAssetId ? { audio_asset_id: input.audioAssetId } : { voice_id: input.voiceId, script: input.script }),
      ...(!image && input.engine ? { engine: { type: input.engine } } : {}), aspect_ratio: input.ratio, resolution: '720p', title: input.title, output_format: input.transparent ? 'webm' : 'mp4' };
    await this.paidSubmission?.beforeSubmit(structuredClone(request),requestId);
    const data=await this.call('',request,requestId);
    if (typeof data.video_id !== 'string') throw new Error('提交结果未知：未返回video_id，请检查供应商任务，不要重复付费提交');
    await this.paidSubmission?.onAccepted(data.video_id,requestId,structuredClone(data));
    return data.video_id;
  }
  async uploadImage(bytes: Uint8Array, mimeType: string, requestId: string): Promise<string> {
    if (!this.key || !bytes.length || bytes.length > 32 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('人物图片格式无效或超过32MB');
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === 'image/png' ? 'presenter.png' : mimeType === 'image/webp' ? 'presenter.webp' : 'presenter.jpg');
    const response = await this.transport('https://api.heygen.com/v3/assets', { method: 'POST', body: form, signal: AbortSignal.timeout(45000), headers: { 'x-api-key': this.key, 'Idempotency-Key': requestId } });
    const value = await response.json().catch(() => ({})) as { data?: { asset_id?: string } };
    if (!response.ok || !value.data?.asset_id) throw new Error(`HeyGen人物图片上传失败 (${response.status})`);
    return value.data.asset_id;
  }
  async uploadAudio(bytes: Uint8Array, requestId: string, mimeType: 'audio/wav' | 'audio/mpeg' = 'audio/wav'): Promise<string> {
    if (!this.key || !bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('音频不可用或超过32MB');
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === 'audio/mpeg' ? 'shot.mp3' : 'shot.wav');
    const response = await this.transport('https://api.heygen.com/v3/assets', { method: 'POST', body: form, signal: AbortSignal.timeout(45000), headers: { 'x-api-key': this.key, 'Idempotency-Key': requestId } });
    const value = await response.json() as { data?: { asset_id?: string } };
    if (!response.ok || !value.data?.asset_id) throw new Error(`HeyGen音频上传失败 (${response.status})`);
    return value.data.asset_id;
  }
  async status(id: string): Promise<{ status: 'pending' | 'completed' | 'failed'; url?: string; duration?: number; error?: string }> {
    const data = await this.call(`/${encodeURIComponent(id)}`);
    await this.paidSubmission?.onStatus?.(id,structuredClone(data));
    if (data.status === 'completed') {
      if (typeof data.video_url !== 'string' || !(Number(data.duration) > 0)) throw new Error('生成完成但缺少可用视频或时长');
      return { status: 'completed', url: data.video_url, duration: Number(data.duration) };
    }
    if (data.status === 'failed') return { status: 'failed', error: String(data.failure_code || '供应商生成失败') };
    return { status: 'pending' };
  }
}
