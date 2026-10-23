import type { DigitalHumanReferenceCue } from '../../src/lib/digitalHumanPlan.js';
import { isInternalBudgetExemptTenant } from './tenantBudgetExemption.js';

/** A conservative admission estimate, not a supplier-enforced spending limit. */
export function photoTalkingBudget(input: {
  cues: DigitalHumanReferenceCue[];
  frameCount: number;
  fixedHeygenReserveCny: number;
  tenantId?: string;
  env?: NodeJS.ProcessEnv;
}): { heygenByCue: Record<string, number>; heygenCny: number; firstFrameCny: number; totalCny: number } {
  const env = input.env || process.env;
  const frameRate = Number(env.SEEDREAM_FIRST_FRAME_ESTIMATED_CNY || 0.22);
  const perSecond = env.HEYGEN_PHOTO_ESTIMATED_CNY_PER_SECOND === undefined ? null : Number(env.HEYGEN_PHOTO_ESTIMATED_CNY_PER_SECOND);
  if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isInteger(input.frameCount) || input.frameCount < 0
    || !Number.isFinite(input.fixedHeygenReserveCny) || input.fixedHeygenReserveCny <= 0
    || (perSecond !== null && (!Number.isFinite(perSecond) || perSecond <= 0))) {
    throw new Error('Seedream 与 HeyGen 合计费用无法预估，未调用供应商');
  }
  const heygenByCue: Record<string, number> = {};
  for (const cue of input.cues) {
    if (cue.personShot === false) continue;
    const seconds = Number(cue.end) - Number(cue.start);
    if (!cue.id || !Number.isFinite(seconds) || seconds <= 0) throw new Error('照片口播镜头时长无效，未调用供应商');
    // Reserve at least five billable seconds for short scripts; output duration still follows the generated asset.
    const amount = perSecond === null ? input.fixedHeygenReserveCny : Math.ceil(Math.max(5, seconds) * perSecond * 100) / 100;
    if (!isInternalBudgetExemptTenant(input.tenantId) && amount > input.fixedHeygenReserveCny) throw new Error('照片口播按时长预占超过管理员单任务上限，未调用供应商');
    heygenByCue[cue.id] = amount;
  }
  const heygenCny = Object.values(heygenByCue).reduce((sum, amount) => sum + amount, 0);
  const firstFrameCny = Math.ceil((input.frameCount * frameRate - 1e-9) * 100) / 100;
  return { heygenByCue, heygenCny, firstFrameCny, totalCny: Math.ceil((heygenCny + firstFrameCny - 1e-9) * 100) / 100 };
}
