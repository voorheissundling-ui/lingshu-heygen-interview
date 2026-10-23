import type { MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import type { VideoCreationPlan } from '../../shared/contracts/videoCreationPlan.js';
import type { DirectorScriptContract } from '../../src/lib/directorScript.js';
import type { FixedYieldTimelineCompilation } from '../../shared/fixedYieldTimelineCompiler.js';
import type { MaterialCapabilityManifest } from '../../shared/contracts/materialCapabilityManifest.js';
import type { MaterialAssetV2Metadata } from '../../shared/contracts/materialAssetV2.js';

export type ContentProductionRoute = 'clone' | 'product' | 'material';
/** `fixed-yield.v2-preflight` means the reference timeline passed the new
 * zero-cost compiler, but execution still uses the proven legacy stage runner.
 * It must never be presented as the unified V2 operation executor. */
export type ContentProductionContractVersion = 'legacy.v1' | 'fixed-yield.v2-preflight';
export type ProductionStage = 'script' | 'material_match' | 'voice_subtitles' | 'heygen' | 'render' | 'quality' | 'completed' | 'blocked';
export type StoredRecord = { id: string; [key: string]: unknown };

export type AssetCandidate = {
  id: string; name: string; type: 'video' | 'image'; url?: string; localPath?: string;
  objectKey?: string; cloudRecordId?: string; duration: number; observations: string[];
  productId?: string; productName?: string; visualObservations: string[];
  segments?: Array<Record<string, unknown>>; scriptAnalysis?: MaterialScriptAnalysis;
  /** Canonical handoff shared by legacy and current Content Agents. */
  capabilityManifest?: MaterialCapabilityManifest;
  materialV2?: MaterialAssetV2Metadata | null;
  /** Authoritative, persisted material-rights facts. These fields must never
   * be inferred from tenant ownership, visibility or completed analysis. */
  rightsEvidenceRefs?: string[];
  commercialUseApproved?: boolean;
  commercialUseApprovalEvidenceRefs?: string[];
  modelInputAllowed?: boolean;
  derivativeUseAllowed?: boolean;
  sourceRevision?: string;
  currentSourceRevision?: string;
  segmentProfiles?: unknown[];
  authorization: { status: 'owned' | 'licensed' | 'unknown'; scope: 'tenant' | 'shared'; evidence: string };
  synthetic: boolean; aspectRatio?: string; width?: number; height?: number; focusX?: number; focusY?: number;
  tags: string[]; source: 'enterprise_product' | 'tenant_material' | 'licensed_shared_material';
};

export interface SceneSourcePlanItem {
  sceneIndex: number; start: number; end: number; intent: string; assetId: string; productId?: string;
  score: number; sourceStart?: number; sourceEnd?: number; evidenceSegmentId?: string;
  observations?: string[]; reasons: string[];
}

export interface RouteSourcePlan {
  route: ContentProductionRoute; productId?: string; productName?: string; assetIds: string[];
  seedAssetId?: string; referenceAnalysisId?: string; platform: string; platformBrief: string; gap?: string;
}

export interface ContentProductionOrderInput extends Partial<DirectorScriptContract> {
  videoPlan?: VideoCreationPlan; languages?: string[]; id: string; route: ContentProductionRoute;
  platform: string; productId: string; productName: string;
  evidenceRefs: Array<{ type: 'exact_analysis' | 'enterprise_material'; id: string }>;
  theme?: { key: string; label: string }; cta?: string; constraints?: string[];
  /** Frozen, order-local preparation gaps. They block only this content item. */
  readinessBlockers?: string[];
  fixedYieldTimeline?: FixedYieldTimelineCompilation;
  productionContractVersion?: ContentProductionContractVersion;
  sourceContentOrderId?: string; masterContentOrderId?: string; masterLanguage?: string;
}

export interface ContentRouteEvidence { exactAnalysisIds: string[]; productNames: string[]; assetIds: string[] }
export interface ContentRoutePlan {
  allocations: ContentProductionRoute[]; eligibleRoutes: ContentProductionRoute[];
  blockers: string[]; evidence: ContentRouteEvidence;
}
export interface ContentProductionAdvanceResult {
  changed: boolean; ready: boolean;
  projectRefs: Array<{ type: 'studio_project'; id: string; route: ContentProductionRoute; language?: string; status: string; stage: string; outputPath?: string }>;
  knowledgeGaps: Array<{ type: 'knowledge_gap'; key: string; label: string; destination: string; purpose: string }>;
  blocker: string; summary: string;
}
