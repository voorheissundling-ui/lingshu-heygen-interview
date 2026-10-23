export type ProductionCostQuoteStatus = 'quoted' | 'reserved' | 'settled' | 'overrun' | 'failed';

export interface ProductionCostQuoteLine {
  lineKey: string;
  label: string;
  quantity: number;
  unit: string;
  expectedUnitCostCny: number;
  upperBoundUnitCostCny: number;
  expectedCostCny: number;
  upperBoundCostCny: number;
  pricingSource: string;
  explanation: string;
  reused: boolean;
}

export interface ProductionCostQuote {
  id: string;
  schemaVersion: 'production-cost-quote.v1';
  quoteKey: string;
  taskId: string;
  runId: string;
  currency: 'CNY';
  pricingVersion: string;
  status: ProductionCostQuoteStatus;
  expectedCostCny: number;
  upperBoundCostCny: number;
  budgetLimitCny: number;
  lines: ProductionCostQuoteLine[];
  reservationId: string | null;
  actualCostCny: number | null;
  actualLines: Array<{ lineKey: string; actualCostCny: number; receiptRef: string | null }>;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface CreateProductionCostQuoteInput {
  idempotencyKey: string;
  taskId: string;
  runId: string;
  pricingVersion: string;
  budgetLimitCny: number;
  lines: Array<{
    lineKey: string;
    label: string;
    quantity?: number;
    unit?: string;
    expectedUnitCostCny: number;
    upperBoundUnitCostCny: number;
    pricingSource: string;
    explanation: string;
    reused?: boolean;
  }>;
}
