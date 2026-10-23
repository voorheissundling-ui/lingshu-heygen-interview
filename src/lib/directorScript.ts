export interface FrozenDirectorScript {
  version: number;
  body: string;
  hash: string;
  language: string;
  status: 'confirmed';
  generatedBy: 'director_agent';
  generatedAt: string;
  source: 'llm' | 'deterministic_closed_world_fallback';
  degradedReason: string;
}

export interface DirectorScriptContract {
  contractVersion: 1;
  scripts: Record<string, FrozenDirectorScript>;
  operatingContext?: {
    productionBudget: number;
    /** Frozen ceiling authorized before production. Legacy orders may omit it. */
    productionBudgetMax?: number;
    productionSpent: number;
    productionReserved: number;
    estimatedContentCost: number;
    /** Per-content ceiling selected from the reviewed budget mode. */
    estimatedContentCostMax?: number;
    productionBudgetMode?: 'protected' | 'economy';
    maxAigcRetries?: number;
    budgetApprovedAt?: string;
    originalTarget: number;
    platformVersionTarget: number;
    publishTarget: number;
    qualityStandard: string;
    packageRevision: number;
  };
}
