export type AdCreationSource = 'manual' | 'ai_assisted' | 'ai_managed' | 'platform_import';
export type AdCurrency = 'USD' | 'CNY';
// Meta's official currency table (updated 2026-06-30) lists USD and CNY offset 100.
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/currencies
export const metaCurrencyOffsets: Record<AdCurrency, number> = { USD: 100, CNY: 100 };
export type AdManagementMode = 'manual' | 'suggest' | 'approval' | 'managed';
export type AdActionType = 'create' | 'activate' | 'pause' | 'resume' | 'adjust_budget';
export type AdAuthorization = {
  accountIds: string[];
  allowedActions: AdActionType[];
  maxDailyBudget: number;
  maxTotalBudget: number;
  maxAdjustmentPercent: number;
  expiresAt: string;
};
export type AdProposal = {
  rationale: string;
  audienceStrategy: string;
  creativeStrategy: string;
  risks: string[];
  assumptions: string[];
  expectedOutcome: string;
  generatedAt: string;
  /** Canonical Enterprise Center facts used when this proposal was generated. */
  enterpriseFactVersion?: string;
};
export type AdSourceContext = { runId: string; taskId: string; goalId?: string; objective: string; evidence: string; expectedOutcome: string; constraints: string };
export const creationSourceLabels: Record<AdCreationSource, string> = {
  manual: '人工创建', ai_assisted: 'AI 辅助创建', ai_managed: 'AI 托管创建', platform_import: '平台导入',
};
export const managementModeLabels: Record<AdManagementMode, string> = {
  manual: '人工管理', suggest: 'AI 建议', approval: '审批执行', managed: '授权托管',
};
export type AdPlanConfiguration = {
  startsAt: string;
  endsAt: string;
  dailyBudget: number | null;
  audience: string;
  placements: string;
};
export const emptyAdPlanConfiguration: AdPlanConfiguration = {
  startsAt: '', endsAt: '', dailyBudget: null, audience: '', placements: '',
};
export type AdManagement = {
  creationSource: AdCreationSource;
  managementMode: AdManagementMode;
  configuration: AdPlanConfiguration;
};
