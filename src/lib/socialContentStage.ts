import { authHeader } from './auth';
import { weeklyTaskPackagePreset, type WeeklyTaskPackagePresetId } from './weeklyTaskPackagePresets';

export type SocialContentStageId = 'b2b_launch' | 'b2b_growth' | 'd2c_brand';

export interface SocialContentStageProfile {
  id: SocialContentStageId;
  name: string;
  originalName: string;
  description: string;
  presetId: WeeklyTaskPackagePresetId;
}

export const SOCIAL_CONTENT_STAGE_PROFILES: SocialContentStageProfile[] = [
  {
    id: 'b2b_launch',
    name: 'B2B 起步验证',
    originalName: 'B2B 无基础',
    description: '还没有稳定的社媒账号或内容节奏，先验证平台、买家问题与基础产能。',
    presetId: 'b2b_starting',
  },
  {
    id: 'b2b_growth',
    name: 'B2B 增长进阶',
    originalName: 'B2B 有基础',
    description: '已经有账号或历史内容，复盘有效路线并持续放大高质量询盘。',
    presetId: 'b2b_growing',
  },
  {
    id: 'd2c_brand',
    name: 'D2C 品牌增长',
    originalName: 'D2C 品牌营销',
    description: '面向消费者经营品牌，用产品演示、使用场景与购买路径推动增长。',
    presetId: 'dtc_sales',
  },
];

const STORAGE_KEY = 'lingshu:social-content-stage';

export function socialContentStageProfile(id: unknown): SocialContentStageProfile | null {
  return SOCIAL_CONTENT_STAGE_PROFILES.find((profile) => profile.id === id) || null;
}

export function readSocialContentStage(): SocialContentStageProfile | null {
  if (typeof window === 'undefined') return null;
  try { return socialContentStageProfile(window.localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}

export function cacheSocialContentStage(id: SocialContentStageId): SocialContentStageProfile {
  const profile = socialContentStageProfile(id) || SOCIAL_CONTENT_STAGE_PROFILES[0]!;
  try { window.localStorage.setItem(STORAGE_KEY, profile.id); } catch { /* local fallback is optional */ }
  return profile;
}

export async function loadSocialContentStage(): Promise<SocialContentStageProfile | null> {
  const cached = readSocialContentStage();
  try {
    const response = await fetch('/api/overseas/enterprise/profile', { headers: authHeader() });
    if (!response.ok) return cached;
    const result = await response.json() as { profile?: { socialStrategy?: { contentStage?: unknown } }; socialStrategy?: { contentStage?: unknown } };
    const remote = socialContentStageProfile(result.profile?.socialStrategy?.contentStage ?? result.socialStrategy?.contentStage);
    return remote ? cacheSocialContentStage(remote.id) : cached;
  } catch { return cached; }
}

export async function saveSocialContentStage(id: SocialContentStageId): Promise<{ profile: SocialContentStageProfile; synced: boolean }> {
  const profile = cacheSocialContentStage(id);
  const preset = weeklyTaskPackagePreset(profile.presetId);
  try {
    const response = await fetch('/api/overseas/enterprise/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-enterprise-save-source': 'manual', ...authHeader() },
      body: JSON.stringify({ socialStrategy: { contentStage: profile.id, weeklyTaskPackagePreset: preset.id } }),
    });
    return { profile, synced: response.ok };
  } catch { return { profile, synced: false }; }
}

export function socialContentStageStrategy(id: SocialContentStageId) {
  const profile = socialContentStageProfile(id) || SOCIAL_CONTENT_STAGE_PROFILES[0]!;
  const preset = weeklyTaskPackagePreset(profile.presetId);
  return {
    profile,
    preset,
    generationBrief: `社媒阶段：${profile.name}；策略目标：${preset.objective}；建议节奏：${preset.frequency}；内容方向：${preset.themes.join('、')}`,
  };
}
