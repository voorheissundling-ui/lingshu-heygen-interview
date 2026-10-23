import type { DigitalEmployeeConfig, PublishingTarget } from './digitalEmployees';
import type { SocialContentStageId } from './socialContentStage';
import { buildPresetMatrixVideoPlans, weeklyTaskPackagePreset } from './weeklyTaskPackagePresets';
import { defaultMatrixPlan, linkMatrixVersionsToMasters } from './weeklyMatrix';
export type InitialOperatingPlan = { stage: SocialContentStageId; products: string[]; market: string; language: string; platforms: PublishingTarget['platform'][]; accountIds?: Partial<Record<PublishingTarget["platform"], string>>; historyAccounts?: string[]; historyCollectionRequestId?: string; count: number; budgetCapCny: number; deliveryDate: string };
export function recommendFocusProducts(products: Array<Record<string, any>>): string[] {
  return products.map((p,index)=>({name:String(p.name||p.title||p.productName||'').trim(),index,score:Number(!!p.description)+Number(!!p.highlights)+Number(!!p.sku)+Number(Array.isArray(p.images)&&p.images.length>0)*2})).filter(p=>p.name).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,2).map(p=>p.name);
}
export function initialPlanMatrixRows(plan:InitialOperatingPlan, config:DigitalEmployeeConfig){
 const rows=defaultMatrixPlan({...config,focusProducts:plan.products.join("、"),videoDefaults:{...config.videoDefaults,language:plan.language}},plan.platforms,"完成首次经营内容交付");
 return plan.platforms.flatMap(platform=>{const row=rows.find(r=>r.platform===platform&&(!plan.accountIds?.[platform]||r.accountId===plan.accountIds[platform]));return row?[{...row,weeklyCount:plan.count}]:[];});
}
export function initialPlanVideoPlans(plan:InitialOperatingPlan, config:DigitalEmployeeConfig){
  const preset=weeklyTaskPackagePreset(plan.stage==='b2b_launch'?'b2b_starting':plan.stage==='b2b_growth'?'b2b_growing':'dtc_sales');
  const adjusted={...config,targetMarkets:plan.market,focusProducts:plan.products.join('、'),videoDefaults:{...config.videoDefaults,language:plan.language}};
  const videos=buildPresetMatrixVideoPlans({preset:{...preset,weeklyOutput:plan.count},productName:plan.products[0]||'',focus:plan.products.join('、'),defaults:adjusted.videoDefaults,platforms:plan.platforms,matrixRows:initialPlanMatrixRows(plan,adjusted)});
  return linkMatrixVersionsToMasters(videos,videos.length);
}
function canonicalInitialPlanValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInitialPlanValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalInitialPlanValue(item)}`)
    .join(',')}}`;
  return JSON.stringify(value);
}

/** Identifies the user-confirmed plan that owns a partially-created draft goal.
 * The collection request id is deliberately omitted so a page reload can resume
 * the same semantic plan without treating the new browser session as an edit. */
export function initialOperatingPlanFingerprint(plan: InitialOperatingPlan): string {
  const { historyCollectionRequestId: _requestId, ...confirmedPlan } = plan;
  const source = canonicalInitialPlanValue(confirmedPlan);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function localDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function validInitialPlanDeliveryDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function validateInitialPlan(plan:InitialOperatingPlan, today = new Date()){
  const deliveryDateError = !validInitialPlanDeliveryDate(plan.deliveryDate)
    ? '请设置有效交付日期'
    : plan.deliveryDate < localDayKey(today)
      ? '交付日期不能早于今天'
      : '';
  return [!plan.products.length?'请选择主推产品':'',!plan.market.trim()?'请确认目标市场':'',!plan.language.trim()?'请确认语言':'',!plan.platforms.length?'请选择平台':'',!Number.isSafeInteger(plan.count)||plan.count<1||plan.count>30?'视频数量须为1–30':'',plan.count*plan.platforms.length>30?'平台适配总数须不超过30条':'',!Number.isFinite(plan.budgetCapCny)||plan.budgetCapCny<=0?'请设置正数预算上限':'',deliveryDateError].filter(Boolean);
}
