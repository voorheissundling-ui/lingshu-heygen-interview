import type { TaskWaitKind, TaskWaitState } from '../../src/lib/taskExecutionState.js';
type RecordData = Record<string, unknown>;
export function object(value: unknown): RecordData {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
}
export const waitState = (kind: TaskWaitKind, message: string): TaskWaitState => ({ kind, message, requiresAttention: ['input', 'service', 'approval', 'manual'].includes(kind) });
export function workflowStatusForWait(state: TaskWaitState): 'waiting_external' | 'waiting_approval' | 'waiting_human' {
  if (state.kind === 'approval') return 'waiting_approval';
  if (state.kind === 'input' || state.kind === 'manual') return 'waiting_human';
  return 'waiting_external';
}
export function collectionWait(jobs: RecordData[], now = Date.now()): TaskWaitState {
  if (!jobs.length) return waitState('input', '尚未找到本任务的采集记录，请检查采集范围与定时任务。');
  const failed = jobs.filter(j => j.status === 'failed');
  if (failed.length) return waitState('service', `${failed.length} 项采集失败，请在采集任务中查看原因并重试。`);
  const running = jobs.filter(j => j.status === 'running');
  if (running.some(j => Date.parse(String(j.leasedUntil || '')) < now)) return waitState('service', '采集执行已超时，等待执行服务恢复或重新领取任务。');
  const queued = jobs.filter(j => j.status === 'queued');
  if (queued.some(j => now - Date.parse(String(j.createdAt || j.created || '')) > 5 * 60_000)) return waitState('service', '采集任务超过 5 分钟未被领取，请检查采集执行服务。');
  if (queued.length || running.length) return waitState(running.length ? 'processing' : 'queued', `采集中：${running.length} 项执行中，${queued.length} 项排队，尚未取得可分析的视频。`);
  return waitState('input', '采集已结束，但本任务没有合格的全片分析结果，请检查采集结果或补充参考视频。');
}
export function postFullyPublished(post: RecordData): boolean {
  const stats = object(post.stats);
  const results = object(stats.publishResults || post.publishResults);
  const targets = Array.isArray(stats.targetAccountIds) ? stats.targetAccountIds.map(String) : [];
  const received = (value: unknown) => { const r = object(value); return r.status === 'published' && Boolean(r.platformPostId || r.platform_post_id); };
  if (targets.length) return targets.every(id => received(results[id]));
  if (Object.keys(results).length) return Object.values(results).every(received);
  return Boolean(String(post.platform_post_id || '').trim()) && stats.status !== 'partial' && stats.status !== 'failed';
}
export function publishingWait(posts: RecordData[], workerEnabled: boolean, now = Date.now()): TaskWaitState {
  if (!posts.length) return waitState('input', '尚无本任务的发布记录，请检查发布审批与日历写入结果。');
  if (posts.some(p => object(p.stats).status === 'needs_attention' || Object.values(object(object(p.stats).publishResults)).some(r => object(r).status === 'unknown'))) return waitState('manual', '平台发布结果不明，请在发布日历核对回执；系统不会自动重复发布。');
  if (posts.some(p => object(p.stats).status === 'finalize_pending')) return waitState('processing', '平台已发布成功，正在补写本地结果，不会重复发布。');
  const pending = posts.filter(p => !postFullyPublished(p));
  if (pending.some(p => ['awaiting_manual_publish', 'awaiting_reapproval'].includes(String(object(p.stats).status)))) return waitState('manual', '发布项等待人工发布或重新审批，请打开发布日历处理。');
  if (pending.some(p => ['failed', 'partial'].includes(String(object(p.stats).status)))) return waitState('service', '部分发布项失败或尚未全部发布，请查看逐账号结果并重试失败项。');
  if (!workerEnabled) return waitState('service', '自动发布服务未启用，已批准的发布项尚未执行。');
  if (pending.length && pending.every(p => Date.parse(String(p.published_at || p.scheduled_at || object(p.stats).scheduledAt || '')) > now)) return waitState('scheduled', '发布项尚未到计划时间，到期后自动执行。');
  return waitState('processing', `正在等待平台回执：${posts.length - pending.length}/${posts.length} 项已完整发布。`);
}
export function followupOutcome(items: RecordData[]): { complete: boolean; settled: boolean; sent: number; blocked: number; failed: number; partial: number } {
  const active = items.filter(i => !['excluded', 'cancelled', 'superseded'].includes(String(i.status)));
  const sent = active.filter(i => ['sent', 'delivered', 'read'].includes(String(i.status)) && Boolean(i.provider_message_id)).length;
  return {
    complete: active.length > 0 && sent === active.length && !active.some(i => object(i.provider_receipt).localHistoryPending),
    settled: active.length > 0 && active.every(i => ['sent', 'delivered', 'read', 'failed', 'partial_sent', 'blocked', 'rejected'].includes(String(i.status))),
    sent,
    blocked: active.filter(i => ['blocked', 'rejected'].includes(String(i.status))).length,
    failed: active.filter(i => i.status === 'failed').length,
    partial: active.filter(i => i.status === 'partial_sent').length,
  };
}
export function followupComplete(items: RecordData[]): boolean { return followupOutcome(items).complete; }
export function followupWait(items: RecordData[], now = Date.now()): TaskWaitState {
  if (items.some(i => object(i.provider_receipt).localHistoryPending)) return waitState('service', '跟进消息已发送，本地客户历史回写失败；系统正在重试本地补写，持续失败时需检查存储，不会重复发送。');
  if (items.some(i => i.exclusion_reason === 'send_outcome_unknown')) return waitState('manual', '跟进发送结果不明，请核对平台回执；自动重发已停止，避免重复联系客户。');
  if (items.some(i => ['blocked', 'rejected', 'partial_sent', 'failed'].includes(String(i.status)))) return waitState('manual', '部分客户跟进被阻断、拒绝或未完整送达，请检查逐客原因；已发送客户不会重复发送。');
  if (items.some(i => ['draft', 'pending_approval'].includes(String(i.status)))) return waitState('approval', '跟进内容需要审批后才能发送。');
  const pending = items.filter(i => ['approved', 'retry_wait'].includes(String(i.status)));
  if (pending.length && pending.every(i => Date.parse(String(i.scheduled_at)) > now)) return waitState('scheduled', '客户跟进尚未到发送时间，到期后重新检查发送条件。');
  return waitState('processing', '正在等待逐客发送和真实平台回执。');
}
export function basicTaskWait(key: string, reason: string): TaskWaitState {
  if (key === 'customer_attribution') return waitState('data', '本轮发布内容尚无可关联的客户来源，等待真实互动或询盘回流。');
  if (key === 'customer_segmentation') return waitState('scheduled', reason || '尚未到客户分层执行时间。');
  if (key === 'followup_batch_draft') return waitState('input', reason || '尚无符合条件的跟进草稿，请检查客群和排除原因。');
  return waitState('input', reason || '缺少完成此任务所需的业务结果，请打开任务查看具体条件。');
}
export function analysisWait(videos: RecordData[], now = Date.now()): TaskWaitState {
  const analyses = videos.map(v => ({video:v,analysis:object(v.aiAnalysis)}));
  const active = analyses.filter(({analysis:a}) => ['queued','running','analyzing','downloading'].some(state => [a.geminiStatus,a.videoFetchStatus,a.downloadStatus,a.crawlerOpsStatus].includes(state)) && a.crawlerOpsStatus !== 'failed');
  if (active.length) {
    const stale = active.every(({video:v}) => { const updated=Date.parse(String(v.updatedAt || v.updated || '')); return Number.isFinite(updated) && now-updated > 30*60_000; });
    return stale ? waitState('service','参考视频处理超过 30 分钟未更新，请检查下载和分析执行服务。') : waitState('processing',`正在下载或分析 ${active.length} 条参考视频，等待合格的全片分析结果。`);
  }
  if (analyses.some(({analysis:a}) => a.analysisError || a.crawlerOpsStatus === 'failed' || a.geminiStatus === 'video_failed')) return waitState('service','参考视频下载或分析失败，请在灵感中心查看失败原因并重试。');
  return waitState('input','已有参考内容，但尚无合格的全片分析结果，请在灵感中心完成精确分析。');
}
export function publishingPlatformsCovered(platforms: string[], items: Array<{platform: string; accountIds: string[]}>): boolean {
  return platforms.length > 0 && platforms.every(platform => items.some(item => item.platform === platform && item.accountIds.length > 0));
}
