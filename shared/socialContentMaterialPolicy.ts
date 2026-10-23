import type { SocialContentThemeId } from './contracts/socialContentWorkflow';

export interface SocialContentMaterialPolicy {
  subjectLabel: string;
  uploadTitle: string;
  quickStartTitle: string;
  quickStartDetail: string;
  missingMessage: string;
  insufficientMessage: string;
  recommendedShots: string;
  focusLabel: string;
  focusPlaceholder: string;
}

const POLICIES: Record<SocialContentThemeId, SocialContentMaterialPolicy> = {
  product_value: {
    subjectLabel: '真实产品画面',
    uploadTitle: '上传完整产品视频',
    quickStartTitle: '上传一支 5–60 秒的完整产品视频',
    quickStartDetail: '产品全貌、关键细节和实际使用过程会帮助系统剪出更像广告的成片。',
    missingMessage: '请上传一支清晰完整的产品视频，或至少 2 份不同的真实产品图片/短片',
    insufficientMessage: '请补充产品全貌、关键细节或实际使用过程素材',
    recommendedShots: '产品全貌 · 关键细节 · 实际使用',
    focusLabel: '产品或业务',
    focusPlaceholder: '例如：免洗护发精油',
  },
  scenario_solution: {
    subjectLabel: '真实使用场景',
    uploadTitle: '上传使用场景或解决过程',
    quickStartTitle: '上传一支包含问题与解决过程的场景视频',
    quickStartDetail: '可以是使用环境、问题细节、操作过程或可见结果，不要求单独拍产品展示片。',
    missingMessage: '请上传一支清晰的使用场景视频，或至少 2 份不同的场景、操作或结果图片/短片',
    insufficientMessage: '请补充使用环境、具体问题、解决动作或可见结果素材',
    recommendedShots: '使用环境 · 问题细节 · 解决动作',
    focusLabel: '产品或解决方案',
    focusPlaceholder: '例如：高温车间防护方案',
  },
  supplier_capability: {
    subjectLabel: '真实工厂与供应画面',
    uploadTitle: '上传工厂、团队或质检视频',
    quickStartTitle: '上传一支 5–60 秒的工厂或供应能力视频',
    quickStartDetail: '厂区、产线、设备、团队、质检、仓储或交付均可，不要求必须出现产品。',
    missingMessage: '请上传一支清晰的工厂或供应能力视频，或至少 2 份不同的厂区、产线、团队、质检或交付图片/短片',
    insufficientMessage: '请补充厂区、产线、团队、质检、仓储或交付素材',
    recommendedShots: '厂区或团队 · 生产流程 · 质检交付',
    focusLabel: '企业或供应能力',
    focusPlaceholder: '例如：自有工厂与柔性生产能力',
  },
  customization_process: {
    subjectLabel: '真实定制流程画面',
    uploadTitle: '上传打样、生产或交付视频',
    quickStartTitle: '上传一支展示定制合作过程的视频',
    quickStartDetail: '需求沟通、方案选择、打样、确认、生产、包装或交付均可，不要求单独上传产品宣传片。',
    missingMessage: '请上传一支清晰的定制流程视频，或至少 2 份不同的打样、生产、包装或交付图片/短片',
    insufficientMessage: '请补充需求、打样、确认、生产、包装或交付过程素材',
    recommendedShots: '需求或样品 · 生产过程 · 包装交付',
    focusLabel: '定制服务或合作项目',
    focusPlaceholder: '例如：小批量面膜 OEM 定制',
  },
  customer_case: {
    subjectLabel: '已授权的真实案例画面',
    uploadTitle: '上传已授权的案例素材',
    quickStartTitle: '上传一支已获授权的案例过程或成果视频',
    quickStartDetail: '可使用项目背景、合作过程和可核验成果；涉及客户身份与数据时必须确保已获授权。',
    missingMessage: '请上传一支已授权的案例视频，或至少 2 份不同的案例过程或成果图片/短片',
    insufficientMessage: '请补充已授权的项目背景、合作过程或可核验成果素材',
    recommendedShots: '项目背景 · 合作过程 · 可核验成果',
    focusLabel: '客户案例或合作项目',
    focusPlaceholder: '例如：连锁美容院新品合作案例',
  },
};

const GENERIC_POLICY: SocialContentMaterialPolicy = {
  subjectLabel: '与主题相关的真实画面',
  uploadTitle: '上传与主题相关的视频或图片',
  quickStartTitle: '上传一支 5–60 秒、与主题相关的完整视频',
  quickStartDetail: '也可以上传至少 2 份不同的真实图片或短片，系统会按主题挑选镜头。',
  missingMessage: '请上传一支清晰、与主题相关的视频，或至少 2 份不同的真实图片/短片',
  insufficientMessage: '请补充与主题相关、彼此不同的真实画面',
  recommendedShots: '主题主体 · 关键过程 · 可见结果',
  focusLabel: '产品、业务或项目',
  focusPlaceholder: '填写这条内容要宣传的产品、业务或项目',
};

export function socialContentMaterialPolicy(themeId?: SocialContentThemeId | null): SocialContentMaterialPolicy {
  return themeId ? POLICIES[themeId] : GENERIC_POLICY;
}
