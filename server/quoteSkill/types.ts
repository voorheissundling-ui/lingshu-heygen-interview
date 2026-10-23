export type QuoteSkillStatus = 'needs_clarification' | 'ready_for_review' | 'confirmed';

export interface QuoteFieldEvidence {
  field: 'productName' | 'quantity' | 'material' | 'deliveryDate' | 'destination' | 'incoterm' | 'packaging' | 'drawingVersion';
  value: string | number;
  source: 'buyer_message' | 'customer_profile' | 'product_catalog' | 'enterprise_rule' | 'human';
  excerpt: string;
}

export interface QuoteCatalogProduct {
  sku: string;
  name: string;
  material: string;
  unit: string;
  unitPrice: number | null;
  currency: string;
  moq: number | null;
  leadTime: string;
  priceSource: string;
  attributes: Record<string, unknown>;
}

export interface QuoteSkillDraft {
  schemaVersion: 1;
  revision: number;
  version: number;
  supersedesId?: string;
  id?: string;
  quoteNumber?: string;
  enterpriseFactVersion?: {
    id: string;
    revision: number;
    contentHash: string;
  };
  customerId: string;
  customerName: string;
  customerNameSource: 'whatsapp_profile' | 'safe_fallback';
  customerLanguage: string;
  sellerName: string;
  status: QuoteSkillStatus;
  intentScore: number;
  productName: string;
  sku: string;
  quantity: number | null;
  unit: string;
  material: string;
  deliveryDate: string;
  destination: string;
  incoterm: string;
  packaging: string;
  drawingVersion: string;
  unitPrice: number | null;
  unitPriceSource?: 'product_catalog' | 'human';
  currency: string;
  subtotal: number | null;
  customerBudget?: { amount: number; currency: string };
  leadTime: string;
  paymentTerms: string;
  validityDays: number;
  missingFields: string[];
  blockers: string[];
  evidence: QuoteFieldEvidence[];
  matchedProduct: QuoteCatalogProduct | null;
  pricingExplanation: string[];
  clarificationQuestions: string[];
  humanConfirmationRequired: true;
  confirmedBy?: string;
  confirmedAt?: string;
  delivery?:
    | {
        status: 'sending';
        attemptId: string;
        startedAt: string;
        imageSha256: string;
      }
    | {
        status: 'outcome_unknown';
        attemptId: string;
        startedAt: string;
        outcomeUnknownAt: string;
        imageSha256: string;
        providerMessageId?: string;
      }
    | {
        status: 'sent';
        attemptId?: string;
        startedAt?: string;
        sentAt: string;
        providerMessageId: string;
        imageSha256: string;
      };
  createdAt: string;
  updatedAt: string;
}

export interface BuildQuoteDraftInput {
  customerId: string;
  customerName: string;
  customerNameSource?: 'whatsapp_profile' | 'safe_fallback';
  customerLanguage?: string;
  sellerName?: string;
  productHint?: string;
  messages: string[];
  products: QuoteCatalogProduct[];
  rules: {
    quoteMode?: string;
    priceRange?: string;
    moq?: string;
    leadTime?: string;
    paymentTerms?: string;
  };
}
