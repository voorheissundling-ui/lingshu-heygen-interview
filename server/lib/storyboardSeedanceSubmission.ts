/** Shared supplier boundary for Studio product shots. No Express/auth/startup dependency. */
export async function submitStoryboardSeedance(input: {
  model: string; baseUrl: string; apiKey: string; content: Array<Record<string, unknown>>;
  ratio: string; duration: number; resolution: string; silent: boolean; existingTaskId?: string;
}, ports: {
  assertCurrent: () => Promise<void>;
  prepare: () => Promise<void>;
  accepted: (taskId: string) => Promise<void>;
  request: (url: string, apiKey: string, init: RequestInit) => Promise<any>;
}): Promise<any> {
  await ports.assertCurrent();
  if (input.existingTaskId) return { id: input.existingTaskId };
  if (!input.model || !input.apiKey || !Number.isFinite(input.duration) || input.duration <= 0)
    throw Error('storyboard_seedance_submission_invalid');
  if (input.silent && (!input.content.some(x => x.type === 'image_url' && x.role === 'first_frame')
    || input.content.some(x => x.type === 'video_url' || x.type === 'audio_url')))
    throw Error('storyboard_silent_first_frame_required');
  await ports.prepare(); // durable prepared before network; failures cannot open a new POST.
  await ports.assertCurrent(); // preparation may await locks/reservation; recheck immediately before POST.
  const created = await ports.request(`${input.baseUrl.replace(/\/$/,'')}/contents/generations/tasks`, input.apiKey, {
    method: 'POST', body: JSON.stringify({ model: input.model, content: input.content,
      ratio: input.ratio, duration: input.duration, resolution: input.resolution,
      generate_audio: !input.silent, watermark: false }),
  });
  const id = String(created?.id || created?.data?.id || '').trim();
  if (!id) throw Error('Seedance 未返回任务 ID');
  await ports.accepted(id); // acceptance durable before returning control.
  return created;
}
