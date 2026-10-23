import type { SocialContentThemeId } from '../../shared/contracts/socialContentWorkflow.js';

export const DEFAULT_SCENES = [
  { nodeId: 'opening', shotFunction: '关联素材开场', subject: '用户为本次任务关联的素材', action: '按上传顺序呈现' },
  { nodeId: 'product', shotFunction: '产品信息说明', subject: '当前产品的已确认资料', action: '保守呈现' },
  { nodeId: 'material', shotFunction: '关联素材补充', subject: '用户为当前产品关联的其他素材', action: '继续呈现' },
  { nodeId: 'closing', shotFunction: '内容收束', subject: '本次任务素材', action: '完成展示' },
] as const;

export const SAFE_THEME_LABELS: Record<SocialContentThemeId, { zh: string; en: string }> = {
  product_value: { zh: '产品实拍', en: 'a real product demonstration' },
  scenario_solution: { zh: '实际使用场景', en: 'a real use scenario' },
  supplier_capability: { zh: '生产与供应现场', en: 'the production and supply process' },
  customization_process: { zh: '定制合作过程', en: 'the customization process' },
  customer_case: { zh: '经授权的合作过程', en: 'an authorized collaboration process' },
};

export const SYSTEM_THEME_SCENES: Record<SocialContentThemeId, ReadonlyArray<{
  nodeId: string;
  shotFunction: string;
  subject: string;
  action: string;
}>> = {
  product_value: [
    { nodeId: 'system-opening', shotFunction: '开场吸引', subject: '通用产品观察', action: '从整体印象开始' },
    { nodeId: 'system-detail', shotFunction: '细节观察', subject: '产品可见细节与操作方式', action: '分步骤观察产品细节' },
    { nodeId: 'system-scenario', shotFunction: '场景说明', subject: '消费者使用产品的适用场景', action: '展示产品使用场景，说明选择思路' },
    { nodeId: 'system-closing', shotFunction: '信息收束', subject: '正式产品资料', action: '提醒进一步核对' },
  ],
  scenario_solution: [
    { nodeId: 'system-opening', shotFunction: '场景开场', subject: '常见使用场景', action: '提出观察重点' },
    { nodeId: 'system-process', shotFunction: '过程说明', subject: '通用使用过程', action: '按顺序呈现' },
    { nodeId: 'system-result', shotFunction: '结果观察', subject: '可见使用结果', action: '保守说明' },
    { nodeId: 'system-closing', shotFunction: '信息收束', subject: '实际适用条件', action: '提醒以正式资料为准' },
  ],
  supplier_capability: [
    { nodeId: 'system-opening', shotFunction: '供应开场', subject: '通用生产与供应流程', action: '建立流程认知' },
    { nodeId: 'system-process', shotFunction: '过程展示', subject: '生产协作环节', action: '按流程说明' },
    { nodeId: 'system-quality', shotFunction: '质量观察', subject: '通用检查节点', action: '说明核对重点' },
    { nodeId: 'system-closing', shotFunction: '交付收束', subject: '交付信息', action: '提醒核实企业资料' },
  ],
  customization_process: [
    { nodeId: 'system-opening', shotFunction: '需求开场', subject: '通用定制需求', action: '明确合作起点' },
    { nodeId: 'system-sample', shotFunction: '打样说明', subject: '方案与样品确认', action: '按阶段说明' },
    { nodeId: 'system-production', shotFunction: '生产说明', subject: '生产与验收节点', action: '呈现通用流程' },
    { nodeId: 'system-closing', shotFunction: '合作收束', subject: '具体合作条件', action: '提醒进一步确认' },
  ],
  customer_case: [
    { nodeId: 'system-opening', shotFunction: '案例开场', subject: '通用合作场景', action: '说明案例结构' },
    { nodeId: 'system-problem', shotFunction: '需求说明', subject: '客户常见需求', action: '概括问题类型' },
    { nodeId: 'system-process', shotFunction: '方案过程', subject: '通用协作步骤', action: '按过程呈现' },
    { nodeId: 'system-closing', shotFunction: '案例收束', subject: '真实案例证据', action: '提醒以授权资料为准' },
  ],
};

