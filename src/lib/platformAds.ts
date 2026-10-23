import { authHeader } from './auth';
import type { AdManagement, AdAuthorization, AdProposal, AdSourceContext } from './platformAdsDomain';
export type { AdAuthorization } from './platformAdsDomain';

export type PlatformAdTask = AdManagement & {
  id: string; name: string; video: string; goal: string; market: string; budget: number;
  currency: 'USD' | 'CNY'; channels: string[]; status: 'draft' | 'paused' | 'active' | 'error' | 'unknown'; createdAt: string; updatedAt: string;
  version?: number;
  proposal?: AdProposal;
  authorization?: AdAuthorization | null;
  sourceContext?: AdSourceContext;
};
type TaskInput = Pick<PlatformAdTask, 'name' | 'video' | 'goal' | 'market' | 'channels'> & { currency?: PlatformAdTask['currency']; budget: string | number; configuration?: AdManagement['configuration']; expectedVersion?: number };

export async function platformAdsRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/overseas/platform-ads${path}`, {
    ...options,
    headers: { ...authHeader(), ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...(options?.headers || {}) },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || '投放服务请求失败');
  return body;
}
const request = platformAdsRequest;

export const platformAdsApi = {
  getTask: async (id: string) => (await request<{ task: PlatformAdTask }>(`/tasks/${encodeURIComponent(id)}`)).task,
  listTasks: async () => (await request<{ items: PlatformAdTask[] }>('/tasks')).items,
  createTask: async (input: TaskInput) =>
    (await request<{ task: PlatformAdTask }>('/tasks', { method: 'POST', body: JSON.stringify(input) })).task,
  updateTask: async (id: string, input: TaskInput) =>
    (await request<{ task: PlatformAdTask }>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })).task,
  generatePlan: async (input: TaskInput & { entry: 'ai_assisted' | 'ai_managed' }) =>
    (await request<{ task: PlatformAdTask }>('/tasks/ai-plan', { method: 'POST', body: JSON.stringify(input) })).task,
  setManagement: async (id: string, input: { expectedVersion: number; managementMode: AdManagement['managementMode']; authorization?: AdAuthorization }) =>
    (await request<{ task: PlatformAdTask }>(`/tasks/${encodeURIComponent(id)}/management`, { method: 'POST', body: JSON.stringify(input) })).task,
};
