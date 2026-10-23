import type { SocialAccountProductionConstraints } from './socialAccountProductionConstraints.js';
import type { ContentTemplateStructureConstraint } from '../../shared/socialContentTemplateStructure.js';
import type { SocialContentThemeId } from '../../shared/contracts/socialContentWorkflow.js';

export const SOCIAL_SCRIPT_BASELINE_SCHEMA = 'social-content-script-baseline.v1';
export const SOCIAL_SCRIPT_GROUNDING_VERSION = 'social-script-grounding.v5';

export interface SocialEnterpriseFactVersion {
  id: string;
  revision: number;
  contentHash: string;
}

export interface VerifiedSocialScriptContext {
  enterpriseName?: string | null;
  brandName?: string | null;
  productName: string | null;
  facts: Array<{ key: string; label: string; value: string }>;
  source: 'enterprise_product' | 'enterprise_profile' | 'none';
  confidence: number;
  /** Canonical enterprise-fact generation used to derive this context. The
   * value is frozen into the script baseline so retries never drift to a newer
   * save halfway through one production run. */
  factVersion?: SocialEnterpriseFactVersion | null;
}

export type SocialScriptGroundingSource = VerifiedSocialScriptContext['source'] | 'user_product_association';

export interface SocialInspirationScriptMatch {
  recordId: string;
  title: string;
  confidence: number;
  /** Present only when the match came from an active reference_link on the
   * current task. Catalog recommendations intentionally leave it null. */
  referenceSource?: {
    sourceId: string;
    sourceRef: string;
    sourceVersion: string | null;
  } | null;
  nodes: Array<{
    nodeId: string;
    shotFunction: string;
    subject: string;
    action: string;
    narrationTemplate: { zh: string; en: string };
    /**
     * Only structural information survives reference-video ingestion. The
     * original brand, people, dialogue and on-screen copy are deliberately not
     * represented here, so a reference can guide editing without being copied.
     */
    referenceStructure: {
      sourceTiming: { startSeconds: number; endSeconds: number; durationSeconds: number };
      shotScale: '极近特写' | '近景特写' | '中景' | '全景' | '通用景别';
      cameraMovement: '固定镜头' | '推进镜头' | '拉远镜头' | '横向摇移' | '跟随镜头' | '手持镜头' | '通用运镜';
      pace: '快速' | '紧凑' | '舒缓';
      transition: '快速切换' | '柔和过渡' | '动作衔接' | '自然衔接';
    };
  }>;
}

export interface StoredSocialScriptBaseline {
  accountPlaybookConstraints?:SocialAccountProductionConstraints;
  contentTemplateStructure?: ContentTemplateStructureConstraint;
  schemaVersion: typeof SOCIAL_SCRIPT_BASELINE_SCHEMA;
  version: string;
  source: 'formula' | 'inspiration_script' | 'knowledge_fallback' | 'system_theme_baseline';
  formulaReference: { formulaId: string; version: string } | null;
  themeId: SocialContentThemeId | null;
  language: 'zh' | 'en';
  lockedAt: string;
  createdBeforeMaterialAdaptation: true;
  /** Enterprise facts are versioned independently from the task. Historic
   * baselines may omit this field and are re-grounded before execution. */
  enterpriseFactVersion?: SocialEnterpriseFactVersion | null;
  /** Immutable values used for this baseline. Retries read this snapshot
   * instead of silently switching to a newly saved enterprise profile. */
  verifiedContextSnapshot?: VerifiedSocialScriptContext | null;
  groundingVersion?: typeof SOCIAL_SCRIPT_GROUNDING_VERSION;
  match?: {
    strategy: 'formula_inspiration' | 'formula' | 'inspiration' | 'knowledge_fallback' | 'system_theme_baseline' | 'legacy';
    confidence: number;
    inspirationReference: { recordId: string; confidence: number } | null;
    referenceSource?: {
      sourceId: string;
      sourceRef: string;
      sourceVersion: string | null;
    } | null;
    verifiedKnowledgeSource: SocialScriptGroundingSource;
    verifiedFactKeys: string[];
    userTextUsage: 'intent_only';
    /** Exact tenant-authored material linkage. This is independent of both
     * enterprise knowledge and visual analysis confidence. */
    userProductAssociation?: {
      basis: 'tenant_task_upload';
      confidence: number;
    } | null;
  };
  scenes: Array<{
    scriptOrigin?: 'independent_revision' | 'budget_semantic_revision';
    referenceShotIds?: string[];
    sceneId: string;
    formulaNodeId: string | null;
    inspirationNodeId?: string | null;
    /** Safe shot grammar retained from this task's exact reference-video
     * analysis. It contains no original dialogue, brand, face or overlay. */
    referenceStructure?: SocialInspirationScriptMatch['nodes'][number]['referenceStructure'] | null;
    shotFunction: string;
    subject: string;
    action: string;
    /** Director-ready content fields. `narration` remains the compatibility alias for voiceover. */
    script?: string;
    /** Verbatim ASR/dialogue recovered from the selected reference before identity substitution. */
    referenceSpokenText?: string | null;
    voiceover?: string;
    speechLines?: Array<{
      lineId?: string;
      referenceText: string;
      draftText: string;
      sourceStartSeconds: number;
      sourceEndSeconds: number;
      sourcePrecision: 'phrase' | 'coarse';
      sourceWords?: Array<{start: number; end: number; text: string}>;
      sourceProvenance: string;
      replacedEntityTypes: Array<'company' | 'brand' | 'product'>;
      narrationOwnerShotId?: string;
      visualShotIds?: string[];
    }>;
    /** New reference baselines may replace identities, never facts or phrasing. */
    voiceoverReplacement?: {
      mode: 'identity_only';
      replacedEntityTypes: Array<'company' | 'brand' | 'product'>;
    };
    caption?: string;
    narration: string;
  }>;
}
