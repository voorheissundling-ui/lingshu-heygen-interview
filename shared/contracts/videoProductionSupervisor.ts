/**
 * The Supervisor is deterministic application runtime, not a fifth LLM role.
 * Expert agents own judgment. Workers own repeatable media operations.
 */
export const VIDEO_PRODUCTION_GRAPH_V1_PHASES = [
  'assets',
  'render',
  'quality',
  'delivery',
] as const;

export const VIDEO_PRODUCTION_GRAPH_V2_PHASES = [
  'assets',
  'voice',
  'trim',
  'effects',
  'render',
  'technical_quality',
  'creative_quality',
  'delivery',
] as const;

export type LegacyVideoProductionPhase = typeof VIDEO_PRODUCTION_GRAPH_V1_PHASES[number];
export type VideoProductionSupervisorPhase = typeof VIDEO_PRODUCTION_GRAPH_V2_PHASES[number];
export type VideoProductionGraphPhase = LegacyVideoProductionPhase | VideoProductionSupervisorPhase;

export type VideoProductionExpertId =
  | 'business_strategy_expert'
  | 'director_expert'
  | 'production_planner_expert'
  | 'creative_quality_expert';

export type VideoProductionWorkerId =
  | 'material_supply_worker'
  | 'voice_worker'
  | 'trim_worker'
  | 'effects_worker'
  | 'render_worker'
  | 'technical_quality_worker'
  | 'delivery_worker';

export interface VideoProductionExpertDefinition {
  id: VideoProductionExpertId;
  displayName: string;
  mission: string;
  instructions: readonly string[];
  inputContract: readonly string[];
  outputContract: readonly string[];
  knowledgeNamespaces: readonly string[];
  forbiddenActions: readonly string[];
}

/**
 * These are deliberately short, auditable expert instructions. Detailed
 * product truth, platform rules, examples and rubrics are referenced through
 * versioned RAG namespaces rather than copied into the Supervisor prompt. A
 * model executor must resolve those namespaces before invoking an expert.
 */
export const VIDEO_PRODUCTION_EXPERTS: Readonly<Record<VideoProductionExpertId, VideoProductionExpertDefinition>> = {
  business_strategy_expert: {
    id: 'business_strategy_expert',
    displayName: '经营策略专家',
    mission: '把已核验的经营目标转成可验收的内容目标、受众、平台、CTA、预算和授权边界。',
    instructions: [
      '只使用已核验的企业事实、产品事实、账号状态和用户授权；不补造事实。',
      '明确本条内容要解决的业务问题、目标受众、平台、CTA、成功指标和不可越过的边界。',
      '信息不足时输出结构化 blocker，不替用户作预算、权利或发布授权决定。',
      '不选择素材、不写镜头、不调用模型或供应商。',
    ],
    inputContract: ['verified_business_context', 'product_truth_refs', 'platform_account_state', 'budget_and_authorization'],
    outputContract: ['business_goal_contract', 'acceptance_metrics', 'truth_and_rights_constraints', 'blocking_items'],
    knowledgeNamespaces: ['rag.enterprise_product_truth', 'rag.industry_business_playbook', 'rag.platform_policy'],
    forbiddenActions: ['supplier_call', 'material_selection', 'self_approval', 'publish'],
  },
  director_expert: {
    id: 'director_expert',
    displayName: '编导专家',
    mission: '把经营目标、参考内容和素材能力转成逐镜可执行的创意导演方案。',
    instructions: [
      '先拆解钩子、叙事节奏、信息层级、镜头语言和情绪，再生成逐镜 DirectorBrief。',
      '每个镜头写清目的、主体、动作、景别、构图、时长、口播、字幕意图、连续性和证据要求。',
      '严格区分参考结构与客户事实；禁止把参考视频中的产品、人物或效果当成客户事实。',
      '只做创意判断，不直接选供应商、不执行生图生视频、不批准自己的最终成片。',
    ],
    inputContract: ['business_goal_contract', 'reference_analysis', 'material_capability_manifests', 'truth_and_rights_constraints'],
    outputContract: ['director_brief', 'scene_acceptance_rubrics', 'continuity_constraints', 'creative_risks'],
    knowledgeNamespaces: ['rag.directing_playbook', 'rag.platform_creative_patterns', 'rag.industry_visual_language'],
    forbiddenActions: ['supplier_call', 'render', 'self_final_approval', 'publish'],
  },
  production_planner_expert: {
    id: 'production_planner_expert',
    displayName: '制作规划专家',
    mission: '把 DirectorBrief 映射为素材、能力、供应商路线、成本和逐镜执行计划。',
    instructions: [
      '逐镜匹配素材能力清单，优先复用真实、已授权、已分析的企业素材。',
      '为每个镜头给出主路线、备选路线、输入合同、输出合同、预计成本和失败回退。',
      '在任何付费调用前暴露缺素材、缺权限、缺预算、能力不匹配和不可恢复输入。',
      '只产出冻结执行计划；不执行机械媒体操作，也不把计划通过当成成片通过。',
    ],
    inputContract: ['director_brief', 'material_capability_manifests', 'provider_capability_registry', 'budget_and_authorization'],
    outputContract: ['execution_plan', 'scene_source_bindings', 'provider_route_bindings', 'preflight_report'],
    knowledgeNamespaces: ['rag.production_routing_playbook', 'rag.provider_capabilities', 'rag.cost_and_recovery_policy'],
    forbiddenActions: ['unbudgeted_supplier_call', 'render', 'self_final_approval', 'publish'],
  },
  creative_quality_expert: {
    id: 'creative_quality_expert',
    displayName: '创意质检专家',
    mission: '独立比较成片证据、DirectorBrief 和参考结构，定位到镜头并给出最小返工建议。',
    instructions: [
      '先读取技术质检已通过的真实成片证据，再按逐镜验收标准评估钩子、表达、节奏、保真和平台适配。',
      '每个失败必须定位 sceneId、失败标准、证据、严重级别和建议返工范围。',
      '优先输出最小镜头级返工，不因单镜失败要求整片重做；若上游方案错误则明确退回编导或制作规划。',
      '不得修改事实、替代人工最终验收、批准发布或评价自己参与生成的隐藏中间结果。',
    ],
    inputContract: ['render_artifact_receipt', 'technical_quality_report', 'director_brief', 'reference_evidence'],
    outputContract: ['creative_quality_report', 'scene_failures', 'rework_scope', 'human_review_summary'],
    knowledgeNamespaces: ['rag.creative_quality_rubric', 'rag.platform_creative_patterns', 'rag.industry_visual_language'],
    forbiddenActions: ['artifact_mutation', 'self_publish_approval', 'publish', 'provider_call'],
  },
};

export interface VideoProductionSupervisorNodeDefinition {
  phase: VideoProductionSupervisorPhase;
  owner: VideoProductionWorkerId | VideoProductionExpertId;
  dependsOn: readonly VideoProductionSupervisorPhase[];
  checkpoint: string;
  retry: 'resume_checkpoint' | 'reconcile_provider_then_resume' | 'human_decision';
}

export const VIDEO_PRODUCTION_SUPERVISOR_NODES: readonly VideoProductionSupervisorNodeDefinition[] = [
  { phase: 'assets', owner: 'material_supply_worker', dependsOn: [], checkpoint: 'social.asset_supply', retry: 'reconcile_provider_then_resume' },
  { phase: 'voice', owner: 'voice_worker', dependsOn: ['assets'], checkpoint: 'social.graph_voice', retry: 'reconcile_provider_then_resume' },
  { phase: 'trim', owner: 'trim_worker', dependsOn: ['voice'], checkpoint: 'social.graph_trim', retry: 'resume_checkpoint' },
  { phase: 'effects', owner: 'effects_worker', dependsOn: ['trim'], checkpoint: 'social.graph_effects', retry: 'resume_checkpoint' },
  { phase: 'render', owner: 'render_worker', dependsOn: ['effects'], checkpoint: 'social.graph_render', retry: 'resume_checkpoint' },
  { phase: 'technical_quality', owner: 'technical_quality_worker', dependsOn: ['render'], checkpoint: 'social.graph_technical_quality', retry: 'resume_checkpoint' },
  { phase: 'creative_quality', owner: 'creative_quality_expert', dependsOn: ['technical_quality'], checkpoint: 'social.graph_review', retry: 'resume_checkpoint' },
  { phase: 'delivery', owner: 'delivery_worker', dependsOn: ['creative_quality'], checkpoint: 'social.graph_completion', retry: 'human_decision' },
] as const;

export function videoProductionSupervisorNode(phase: VideoProductionSupervisorPhase): VideoProductionSupervisorNodeDefinition {
  const node = VIDEO_PRODUCTION_SUPERVISOR_NODES.find(item => item.phase === phase);
  if (!node) throw new Error(`video_production_supervisor_phase_unknown:${phase}`);
  return node;
}

export function assertVideoProductionSupervisorDefinition(): void {
  const phases = new Set<VideoProductionSupervisorPhase>();
  for (const node of VIDEO_PRODUCTION_SUPERVISOR_NODES) {
    if (phases.has(node.phase)) throw new Error(`video_production_supervisor_phase_duplicate:${node.phase}`);
    if (node.dependsOn.some(dependency => !phases.has(dependency))) {
      throw new Error(`video_production_supervisor_dependency_invalid:${node.phase}`);
    }
    phases.add(node.phase);
  }
  if (VIDEO_PRODUCTION_GRAPH_V2_PHASES.some(phase => !phases.has(phase))) {
    throw new Error('video_production_supervisor_phase_missing');
  }
}
