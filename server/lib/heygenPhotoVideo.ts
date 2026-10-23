import { HeyGenClient, HeyGenRequestError } from './heygen.js';
import { studioPaidBudget } from './studioPaidBudget.js';

/** The exact image is uploaded; no avatar-training step or fallback to a different identity. */
export async function generateHeyGenPhotoVideo(input: {
  bytes: Uint8Array; mimeType: string; voiceId: string; script: string; ratio: string; requestId: string; tenantId?: string;
  onSubmitted?: (id: string) => Promise<void> | void; client?: HeyGenClient;
  reserve?: (operationId: string) => Promise<void>; reserveCny?: number; pollMs?: number; timeoutMs?: number; existingTaskId?: string;
}): Promise<{ taskId: string; videoUrl: string; duration: number }> {
  if (!input.voiceId.trim() || !input.script.trim()) throw new Error('请选择口播声音并确认台词');
  if (!['9:16', '16:9', '1:1'].includes(input.ratio)) throw new Error('照片口播画幅无效');
  const client = input.client || new HeyGenClient(process.env.HEYGEN_API_KEY || '');
  let taskId: string;
  if (input.existingTaskId) taskId = input.existingTaskId;
  else {
    await (input.reserve || (id => studioPaidBudget.reserve('heygen', id, input.reserveCny, input.tenantId)))(input.requestId);
    const imageAssetId = await client.uploadImage(input.bytes, input.mimeType, `${input.requestId}:image`);
    try {
      taskId = await client.create({ avatarId: '', imageAssetId, voiceId: input.voiceId, script: input.script,
        ratio: input.ratio, transparent: false, title: '灵枢照片口播' }, input.requestId);
    } catch (error) {
      if (error instanceof HeyGenRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        if (!input.reserve) await studioPaidBudget.releaseRejected('heygen', input.requestId, input.tenantId);
        throw new Error(`HeyGen 照片口播明确拒绝（请求 ${input.requestId}）：${error.message}；未创建视频任务`);
      }
      throw new Error(`HeyGen 照片口播提交结果未知（请求 ${input.requestId}）：${error instanceof Error ? error.message : String(error)}；请核对原请求，不要重复提交`);
    }
    await input.onSubmitted?.(taskId);
  }
  const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    let result: Awaited<ReturnType<HeyGenClient['status']>>;
    try { result = await client.status(taskId); }
    catch (error) { throw new Error(`HeyGen 照片口播状态查询未知（任务 ${taskId}）：${error instanceof Error ? error.message : String(error)}；请刷新原任务，不要重新提交`); }
    if (result.status === 'completed' && result.url && result.duration) return { taskId, videoUrl: result.url, duration: result.duration };
    if (result.status === 'failed') throw new Error(`HeyGen任务明确失败：${result.error || '供应商生成失败'}`);
    await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 30_000));
  }
  throw new Error(`HeyGen照片口播仍在处理，任务 ${taskId} 已留档；请查询原任务，不要重复提交`);
}
