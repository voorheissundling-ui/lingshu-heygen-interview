import type { BenchmarkMaterialType } from './benchmarkAnalysis';
import type { SocialShotFunction } from './contracts/socialContentReplication';
import type { SocialMaterialRole, SocialSceneVisualContract } from './sceneVisualContract';

export const FIXED_YIELD_ARCHETYPE_IDS = [
  'P1A_FACTORY_WALK_TALK', 'P1B_FACTORY_STAND_TALK', 'P1C_SHELF_STAND_TALK',
  'P1D_SHELF_ACTION_TALK', 'P1E_PRESENTER_CTA', 'P1F_REAL_PRODUCT_CONTACT',
  'P2A_HANDHELD_PRODUCT_WALL', 'P2B_PRODUCT_SHELF', 'P2C_PACKAGE_DETAIL', 'P2D_PRODUCT_MOTION',
  'P3A_WORKER_PROCESS', 'P3B_MACHINE_CLOSEUP', 'P3C_QC_PACKING', 'P3D_FACTORY_ESTABLISH',
  'P4A_USAGE_SETUP', 'P4B_USAGE_ACTION', 'P4C_USAGE_RESULT',
  'P5A_EXHIBITION', 'P5B_CUSTOMER_CASE', 'P5C_LOGISTICS_WAREHOUSE',
  'P5D_VERIFIED_FACT', 'P5E_BRAND_CTA',
] as const;

export type FixedYieldArchetypeId = typeof FIXED_YIELD_ARCHETYPE_IDS[number];

export interface FixedYieldMaterialRule {
  archetypeId: FixedYieldArchetypeId;
  materialType: Exclude<BenchmarkMaterialType, 'unknown'>;
  requiredAnyRoles: SocialMaterialRole[];
  forbiddenRoles: SocialMaterialRole[];
  productIdentity: 'same_product' | 'optional';
}

const rule = (
  archetypeId: FixedYieldArchetypeId,
  materialType: FixedYieldMaterialRule['materialType'],
  requiredAnyRoles: SocialMaterialRole[],
  forbiddenRoles: SocialMaterialRole[] = [],
  productIdentity: FixedYieldMaterialRule['productIdentity'] = 'optional',
): FixedYieldMaterialRule => ({ archetypeId, materialType, requiredAnyRoles, forbiddenRoles, productIdentity });

export const FIXED_YIELD_MATERIAL_RULES: Record<FixedYieldArchetypeId, FixedYieldMaterialRule> = Object.fromEntries([
  rule('P1A_FACTORY_WALK_TALK', 'talking_head', ['presenter']),
  rule('P1B_FACTORY_STAND_TALK', 'talking_head', ['presenter']),
  rule('P1C_SHELF_STAND_TALK', 'talking_head', ['presenter']),
  rule('P1D_SHELF_ACTION_TALK', 'talking_head', ['presenter']),
  rule('P1E_PRESENTER_CTA', 'talking_head', ['presenter']),
  rule('P1F_REAL_PRODUCT_CONTACT', 'talking_head', ['presenter', 'product'], [], 'same_product'),
  rule('P2A_HANDHELD_PRODUCT_WALL', 'product', ['product'], ['factory', 'presenter'], 'same_product'),
  rule('P2B_PRODUCT_SHELF', 'product', ['product'], ['factory', 'person_usage', 'presenter'], 'same_product'),
  rule('P2C_PACKAGE_DETAIL', 'product', ['product'], ['factory', 'person_usage', 'presenter'], 'same_product'),
  rule('P2D_PRODUCT_MOTION', 'product', ['product'], ['factory', 'person_usage', 'presenter'], 'same_product'),
  rule('P3A_WORKER_PROCESS', 'factory', ['factory'], ['presenter', 'person_usage']),
  rule('P3B_MACHINE_CLOSEUP', 'factory', ['factory'], ['presenter', 'person_usage']),
  rule('P3C_QC_PACKING', 'factory', ['factory'], ['presenter', 'person_usage']),
  rule('P3D_FACTORY_ESTABLISH', 'factory', ['factory'], ['presenter', 'person_usage']),
  rule('P4A_USAGE_SETUP', 'consumer_demo', ['person_usage'], ['factory', 'presenter'], 'same_product'),
  rule('P4B_USAGE_ACTION', 'consumer_demo', ['person_usage'], ['factory', 'presenter'], 'same_product'),
  rule('P4C_USAGE_RESULT', 'consumer_demo', ['person_usage'], ['factory', 'presenter'], 'same_product'),
  rule('P5A_EXHIBITION', 'general', ['environment', 'general'], ['factory', 'person_usage', 'presenter']),
  rule('P5B_CUSTOMER_CASE', 'general', ['customer_case'], ['presenter']),
  rule('P5C_LOGISTICS_WAREHOUSE', 'general', ['environment', 'general'], ['person_usage', 'presenter']),
  rule('P5D_VERIFIED_FACT', 'general', ['general', 'environment'], ['person_usage', 'presenter']),
  rule('P5E_BRAND_CTA', 'general', ['general'], ['factory', 'person_usage', 'presenter']),
].map(item => [item.archetypeId, item])) as Record<FixedYieldArchetypeId, FixedYieldMaterialRule>;

const searchable = (visual: SocialSceneVisualContract, description = '') => [
  description,
  visual.interaction.description,
  visual.productUsage.description,
  visual.action.startState,
  visual.action.path,
  visual.action.peakState,
  visual.action.endState,
  visual.environment.description,
  ...visual.environment.details,
  ...visual.subjects.map(subject => subject.description),
  visual.camera.shotSize,
  visual.camera.movement,
  visual.camera.composition,
].join(' ').normalize('NFKC').toLocaleLowerCase();

export function classifyFixedYieldArchetype(input: {
  materialType: BenchmarkMaterialType;
  visual: SocialSceneVisualContract;
  description?: string | null;
  function?: SocialShotFunction;
}): FixedYieldArchetypeId | null {
  const { materialType, visual } = input;
  const text = searchable(visual, input.description ?? '');
  if (materialType === 'unknown') return null;
  if (materialType === 'talking_head') {
    if (input.function === 'call_to_action' || /联系|私信|咨询|whatsapp|email|website|cta|call.?to.?action/.test(text)) return 'P1E_PRESENTER_CTA';
    if (['person_holding_product', 'person_using_product', 'apply_product_to_face'].includes(visual.interaction.kind)) return 'P1F_REAL_PRODUCT_CONTACT';
    const action = /走|行走|推车|转身|移动|walk|cart|turn/.test(text);
    const shelf = visual.environment.kind === 'retail' || visual.environment.kind === 'warehouse' || /货架|样品间|展厅|shelf|showroom/.test(text);
    if (shelf) return action ? 'P1D_SHELF_ACTION_TALK' : 'P1C_SHELF_STAND_TALK';
    return action ? 'P1A_FACTORY_WALK_TALK' : 'P1B_FACTORY_STAND_TALK';
  }
  if (materialType === 'product') {
    if (visual.interaction.kind === 'person_holding_product' || /第一视角|手持|手拿|hold|handheld/.test(text)) return 'P2A_HANDHELD_PRODUCT_WALL';
    if (/标签|包装|材质|结构|细节|特写|微距|label|package|detail|macro|close.?up/.test(text)) return 'P2C_PACKAGE_DETAIL';
    if (visual.interaction.kind === 'product_motion' || /平移|推进|环绕|旋转|运镜|pan|push|orbit/.test(text)) return 'P2D_PRODUCT_MOTION';
    return 'P2B_PRODUCT_SHELF';
  }
  if (materialType === 'factory') {
    if (/质检|抽检|称重|贴标|装箱|码垛|包装|inspection|quality|packing|labeling/.test(text)) return 'P3C_QC_PACKING';
    if (/工人|员工|人工|装配|组装|操作员|worker|operator|assembly/.test(text)) return 'P3A_WORKER_PROCESS';
    if (/机器|设备|灌装|旋盖|输送|喷码|machine|filling|capping|conveyor/.test(text)) return 'P3B_MACHINE_CLOSEUP';
    return 'P3D_FACTORY_ESTABLISH';
  }
  if (materialType === 'consumer_demo') {
    if (visual.productUsage.kind === 'result_display' || /结果|使用后|效果|result|after/.test(text)) return 'P4C_USAGE_RESULT';
    if (['open_close', 'dispense', 'apply_to_face', 'apply_to_hand'].includes(visual.productUsage.kind)
      || ['person_using_product', 'apply_product_to_face'].includes(visual.interaction.kind)) return 'P4B_USAGE_ACTION';
    return 'P4A_USAGE_SETUP';
  }
  if (/展会|展位|博览会|exhibition|trade.?show|booth/.test(text)) return 'P5A_EXHIBITION';
  if (/客户|案例|合作|customer.?case|client/.test(text)) return 'P5B_CUSTOMER_CASE';
  if (/仓储|物流|出货|发货|装车|warehouse|logistics|shipping/.test(text)) return 'P5C_LOGISTICS_WAREHOUSE';
  if (input.function === 'call_to_action' || /品牌收尾|联系|私信|二维码|logo|cta/.test(text)) return 'P5E_BRAND_CTA';
  return 'P5D_VERIFIED_FACT';
}

export function fixedYieldCandidateMatches(input: {
  archetypeId: FixedYieldArchetypeId;
  candidateMaterialType: BenchmarkMaterialType;
  candidateRoles: SocialMaterialRole[];
  candidateVisual: SocialSceneVisualContract;
  requestedProductRef?: string | null;
  candidateProductRefs?: Array<string | null | undefined>;
}): { accepted: boolean; reason: string | null } {
  const rule = FIXED_YIELD_MATERIAL_RULES[input.archetypeId];
  if (input.candidateMaterialType !== rule.materialType) return { accepted: false, reason: 'material_type_mismatch' };
  if (!rule.requiredAnyRoles.some(role => input.candidateRoles.includes(role))) return { accepted: false, reason: 'required_material_role_missing' };
  if (rule.forbiddenRoles.some(role => input.candidateRoles.includes(role))) return { accepted: false, reason: 'forbidden_material_role_present' };
  if (rule.productIdentity === 'same_product' && input.requestedProductRef) {
    const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/^product:/, '');
    const requested = normalize(input.requestedProductRef);
    if (!input.candidateProductRefs?.some(ref => normalize(ref) === requested)) return { accepted: false, reason: 'product_identity_mismatch' };
  }
  const candidateArchetype = classifyFixedYieldArchetype({
    materialType: input.candidateMaterialType,
    visual: input.candidateVisual,
  });
  return candidateArchetype === input.archetypeId
    ? { accepted: true, reason: null }
    : { accepted: false, reason: 'archetype_mismatch' };
}
