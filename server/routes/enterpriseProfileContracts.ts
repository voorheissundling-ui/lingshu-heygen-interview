import type { OrderStatus, OrderAudit, AfterSales } from '../../shared/orderLifecycle.js';
import type { ProductScenePreparationPlan } from '../../shared/contracts/productScenePreparation.js';
import type { AutonomyLevel } from '../autonomy/actionRules.js';

export type QuoteMode = '' | 'range' | 'human_only';
export type BargainPolicy = '' | 'no' | 'limited' | 'open';
export type NotificationChannel = 'wecom' | 'dingtalk' | 'feishu' | 'sms';

export interface BizRules {
  quoteMode: QuoteMode;
  priceRange?: string;
  bargainPolicy: BargainPolicy;
  bargainFloor?: string;
  moq: string;
  samplePolicy: string;
  paymentTerms: string;
  leadTime: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  approvedForAuto: boolean;
  source?: 'manual' | 'pack' | 'learned';
}

export interface NotificationReceiver {
  name: string;
  channel: NotificationChannel;
  target: string;
}

export interface NotificationSettings {
  receivers: NotificationReceiver[];
  workHours: { start: string; end: string };
  quietOutsideHours: boolean;
  nightMode: { enabled: boolean; autoCategories: 'approved' };
  lastTestAt?: string;
}

export interface HandoffRules {
  keywords: string[];
  missStreakToDraft: 1 | 2 | 3;
  negativeSentiment: boolean;
}

export type PartialAutoReplyDecision = 'pending' | 'enabled' | 'declined';

export interface CustomerServiceSettings {
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string;
  partialAutoReplyEnabled: boolean;
  partialAutoReplyDecision: PartialAutoReplyDecision;
  partialAutoReplyDecisionAt?: string;
}

export interface CustomerServicePolicy {
  enabled: boolean;
  enabledAt: string;
  observationDay: number;
  remainingHours: number;
  eligibleForPartialAutoReply: boolean;
  partialAutoReplyEnabled: boolean;
  partialAutoReplyDecision: PartialAutoReplyDecision;
  shouldAskPartialAutoReply: boolean;
  canAutoSend: boolean;
}

export interface CustomerServiceStatus extends CustomerServicePolicy {
  approvedFaqCount: number;
  autoReplyReady: boolean;
}

export interface SalesStyleProfile {
  learnedFromCount: number;
  lastDistilledAt?: string;
  greeting_style?: { value: string; evidence: string; manual?: boolean };
  quoting_stance?: { value: string; evidence: string; manual?: boolean };
  followup_rhythm?: { value: string; evidence: string; manual?: boolean };
  taboo_phrases?: { value: string[]; evidence: string; manual?: boolean };
  sample_pairs?: Array<{ trigger: string; final: string; evidence?: string }>;
}

export interface OrderRecord {
  idempotencyKey?: string;
  customerSyncStatus?: 'pending' | 'done' | 'failed';
  customerSyncError?: string;
  sourcePostId?: string;
  customerId?: string;
  paidAt?: string;
  refundedAt?: string;
  refundAmount?: number;
  audit?: OrderAudit[];
  afterSales?: AfterSales;
  afterSalesHistory?: AfterSales[];
  id: string;
  orderNo: string;
  buyer: string;
  market: string;
  channel: string;
  product: string;
  quantity: number;
  amount: number;
  cost: number;
  status: OrderStatus;
  orderDate: string;
  owner: string;
  source: string;
  sourceRef?: string;
  importedAt: string;
  updatedAt: string;
}

export interface EnterpriseProfile {
  /**
   * Immutable identity of the currently confirmed enterprise facts. Every
   * consumer receives this version together with the profile so content,
   * customer service, quotation, ads and digital employees cannot silently
   * mix facts from different saves.
   */
  factVersion?: {
    id: string;
    revision: number;
    contentHash: string;
    confirmedAt: string;
    confirmedBy: string;
  };
  digitalEmployeeOnboarding?: {
    profileConfirmedAt?: string;
    productSelectionConfirmedAt?: string;
    continuedWithoutProducts?: boolean;
  };
  company: {
    name: string;
    industry: string;
    companyType?: string;
    mainMarkets: string;
    primaryLanguages?: string;
    socialPlatformExperience?: string;
    founded: string;
    description: string;
  };
  socialStrategy?: {
    enabledRoutes: Array<'oem_odm' | 'wholesale_distribution' | 'consumer_retail'>;
    routeStrategies: Partial<Record<'oem_odm' | 'wholesale_distribution' | 'consumer_retail', { targetBuyerRoles: string[]; primaryCta: string }>>;
    manuallyEditedFields?: string[];
    /** Social operating stage selected during application onboarding. */
    contentStage?: 'b2b_launch' | 'b2b_growth' | 'd2c_brand';
    /** PRD-aligned generation preset derived from contentStage. */
    weeklyTaskPackagePreset?: 'b2b_starting' | 'b2b_growing' | 'dtc_sales';
  };
  products: {
    categories: string;
    searchKeywords?: string;
    priceRange: string;
    moq: string;
    certifications: string;
    highlights: string;
    items?: Array<{
      id?: string;
      productId?: string;
      sku?: string;
      name: string;
      category?: string;
      color?: string;
      size?: string;
      tagPrice?: string;
      retailPrice?: string;
      brand?: string;
      material?: string;
      imageUrl?: string;
      priceRange?: string;
      moq?: string;
      certifications?: string;
      highlights?: string;
      attributes?: Record<string, unknown>;
      images?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      videos?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      documents?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      factoryImages?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      packagingImages?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      certificateImages?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      sceneImages?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      brandAssets?: Array<{ name: string; type: string; size: number; updatedAt: string; url?: string }>;
      productScenePreparation?: ProductScenePreparationPlan;
    }>;
  };
  brand: {
    /** Customer-facing brand name; independent from the legal enterprise name. */
    name: string;
    tone: string;
    style: string;
    taboos: string;
    usp: string;
    preferredLanguages?: string;
  };
  strategy?: {
    currentGoal?: string;
    focusProducts?: string;
    focusMarkets?: string;
    excludedMarkets?: string;
    pricingStrategy?: string;
    minMargin?: string;
    agentAutonomy?: string;
    aiAutonomy?: AutonomyLevel;
  };
  customers?: {
    targetProfiles?: string;
    highValueSignals?: string;
    lowQualitySignals?: string;
    commonQuestions?: string;
    followupStyle?: string;
  };
  operations?: {
    leadTime?: string;
    customization?: string;
    logistics?: string;
    paymentTerms?: string;
    riskNotes?: string;
  };
  agentLearning?: {
    provenAngles?: string;
    weakAngles?: string;
    pendingAssumptions?: string;
    userCorrections?: string;
  };
  bizRules?: BizRules;
  faq?: FaqItem[];
  notifications?: NotificationSettings;
  handoffRules?: HandoffRules;
  customerService?: CustomerServiceSettings;
  salesStyleProfile?: SalesStyleProfile;
  knowledgeIntake?: {
    lastExtractedAt?: string;
    source?: 'history' | 'products' | 'interview';
    extractedMessages?: number;
    confirmedSections?: string[];
  };
  dataGovernance?: {
    aiAccessEnabled: boolean;
    lastSavedAt?: string;
    lastSavedSource?: 'diagnosis' | 'enterprise_center' | 'knowledge_intake' | 'system' | 'template';
  };
  knowledge: string;
}
