import type {SocialAssetAvailability,SocialAssetSupplyPlan,SocialAssetSupplyRoute,SocialAssetSupplyShotPlan,
  SocialAccountPresenterLock,SocialContentCreationMode,SocialProductionApproach,SocialProductIdentityGroup,
  SocialProductSceneReplicationSpec,SocialReferenceShotAnalysis,SocialShotFunction,SocialShotSourceStrategy,
  SocialShotTruthBoundary,SocialTruthProhibition,SocialTruthSensitiveSubject} from './contracts/socialContentWorkflow';
import {
  normalizeSceneVisualContract,
  type SocialSceneVisualContract,
} from './sceneVisualContract';
import type { BenchmarkMaterialType } from './benchmarkAnalysis';
import type { SocialMaterialRouting } from './contracts/socialContentReplication';
import {selectTypeAwareSocialMaterial,selectVerifiedSocialMaterialSegment,affirmativeSocialMaterialDescription,explicitSocialPresenterRequest} from './socialContentMaterialRouting';
import type { CreateSocialAssetSupplyPlanInput, SocialAssetInventory, SocialAssetSupplyShotRequest } from './socialContentAssetSupplyContracts';
import {selectVerifiedLocalMaterialCut} from './socialContentLocalMaterialCut';
import { DEFAULT_SHOTS, EMPTY_INVENTORY, digitalHumanMethod, fallbackFor, inferSocialAssetAvailability, normalizeInventory, presenterLockReady, productionRoute, unique } from './socialContentAssetSupplyPolicy';
export type { CreateSocialAssetSupplyPlanInput, SocialAssetInventory, SocialAssetSupplyShotRequest } from './socialContentAssetSupplyContracts';
export { inferSocialAssetAvailability } from './socialContentAssetSupplyPolicy';

function normalizedProductIdentity(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/^product\s*:\s*/i, '').toLocaleLowerCase();
}
function evidenceRefsFor(
  subject: SocialTruthSensitiveSubject,
  inventory: Required<SocialAssetInventory>,
): string[] {
  if (subject === 'customer_factory') return inventory.factoryEvidenceAssetIds;
  if (subject === 'customer_case') return inventory.customerCaseEvidenceAssetIds;
  if (subject === 'product_effect') return inventory.productEffectEvidenceAssetIds;
  return [];
}

function prohibitionsFor(subject: SocialTruthSensitiveSubject): SocialTruthProhibition[] {
  const common: SocialTruthProhibition[] = ['alter_locked_product_identity', 'present_synthetic_media_as_customer_evidence'];
  if (subject === 'customer_factory') return ['depict_generated_factory_as_customer_factory', ...common];
  if (subject === 'customer_case') return ['invent_customer_case_or_results', ...common];
  if (subject === 'product_effect') return ['depict_generated_effect_as_verified_product_result', ...common];
  return common;
}

function referenceShot(
  shot: SocialAssetSupplyShotRequest,
  referenceShots?: SocialReferenceShotAnalysis[],
): SocialReferenceShotAnalysis | undefined {
  return referenceShots?.find(item => item.shotId === shot.referenceShotId);
}

function shotSignals(
  shot: SocialAssetSupplyShotRequest,
  referenceShots?: SocialReferenceShotAnalysis[],
): {
  text: string;
  hasPerson: boolean;
  hasProduct: boolean;
  personUsesProduct: boolean;
  factory: boolean;
  customerCase: boolean;
} {
  const reference = referenceShot(shot, referenceShots);
  const visualContract = normalizeSceneVisualContract(shot.visualContract ?? reference?.visualContract ?? {
    subjects: shot.subjects,
    interaction: shot.interaction,
    environment: shot.environment,
    productUsage: shot.productUsage,
    productPolicy: shot.productPolicy,
    productRef: shot.productRef,
  });
  const values = [
    shot.requestedDescription,
    ...(shot.subjects ?? []),
    shot.interaction,
    shot.environment,
    shot.productUsage,
    reference?.visualDescription,
    reference?.spokenText,
    reference?.captionText,
    ...(reference?.tags.subjects ?? []),
    ...(reference?.tags.subjectRelations ?? []),
    ...(reference?.tags.sceneTypes ?? []),
    reference?.action?.startState,
    reference?.action?.path,
    reference?.action?.endState,
    reference?.action?.spatialRelation,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  // Boundary states describe continuity with adjacent shots, not the subject
  // of this shot.  Classify against the current frozen visual contract so a
  // factory end-state cannot turn the following office/presenter shot into
  // factory footage.
  const classificationValues = [
    shot.requestedDescription,
    ...(shot.subjects ?? []),
    shot.interaction,
    shot.environment,
    shot.productUsage,
    visualContract.interaction.description,
    visualContract.environment.description,
    visualContract.productUsage.description,
    visualContract.action.path,
    ...(reference?.tags.subjects ?? []),
    ...(reference?.tags.subjectRelations ?? []),
    ...(reference?.tags.sceneTypes ?? []),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  const subjectKinds = new Set(visualContract.subjects.map(subject => subject.kind));
  const hasPerson = subjectKinds.has('person')
    || ['person_talking', 'person_holding_product', 'person_using_product', 'apply_product_to_face', 'person_factory_interaction'].includes(visualContract.interaction.kind)
    || /人物|真人|人像|主播|模特|员工|工人|脸|面部|手持|手部|person|people|human|presenter|model|worker|face|hand/.test(values);
  const hasProduct = subjectKinds.has('product') || visualContract.productUsage.kind !== 'none'
    || ['person_holding_product', 'person_using_product', 'apply_product_to_face', 'product_only_display', 'product_motion'].includes(visualContract.interaction.kind)
    || /产品|商品|包装|瓶|罐|盒|精华|面霜|面膜|膏体|涂抹|上脸|product|package|bottle|jar|serum|cream|apply/.test(values);
  const personUsesProduct = hasPerson && hasProduct && (
    ['person_holding_product', 'person_using_product', 'apply_product_to_face'].includes(visualContract.interaction.kind)
    || visualContract.productUsage.kind !== 'none'
    || /使用|试用|涂|抹|上脸|拿|握|手持|开盖|挤|按压|喷|展示|触碰|接触|互动|apply|use|hold|open|squeeze|touch|interact/.test(values)
  );
  return {
    text: values,
    hasPerson,
    hasProduct,
    personUsesProduct,
    factory: shot.truthSensitiveSubject === 'customer_factory' || subjectKinds.has('factory')
      || visualContract.environment.kind === 'factory' || visualContract.interaction.kind === 'factory_process'
      || /工厂|车间|产线|生产基地|仓库|灌装|旋盖|包装线|factory|workshop|production line|warehouse|filling|capping/.test(classificationValues),
    customerCase: shot.truthSensitiveSubject === 'customer_case' || subjectKinds.has('customer_case')
      || /客户案例|客户反馈|合作案例|成交结果|客户成果|customer case|testimonial|client result/.test(classificationValues),
  };
}

export function buildSocialProductSceneReplicationSpec(input: {
  shot: SocialAssetSupplyShotRequest;
  inventory: Required<SocialAssetInventory>;
  referenceShots?: SocialReferenceShotAnalysis[];
}): SocialProductSceneReplicationSpec {
  const reference = input.referenceShots?.find(item => item.shotId === input.shot.referenceShotId);
  const visualContract = normalizeSceneVisualContract(input.shot.visualContract ?? reference?.visualContract ?? {
    productPolicy: input.shot.productPolicy,
    productRef: input.shot.productRef,
  });
  // The task-selected product is authoritative. A reference shot can retain
  // the source video's historic/generic product label in its visual contract;
  // that label describes composition and must not prevent the current exact
  // enterprise SKU from filling an otherwise-empty frozen identity contract.
  const requestedProduct = normalizedProductIdentity(input.shot.productRef
    || visualContract.product.requestedProductRef || visualContract.productUsage.productRef);
  // A named product always selects its own packaging, even for a preferred
  // visual contract. Other catalogue products must never become its identity.
  const inventoryGroups = requestedProduct
    ? input.inventory.productIdentityGroups.filter(group => (
      normalizedProductIdentity(group.productRef) === requestedProduct
    ))
    : input.inventory.productIdentityGroups;
  // A new material-routing pass may carry the prior scene/timing contract while
  // the exact enterprise product image was registered later. Preserve that
  // contract, but fill its previously-empty identity slots from the current
  // exact-SKU inventory. Non-empty frozen identity groups are never replaced.
  if (input.shot.productSceneReplication) {
    const existing=structuredClone(input.shot.productSceneReplication);
    if(existing.productIdentity.groups.length||!inventoryGroups.length)return existing;
    const groups:SocialProductIdentityGroup[]=inventoryGroups.map(group=>({productRef:group.productRef,referenceImageIds:[...group.imageIds],requiredVisibleElements:['产品轮廓','材质与颜色','Logo','包装标签与可读文字'],forbiddenChanges:['shape','material','color','logo','label_text','packaging_structure']}));
    existing.productIdentity.groups=groups;
    existing.sceneLock.productSlots=groups.map((group,index)=>({slotId:`product-slot-${index+1}`,productRef:group.productRef,placement:groups.length===1?'展台视觉中心':`从左到右第 ${index+1} 个固定槽位`,orientation:'正面标签朝向镜头，随运镜保持可识别',scale:groups.length===1?1:.82}));
    return existing;
  }
  const groups: SocialProductIdentityGroup[] = inventoryGroups.length
    ? inventoryGroups.map(group => ({
      productRef: group.productRef,
      referenceImageIds: [...group.imageIds],
      requiredVisibleElements: ['产品轮廓', '材质与颜色', 'Logo', '包装标签与可读文字'],
      forbiddenChanges: ['shape', 'material', 'color', 'logo', 'label_text', 'packaging_structure'],
    }))
    : requestedProduct ? [] : [{
      productRef: 'task-product',
      referenceImageIds: [...input.inventory.productImageIds],
      requiredVisibleElements: ['产品轮廓', '材质与颜色', 'Logo', '包装标签与可读文字'],
      forbiddenChanges: ['shape', 'material', 'color', 'logo', 'label_text', 'packaging_structure'],
    }];
  const cameraTags = reference?.tags.cameraLanguage ?? [];
  const durationSeconds = reference
    ? Math.max(0.5, +(reference.endSeconds - reference.startSeconds).toFixed(2))
    : input.shot.function === 'hook' ? 3 : 4;
  const referenceShotId = input.shot.referenceShotId ?? reference?.shotId ?? null;
  const singleProduct = groups.length === 1;
  return {
    schemaVersion: 'social-product-scene-replication.v1',
    templateSource: reference ? 'reference_shot' : 'system_clean_stage',
    sceneTemplateKey: reference ? `reference-shot:${reference.shotId}` : 'system:clean-platform-orbit-v1',
    referenceShotId,
    referenceSourceId: input.inventory.referenceVideoIds[0] ?? null,
    referenceStartSeconds: reference?.startSeconds ?? null,
    referenceEndSeconds: reference?.endSeconds ?? null,
    productIdentity: {
      groups,
      identitySimilarityMinimum: 0.78,
      ocrExactMatchRequired: true,
    },
    sceneLock: {
      environment: singleProduct && reference
        ? '保留参考镜头的展示功能与背景风格，改为企业当前单一 SKU 的简洁产品展示，不保留或虚构参考商品'
        : reference?.visualDescription || '干净摄影棚产品展示环境',
      background: reference ? '沿用参考镜头的背景类别、明暗关系和留白' : '纯净中性背景，无无关道具和文字',
      platform: reference ? '沿用参考镜头的承托面和高低层级' : '简洁圆形展示台',
      lighting: reference ? '沿用参考镜头的光向、软硬、色温和产品高光关系' : '柔和棚拍主光与轮廓光',
      composition: singleProduct
        ? '单一企业产品居中展示，比例自然，标签完整可读；不得复制瓶身或补造其他商品'
        : reference?.shotLanguage?.composition || cameraTags.join('、') || '多产品有序排列，主体位于安全区内',
      productSlots: groups.map((group, index) => ({
        slotId: `product-slot-${index + 1}`,
        productRef: group.productRef,
        placement: groups.length === 1 ? '展台视觉中心' : `从左到右第 ${index + 1} 个固定槽位`,
        orientation: '正面标签朝向镜头，随运镜保持可识别',
        scale: groups.length === 1 ? 1 : 0.82,
      })),
    },
    compositionSafety: {
      contentModulePolicy: 'benchmark_locked',
      reservedSafeZoneSource: reference ? 'reference_content_modules' : 'system_template',
      subjectPlacement: 'outside_content_module_safe_zone',
      visualCenterBias: 'lower_when_upper_modules',
      minimumClearanceRatio: 0.02,
      repairOrder: ['lower_visual_center', 'rescale_subject', 'regenerate_composition', 'adjust_content_module'],
    },
    cameraLock: {
      shotSize: reference?.shotLanguage?.shotSize || '产品中近景',
      cameraAngle: reference?.shotLanguage?.cameraAngle || '轻微俯视',
      lensFeel: '中焦产品摄影，无夸张广角畸变',
      startFrame: '第一帧完整展示固定产品槽位与干净背景',
      movementPath: reference?.shotLanguage?.movement || cameraTags.find(item => /旋转|环绕|推进|orbit|push/i.test(item)) || '围绕展台平滑环绕并轻微推近',
      endFrame: '产品标签和整体排列仍清晰可识别',
      durationSeconds,
      easing: '缓入缓出，速度连续，不随机变向',
    },
    tolerance: {
      durationSeconds: 0.25,
      productPositionRatio: 0.06,
      productScaleRatio: 0.08,
      cameraPathDeviationRatio: 0.1,
    },
    validation: {
      requiredChecks: ['product_identity', 'packaging_visibility', 'subject_visibility', 'label_ocr', 'scene_topology', 'product_slot_layout', 'camera_trajectory'],
      singleShotRetryOnFailure: true,
    },
  };
}

export function classifySocialAssetSupplyMaterialType(shot:SocialAssetSupplyShotRequest,referenceShots?:SocialReferenceShotAnalysis[]):BenchmarkMaterialType {
  const affirmative=affirmativeSocialMaterialDescription(shot.requestedDescription);
  // Older analyzed reference packages projected the task product into every
  // person/environment contract and then froze those scenes as `product`.
  // Respect an explicit classification unless the visible contract itself
  // proves that this is DTC/customer b-roll with no product-display action.
  // This correction is deterministic and never promotes an untyped scene to
  // a paid route.
  if(shot.materialType){
    if(shot.materialType!=='product')return shot.materialType;
    const frozenVisual=normalizeSceneVisualContract(shot.visualContract??referenceShot(shot,referenceShots)?.visualContract??{subjects:shot.subjects,interaction:shot.interaction,environment:shot.environment,productUsage:shot.productUsage});
    const explicitDtc=/消费者|顾客|挑选|选购|浏览商品|(?:人物|男士|女士|多人|一群人).{0,48}(交谈|洽谈|商务)|围坐.{0,20}(品茶|交谈|洽谈)|consumer|customer|lifestyle/i.test(affirmative);
    const productDisplay=['person_holding_product','person_using_product','apply_product_to_face'].includes(frozenVisual.interaction.kind);
    if(explicitDtc&&!productDisplay)return 'consumer_demo';
    return shot.materialType;
  }
  const preliminaryVisual=normalizeSceneVisualContract(shot.visualContract??referenceShot(shot,referenceShots)?.visualContract??{subjects:shot.subjects,interaction:shot.interaction,environment:shot.environment,productUsage:shot.productUsage});
  if(/contact\s*me|联系我|联系方式/i.test(affirmative)
    && /(头像|圆形头像|图标|爱心|飞机)|(?:avatar|icon|heart)/i.test(affirmative)
    && !preliminaryVisual.subjects.some(subject=>subject.kind==='product'))return 'general';
  if(explicitSocialPresenterRequest(affirmative))return 'talking_head';
  const signals=shotSignals({...shot,requestedDescription:affirmative},referenceShots);
  const reference=referenceShot(shot,referenceShots);
  const presenter=reference?.referenceProductionRouting;
  if(presenter?.state==='ready'&&presenter.personPresence==='person'&&presenter.observedPresenterRole==='sales_presenter')return 'talking_head';
  const visibleDescription=affirmativeSocialMaterialDescription(reference?.visualDescription);
  const directToCamera=/面向镜头|正对镜头|直视镜头|看向镜头|looking (?:at|into) (?:the )?camera|facing (?:the )?camera/i.test(visibleDescription);
  const interaction=normalizeSceneVisualContract(shot.visualContract??reference?.visualContract??{subjects:shot.subjects,interaction:shot.interaction,environment:shot.environment,productUsage:shot.productUsage}).interaction.kind;
  const presenterFunction=['hook','d_to_c','call_to_action'].includes(shot.function)
    || /\b(?:tell us|contact us|dm me|message us|call us)\b|联系我们|私信|留言|咨询/i.test(reference?.spokenText??'');
  const visibleSpeechEvidence=Boolean(reference?.spokenText?.trim())&&directToCamera&&presenterFunction
    && !['person_holding_product','person_using_product','apply_product_to_face','factory_process'].includes(interaction);
  if(signals.hasPerson&&(visibleSpeechEvidence||/口播|主讲|讲解|presenter|talking|speaker/i.test(signals.text)))return 'talking_head';
  if(signals.factory)return 'factory';
  // Holding or turning a package is a product display, not consumer use.
  const visual=normalizeSceneVisualContract(shot.visualContract??referenceShot(shot,referenceShots)?.visualContract??{subjects:shot.subjects,interaction:shot.interaction,environment:shot.environment,productUsage:shot.productUsage});
  const consumerUse=['person_using_product','apply_product_to_face'].includes(visual.interaction.kind)
    // DTC b-roll is broader than a literal application demo. Shopping,
    // browsing and customer/business interaction shots are still real-person
    // lifestyle supply and must be matched against owned footage. Treating
    // them as product-only previously sent people-filled scenes into the
    // product replacement generator merely because the task had a product.
    || /消费者.{0,48}(使用|试用|生活|挑选|选购|浏览|交流)|顾客.{0,48}(使用|试用|挑选|选购|浏览|交谈)|用户.{0,20}(使用|试用)|(?:人物|男士|女士|多人|一群人).{0,48}(交谈|洽谈|商务)|围坐.{0,20}(品茶|交谈|洽谈)|涂抹|上脸|consumer.?demo|consumer.{0,48}(?:use|shop|browse)|customer.{0,48}(?:use|shop|browse|talk)|lifestyle/i.test(signals.text);
  if(consumerUse)return 'consumer_demo';
  return signals.hasProduct?'product':'unknown';
}

function generalStrategy(
  shot: SocialAssetSupplyShotRequest,
  inventory: Required<SocialAssetInventory>,
  confirmedFactRefs: string[],
  accountPresenterLock: SocialAccountPresenterLock | null | undefined,
  referenceShots?: SocialReferenceShotAnalysis[],
  productionApproach: SocialProductionApproach = 'ai_enhanced',
  materialRoutingPolicyVersion?: 'type-aware.v1' | 'type-aware.v2',
): { strategy: SocialShotSourceStrategy; refs: string[]; instruction: string; productSceneReplication?: SocialProductSceneReplicationSpec; materialRouting?: SocialMaterialRouting; blocked?: boolean } {
  const signals = shotSignals(shot, referenceShots);
  if(productionApproach==='material_cut'&&materialRoutingPolicyVersion==='type-aware.v2'){
    const local=selectVerifiedLocalMaterialCut({shot,inventory,materialType:classifySocialAssetSupplyMaterialType(shot,referenceShots)});
    if(local)return local;
  }
  if (materialRoutingPolicyVersion === 'type-aware.v1' || materialRoutingPolicyVersion === 'type-aware.v2') {
    const routed=selectTypeAwareSocialMaterial({policyVersion:materialRoutingPolicyVersion,shot,inventory,materialType:classifySocialAssetSupplyMaterialType(shot,referenceShots),referenceVisualContract:referenceShot(shot,referenceShots)?.visualContract,presenterRefs:presenterLockReady(accountPresenterLock)?[accountPresenterLock.presenterAssetId]:inventory.presenterAssetIds,buildProductSpec:()=>buildSocialProductSceneReplicationSpec({shot,inventory,referenceShots})});
    if(productionApproach==='ai_enhanced')return routed;
    if(productionApproach==='material_cut'&&routed.materialRouting?.localMatch.state==='matched'){
      // A verified free cut keeps its exact segment, not a generation-capable routing contract.
      return {...routed,materialRouting:undefined};
    }
  }
  const observedReferenceRouting = referenceShot(shot, referenceShots)?.referenceProductionRouting;
  const referenceRouting = observedReferenceRouting?.state === 'ready' && observedReferenceRouting.route !== 'undetermined'
    ? observedReferenceRouting : undefined;
  if (referenceRouting && productionApproach === 'ai_enhanced') {
    if (referenceRouting.route === 'reference_frame_presenter') return {
      strategy: 'authorized_digital_presenter', refs: presenterLockReady(accountPresenterLock)
        ? [accountPresenterLock.presenterAssetId] : inventory.presenterAssetIds,
      instruction: `${referenceRouting.reason}；保留源人物连续身份约束，统一替换为当前账号授权人物；不得用普通人物素材、动态图文或其他人物替代。`,
      ...(signals.personUsesProduct && inventory.productImageIds.length ? {
        productSceneReplication: buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots }),
      } : {}),
    };
    if (['library_match', 'non_presenter_library_match'].includes(referenceRouting.route)) {
      const refs = [...new Set([...inventory.customerVideoIds, ...inventory.factoryEvidenceAssetIds,
        ...inventory.customerCaseEvidenceAssetIds, ...inventory.productEffectEvidenceAssetIds])];
      if (refs.length) return { strategy: 'customer_real_asset', refs,
        instruction: `${referenceRouting.reason}；匹配实际视频片段，不得用产品图缩放充当镜头；保留无人/非主讲人物约束。` };
      if (inventory.licensedStockAssetIds.length) return { strategy: 'licensed_stock_asset', refs: inventory.licensedStockAssetIds,
        instruction: `${referenceRouting.reason}；仅匹配已授权库内视频，保留无人/非主讲人物约束。` };
      return inventory.productImageIds.length ? { strategy: 'aigc_product_scene_replication', refs: inventory.productImageIds,
        instruction: `${referenceRouting.reason}；素材库精准与近似检索无可用片段，自动生成非事实性支撑镜头，保持原镜头时长、构图与动作。`,
        productSceneReplication: buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots }) }
        : { strategy: 'non_evidentiary_ai_visual', refs: [],
          instruction: `${referenceRouting.reason}；素材库无合格片段，自动生成非事实性支撑视频，不得生成虚构企业事实。` };
    }
    return inventory.productImageIds.length ? { strategy: 'aigc_product_scene_replication', refs: inventory.productImageIds,
      instruction: `${referenceRouting.reason}；锁定完整场景和动作生成视频，禁止静态产品图缩放或普通人物替代。`,
      productSceneReplication: buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots }) }
      : { strategy: 'non_evidentiary_ai_visual', refs: [], instruction: `${referenceRouting.reason}；需要可执行的视频生成能力，不得降级为图文卡片或图片缩放。` };
  }
  if (productionApproach !== 'ai_enhanced') {
    const localVideoRefs = signals.factory && inventory.factoryEvidenceAssetIds.length
      ? inventory.factoryEvidenceAssetIds
      : signals.customerCase && inventory.customerCaseEvidenceAssetIds.length
        ? inventory.customerCaseEvidenceAssetIds
        : shot.truthSensitiveSubject === 'product_effect' && inventory.productEffectEvidenceAssetIds.length
          ? inventory.productEffectEvidenceAssetIds
          : inventory.customerVideoIds;
    if (localVideoRefs.length > 0) {
      return {
        strategy: 'customer_real_asset',
        refs: localVideoRefs,
        instruction: signals.factory || signals.customerCase
          ? '直接使用“我的素材”中匹配的工厂或客户案例片段；已入库素材不因产品关联或权利元数据缺失而停止制作；统一静音原声并避开明显口型，使用编导锁定的逐句口播音轨'
          : '以逐句口播为主查询匹配“我的素材”真实片段；按动作完整性与安全切点裁切，原声静音并避开明显口型，使用编导锁定的逐句口播音轨；只做重排、变速、调色、字幕和本地转场，不重绘主体',
      };
    }
    if (inventory.productImageIds.length > 0) {
      return {
        strategy: 'customer_product_image_animation',
        refs: inventory.productImageIds,
        instruction: '使用“我的素材”中的产品图片做本地裁切、构图和轻量动效；不得调用付费画面生成或数字人能力',
      };
    }
    return {
      strategy: productionApproach === 'material_polish' && confirmedFactRefs.length > 0
        ? 'verified_fact_card' : 'motion_graphics',
      refs: productionApproach === 'material_polish' ? confirmedFactRefs : [],
      instruction: productionApproach === 'material_polish'
        ? '仅使用本地图文加工补足缺口，不调用外部画面生成或数字人能力'
        : '纯素材方案缺少可匹配的“我的素材”，必须停止并提示素材覆盖不足',
    };
  }

  const isSpokenPresenter = signals.hasPerson && /口播|主讲|讲解|presenter|talking|speaker/i.test(signals.text);
  if (isSpokenPresenter) return {
    strategy: 'authorized_digital_presenter',
    refs: presenterLockReady(accountPresenterLock) ? [accountPresenterLock.presenterAssetId] : inventory.presenterAssetIds,
    instruction: '真人口播必须调用已授权 AIGC 数字人，保留原镜构图、人物动作、视线、情绪与口播节奏，不得使用普通库存人物补位。',
  };

  // Real factory and customer-case media already in the material library has
  // first priority. These are edit inputs, not a request for new evidence.
  if (signals.factory && inventory.factoryEvidenceAssetIds.length > 0) {
    return {
      strategy: 'customer_real_asset',
      refs: inventory.factoryEvidenceAssetIds,
      instruction: '直接使用素材库中的工厂片段，再按逐句口播选择具体区间并裁切；原声静音，有人物时避开明显口型；不因权利字段或产品关联缺失改走生成路线',
    };
  }
  if (signals.customerCase && inventory.customerCaseEvidenceAssetIds.length > 0) {
    return {
      strategy: 'customer_real_asset',
      refs: inventory.customerCaseEvidenceAssetIds,
      instruction: '直接使用素材库中的客户案例片段，再按逐句口播选择具体区间并裁切；原声静音，有人物时避开明显口型；不因权利字段或产品关联缺失改走生成路线',
    };
  }
  if (shot.truthSensitiveSubject === 'product_effect' && !signals.hasPerson
    && inventory.productEffectEvidenceAssetIds.length > 0) {
    return {
      strategy: 'customer_real_asset',
      refs: inventory.productEffectEvidenceAssetIds,
      instruction: '非人物使用类的产品效果直接使用已入库效果素材，按逐句口播裁切',
    };
  }

  // The current presenter stack is a talking-person capability, not a
  // physical product-contact capability. Preserve the narrative function with
  // an exact product cutaway (or existing material) instead of submitting an
  // impossible presenter job and failing after payment.
  if (signals.personUsesProduct) {
    const productRefs = buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots })
      .productIdentity.groups.flatMap(group => group.referenceImageIds);
    if (productRefs.length > 0) {
      return {
        strategy: 'customer_product_image_animation',
        refs: productRefs,
        instruction: '当前数字人不承担持握、涂抹或使用产品等物理接触；改用真实产品图片完成精确产品特写，并与人物口播或动作镜头分切，不得描述为已生成完整人货交互',
      };
    }
    if (inventory.customerVideoIds.length > 0) {
      return {
        strategy: 'customer_real_asset',
        refs: inventory.customerVideoIds,
        instruction: '从已入库视频中选择可承担动作语义的片段；不得把非对应产品或无接触素材描述为已完成精确人货交互',
      };
    }
    return {
      strategy: 'motion_graphics',
      refs: confirmedFactRefs,
      instruction: '当前缺少精确产品资料且数字人不支持物理产品接触；使用动态图文保留说明功能，并请求最小产品图片资料，不创建伪人货交互镜头',
    };
  }

  // A person shown operating a factory or its equipment is also outside the
  // verified talking-presenter scope. Prefer existing environment footage and
  // never move this interaction into the presenter adapter.
  if (signals.hasPerson && signals.factory) {
    if (inventory.customerVideoIds.length > 0) {
      return {
        strategy: 'customer_real_asset',
        refs: inventory.customerVideoIds,
        instruction: '使用已入库的工厂或人物工作片段承担环境与动作语义；不得把通用画面表述为客户真实工厂证据',
      };
    }
    if (inventory.licensedStockAssetIds.length > 0) {
      return {
        strategy: 'licensed_stock_asset',
        refs: inventory.licensedStockAssetIds,
        instruction: '使用已入库且可编辑的共享工厂素材承担环境语义；不得暗示为客户真实工厂或让数字人伪装设备交互',
      };
    }
    return {
      strategy: 'motion_graphics',
      refs: confirmedFactRefs,
      instruction: '当前没有可用工厂人物素材；用示意图文保留说明功能，不调用数字人伪造工厂设备交互',
    };
  }

  // Remaining visible-person scenes stay on the mature presenter route.
  if (signals.hasPerson) {
    return {
      strategy: 'authorized_digital_presenter',
      refs: presenterLockReady(accountPresenterLock)
        ? [accountPresenterLock.presenterAssetId]
        : inventory.presenterAssetIds,
      instruction: '使用数字人完成人物口播，传递表演、环境、镜头与时序控制，不得用图形卡片伪装为已生成人物镜头',
    };
  }

  // Only product-only shots use IAIGC. A hook is not automatically a product
  // shot merely because product images exist in the account.
  if (signals.hasProduct && inventory.productImageIds.length > 0) {
    return {
      strategy: 'aigc_product_scene_replication',
      refs: inventory.productImageIds,
      instruction: '锁定产品轮廓、材质、颜色、Logo、标签和包装文字；按 ProductSceneReplicationSpec 复现完整场景拓扑、产品槽位、布光、构图与镜头轨迹，不得退化为单图平移缩放',
      productSceneReplication: buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots }),
    };
  }
  if (inventory.customerVideoIds.length > 0) {
    return {
      strategy: 'customer_real_asset',
      refs: inventory.customerVideoIds,
      instruction: '按编导锁定的逐句口播匹配已入库真实视频；素材原声静音，有人物时避开明显口型；只做裁切、调色、字幕和声音处理，不重绘真实主体',
    };
  }
  if (inventory.productImageIds.length > 0) {
    return {
      strategy: 'aigc_product_scene_replication',
      refs: inventory.productImageIds,
      instruction: '锁定产品身份并使用同一场景模板与镜头语言生成产品展示；不把生成场景表述为客户实拍',
      productSceneReplication: buildSocialProductSceneReplicationSpec({ shot, inventory, referenceShots }),
    };
  }
  if (shot.function === 'proof' && confirmedFactRefs.length > 0) {
    return {
      strategy: 'verified_fact_card',
      refs: confirmedFactRefs,
      instruction: '只把已确认事实做成数据卡片，不把图形动画包装成实拍证据',
    };
  }
  if (shot.function === 'transition' && inventory.licensedStockAssetIds.length > 0) {
    return {
      strategy: 'licensed_stock_asset',
      refs: inventory.licensedStockAssetIds,
      instruction: '仅把有商用权限的素材用于环境、气氛或转场，不暗示它属于客户',
    };
  }
  if (shot.function === 'hook' || shot.function === 'value' || shot.function === 'call_to_action') {
    return {
      strategy: 'authorized_digital_presenter',
      refs: presenterLockReady(accountPresenterLock)
        ? [accountPresenterLock.presenterAssetId]
        : inventory.presenterAssetIds,
      instruction: inventory.presenterAssetIds.length || presenterLockReady(accountPresenterLock)
        ? '使用本任务已确认的授权数字人完成口播；不得静默替换人物或声音'
        : '优先创建或绑定当前社媒账号的已发布数字人身份版本后完成口播；不要求用户拍摄真人视频，身份未锁定前不得提交生成',
    };
  }
  return {
    strategy: 'motion_graphics',
    refs: confirmedFactRefs,
    instruction: '使用动态图文、示意动画和经确认的事实完成说明，不把示意内容当作客户实拍',
  };
}

function planShot(
  shot: SocialAssetSupplyShotRequest,
  inventory: Required<SocialAssetInventory>,
  confirmedFactRefs: string[],
  creationMode: SocialContentCreationMode,
  accountPresenterLock: SocialAccountPresenterLock | null | undefined,
  referenceShots?: SocialReferenceShotAnalysis[],
  productionApproach: SocialProductionApproach = 'ai_enhanced',
  presenterSelectionConfirmed = false,
  materialRoutingPolicyVersion?: 'type-aware.v1' | 'type-aware.v2',
): SocialAssetSupplyShotPlan {
  const subject = shot.truthSensitiveSubject ?? ((materialRoutingPolicyVersion==='type-aware.v1'||materialRoutingPolicyVersion==='type-aware.v2')&&shotSignals(shot,referenceShots).factory?'customer_factory':'none');
  const canonicalVisualContract = shot.visualContract ?? referenceShot(shot, referenceShots)?.visualContract;
  const signals = shotSignals(shot, referenceShots);
  const observedReferenceRouting = referenceShot(shot, referenceShots)?.referenceProductionRouting;
  const referenceRouting = observedReferenceRouting?.state === 'ready' && observedReferenceRouting.route !== 'undetermined'
    ? observedReferenceRouting : undefined;
  const evidenceRefs = evidenceRefsFor(subject, inventory);
  const hasEvidence = subject !== 'none' && evidenceRefs.length > 0
    && !(subject === 'product_effect' && signals.hasPerson);

  if (hasEvidence && !referenceRouting && !signals.hasPerson && materialRoutingPolicyVersion !== 'type-aware.v1' && materialRoutingPolicyVersion !== 'type-aware.v2') {
    const truthBoundary: SocialShotTruthBoundary = {
      subject,
      syntheticVisualAllowed: false,
      // A material that already entered the tenant-visible library is an
      // available edit input. Missing rights/product metadata must not add a
      // second production gate here.
      customerEvidenceRequired: false,
      customerEvidenceRefs: evidenceRefs,
      confirmedFactRefs,
      mustNotImplyCustomerReality: false,
      prohibitedRepresentations: prohibitionsFor(subject),
    };
    return {
      shotId: shot.shotId,
      function: shot.function,
      requestedDescription: shot.requestedDescription ?? null,
      sourceStrategy: 'customer_real_asset',
      sourceRefs: evidenceRefs,
      fallbackSourceStrategy: null,
      productionInstruction: '直接使用已入库的工厂、客户案例或非人物效果素材，再按逐句口播裁切；不因权利或产品关联元数据缺失停止制作',
      truthBoundary,
      functionalEquivalentReplacement: {
        required: false,
        preservesFunction: shot.function,
        replacesSubject: null,
        description: null,
        reason: null,
      },
      feasibility: 'full_fidelity',
      feasibilityReason: '已有可追溯的客户真实证据，可以完整承担该镜头的证明作用',
      customerShootRequired: false,
      ...(canonicalVisualContract ? { visualContract: structuredClone(canonicalVisualContract) } : {}),
    };
  }

  const selected = generalStrategy(shot, inventory, confirmedFactRefs, accountPresenterLock, referenceShots, productionApproach,materialRoutingPolicyVersion);
  const frozenReferenceRouting = productionApproach === 'ai_enhanced' && referenceRouting
    ? structuredClone(referenceRouting) : undefined;
  if(frozenReferenceRouting&&selected.materialRouting&&selected.materialRouting.policy!=='authorized_presenter'){
    frozenReferenceRouting.route=selected.strategy==='aigc_product_scene_replication'?'non_presenter_aigc_video':'non_presenter_library_match';
    frozenReferenceRouting.reason+='；按冻结素材类型执行本地匹配优先规则，禁止自动改为其他素材类型。';
  }
  if(frozenReferenceRouting && ['library_match','non_presenter_library_match'].includes(frozenReferenceRouting.route)
    && ['aigc_product_scene_replication','non_evidentiary_ai_visual'].includes(selected.strategy)){
    frozenReferenceRouting.route=frozenReferenceRouting.route==='library_match'?'aigc_video':'non_presenter_aigc_video';
    frozenReferenceRouting.reason+='；实际素材库无合格片段，内容 Agent 自动转为非事实性视频生成。';
  }
  if (frozenReferenceRouting?.route === 'reference_frame_presenter' && frozenReferenceRouting.identityLock
    && presenterLockReady(accountPresenterLock)) {
    const target = frozenReferenceRouting.identityLock.targetPresenterAssetId;
    if (target && target !== accountPresenterLock.presenterAssetId) throw new Error(`reference_presenter_account_identity_conflict:${shot.shotId}`);
    frozenReferenceRouting.identityLock.targetPresenterAssetId = accountPresenterLock.presenterAssetId;
  }
  const noFreeMaterial = productionApproach === 'material_cut'
    && !selected.refs.length;
  const normalizedVisualContract = normalizeSceneVisualContract(shot.visualContract ?? referenceShot(shot, referenceShots)?.visualContract ?? {
    productPolicy: shot.productPolicy,
    productRef: shot.productRef,
  });
  const requestedProductRef = normalizedProductIdentity(normalizedVisualContract.product.requestedProductRef
    || normalizedVisualContract.productUsage.productRef || shot.productRef);
  const exactVerifiedLocalProduct = selected.strategy === 'customer_real_asset' && shot.localVideoMatch?.semanticMatch === 'verified'
    && shot.localVideoMatch.sourceRefs.some(ref => selected.refs.includes(ref)) && normalizedProductIdentity(shot.localVideoMatch.productRef) === requestedProductRef;
  const lockedProductUnavailable = Boolean(selected.productSceneReplication
    && selected.productSceneReplication.productIdentity.groups.length === 0) || (
    normalizedVisualContract.product.policy === 'locked'
      && Boolean(requestedProductRef)
      && !exactVerifiedLocalProduct      && !inventory.productIdentityGroups.some(group => (
        normalizedProductIdentity(group.productRef) === requestedProductRef
        && group.imageIds.length > 0
      ))
  );
  const usesFunctionalEquivalent = signals.personUsesProduct || (signals.hasPerson && signals.factory);
  const realFactoryBackgroundMissing=selected.materialRouting?.policy==='authorized_presenter'&&subject==='customer_factory'&&selected.materialRouting.localMatch.state!=='matched';
  const selectedSegment=selected.materialRouting?.localMatch.state==='matched'?shot.selectedMaterialSegment:(materialRoutingPolicyVersion==='type-aware.v1'||materialRoutingPolicyVersion==='type-aware.v2')&&selected.strategy==='customer_real_asset'?selectVerifiedSocialMaterialSegment(shot,selected.refs):undefined;
  const awaitingProductBudget=materialRoutingPolicyVersion==='type-aware.v2'&&selected.materialRouting?.materialType==='product'
    &&selected.materialRouting.productGenerationDecision?.state==='eligible'&&Boolean(selected.productSceneReplication?.productIdentity.groups.length);
  const feasibility = noFreeMaterial || lockedProductUnavailable || selected.blocked || realFactoryBackgroundMissing
    ? 'goal_degraded'
    : awaitingProductBudget&&!selected.refs.length||usesFunctionalEquivalent      ? 'functional_equivalent'
    : selected.strategy === 'customer_real_asset' || selected.strategy === 'customer_product_image_animation'
      || selected.strategy === 'aigc_product_scene_replication'
      ? 'full_fidelity'
      : 'functional_equivalent';
  return {
    shotId: shot.shotId,
    function: shot.function,
    requestedDescription: shot.requestedDescription ?? null,
    sourceStrategy: selected.strategy,
    ...(selected.materialRouting?{materialRouting:selected.materialRouting}:{}),
    ...(frozenReferenceRouting ? { referenceProductionRouting: frozenReferenceRouting } : {}),
    sourceRefs: selected.refs,
    ...(selectedSegment?{selectedMaterialSegment:structuredClone(selectedSegment)}:{}),
    fallbackSourceStrategy: referenceRouting || selected.materialRouting
      || (usesFunctionalEquivalent && selected.strategy === 'motion_graphics')
      ? null
      : fallbackFor(selected.strategy, productionApproach),
    productionInstruction: selected.instruction,
    truthBoundary: {
      subject,
      syntheticVisualAllowed: selected.materialRouting?.policy==='local_only'?false:selected.strategy !== 'customer_real_asset',
      customerEvidenceRequired: Boolean(selected.materialRouting&&subject==='customer_factory'&&selected.strategy!=='customer_real_asset'),
      customerEvidenceRefs: selected.materialRouting&&subject==='customer_factory'?selected.materialRouting.localMatch.sourceRefs:[],
      confirmedFactRefs,
      mustNotImplyCustomerReality: selected.strategy !== 'customer_real_asset',
      prohibitedRepresentations: prohibitionsFor(subject),
    },
    functionalEquivalentReplacement: {
      required: usesFunctionalEquivalent,
      preservesFunction: shot.function,
      replacesSubject: usesFunctionalEquivalent && subject !== 'none' ? subject : null,
      description: signals.personUsesProduct
        ? '将人物动作或口播与独立精确产品特写分切，保留表达功能但不伪装完整人货接触'
        : signals.hasPerson && signals.factory
          ? '使用已有工厂环境素材或示意画面保留生产语义，不让数字人伪装设备操作'
          : null,
      reason: signals.personUsesProduct
        ? '当前数字人执行器不支持可靠的物理产品接触'
        : signals.hasPerson && signals.factory
          ? '当前数字人执行器不支持可靠的工厂设备交互'
          : null,
    },
    feasibility,
    feasibilityReason: feasibility === 'full_fidelity'
      ? '已有客户素材，可在不改变真实主体的情况下完整实现'
      : feasibility === 'functional_equivalent'
        ? awaitingProductBudget
          ? '当前产品镜头仅可进入整片预算与生成能力预检；未获得付费授权，也未产生交付。'
          : usesFunctionalEquivalent
          ? '当前完整交互不在已验收范围，系统将使用素材或拆镜保留表达功能'
          : '可使用当前已入库素材或已配置生成能力完成该镜头'        : realFactoryBackgroundMissing
          ? '真人口播仍需绑定真实本地工厂背景；不允许数字人 provider 虚构工厂，无法复合时必须停止'
        : selected.blocked
          ? '当前素材类型缺少合格的本地匹配或对应企业产品图；必须保留缺口，不切换类型或静默生成'
        : lockedProductUnavailable
          ? '用户明确锁定的产品暂无对应参考素材；只有 locked 策略会停止异品替换'
          : '免费方案当前没有可裁切的已入库素材',
    customerShootRequired: false,
    ...(canonicalVisualContract ? { visualContract: structuredClone(canonicalVisualContract) } : {}),
    ...(selected.productSceneReplication ? {
      productSceneReplication: structuredClone(selected.productSceneReplication),
    } : {}),
    ...(selected.strategy === 'authorized_digital_presenter' ? {
      digitalHumanPlan: {
        workflow: creationMode,
        method: digitalHumanMethod(creationMode, shot.requestedDescription),
        presenterAssetIds: presenterLockReady(accountPresenterLock)
          ? [accountPresenterLock.presenterAssetId]
          : [...inventory.presenterAssetIds],
        referenceMaterialIds: creationMode === 'viral_replication' && digitalHumanMethod(creationMode, shot.requestedDescription) !== 'talking'
          ? [...inventory.referenceVideoIds] : [],
        referenceRequired: creationMode === 'viral_replication' && digitalHumanMethod(creationMode, shot.requestedDescription) !== 'talking',
        candidateTools: digitalHumanMethod(creationMode, shot.requestedDescription) === 'talking' ? ['heygen']
          : digitalHumanMethod(creationMode, shot.requestedDescription) === 'replace'
            ? ['local_head_pipeline', 'runway_kling_motion']
            : ['runway_seedance', 'runway_kling_motion', 'runway_act_two'],
        executionState: presenterLockReady(accountPresenterLock)
          ? creationMode === 'viral_replication'
            ? inventory.referenceVideoIds.length ? 'preview_only' as const : 'needs_confirmation' as const
            : 'ready_for_capability_check' as const
          : presenterSelectionConfirmed && inventory.presenterAssetIds.length === 1
            ? 'ready_for_capability_check' as const
            : 'needs_presenter' as const,
        accountPresenterLock: presenterLockReady(accountPresenterLock)
          ? structuredClone(accountPresenterLock)
          : null,
      },
    } : {}),
  };
}

/** Produces the selected route without turning legacy facts, rights or product
 * metadata into a second admission gate for tenant-visible library media. */
export function createSocialAssetSupplyPlan(input: CreateSocialAssetSupplyPlanInput): SocialAssetSupplyPlan {
  const inventory = normalizeInventory(input.inventory ?? EMPTY_INVENTORY);
  const confirmedFactRefs = unique(input.confirmedFactRefs);
  const availability = input.assetAvailability ?? inferSocialAssetAvailability(inventory);
  const managementMode = input.managementMode ?? 'one_click_managed';
  const requestedShots = input.shots?.length ? input.shots : DEFAULT_SHOTS[input.creationMode];
  // `readMaterialLibrary` is the production visibility boundary. Historic
  // rights flags remain audit metadata and no longer block editing an item
  // which is already visible in that library.
  const shots = requestedShots.map(shot => planShot(
    shot,
    inventory,
    confirmedFactRefs,
    input.creationMode,
    input.accountPresenterLock,
    input.referenceShots,
    input.productionApproach ?? 'ai_enhanced',
    input.presenterSelectionConfirmed === true,
    input.materialRoutingPolicyVersion,
  ));
  const overallFeasibility = shots.some(shot => shot.feasibility === 'goal_degraded')
      ? 'goal_degraded'
      : shots.some(shot => shot.feasibility === 'functional_equivalent')
        ? 'functional_equivalent'
        : 'full_fidelity';
  const customerActions: SocialAssetSupplyPlan['customerActions'] = [];
  const status: SocialAssetSupplyPlan['status'] = overallFeasibility === 'goal_degraded'
    ? 'goal_degraded'
    : 'ready';

  return {
    planVersion: input.planVersion?.trim() || 'historic-unversioned',
    ...(input.materialRoutingPolicyVersion?{materialRoutingPolicyVersion:input.materialRoutingPolicyVersion}:{}),
    creationMode: input.creationMode,
    productionApproach: input.productionApproach ?? 'ai_enhanced',
    assetAvailability: availability,
    managementMode,
    productionRoute: productionRoute(availability, inventory),
    status,
    overallFeasibility,
    canProduceWithoutCustomerShoot: customerActions.length === 0
      && (overallFeasibility === 'full_fidelity' || overallFeasibility === 'functional_equivalent'),
    customerActions,
    accountPresenterLock: presenterLockReady(input.accountPresenterLock)
      ? structuredClone(input.accountPresenterLock)
      : null,
    systemActions: [
      ...(input.creationMode === 'viral_replication'
        ? ['选择或读取参考视频，并完成前三秒与全片逐镜分析']
        : ['读取客户资料并建立前三秒与完整制作脚本']),
      '为每个镜头选择素材来源和备用制作方式',
      ...(shots.some(shot => shot.sourceStrategy === 'authorized_digital_presenter')
        ? ['绑定并复用发布账号的数字人身份版本；缺少时创建一次账号主播档案，不要求真人拍摄'] : []),
      ...(shots.some(shot => shot.sourceStrategy === 'aigc_product_scene_replication')
        ? ['根据产品真实参考图生成完整产品场景，并逐项校验产品身份、场景拓扑、产品槽位与镜头轨迹'] : []),
      ...(input.productionApproach === 'shooting_plan'
        ? ['输出逐镜代拍清单，不调用配音、数字人、IAIGC 或渲染能力']
        : input.productionApproach === 'material_cut'
        ? ['按逐句口播匹配“我的素材”，自动裁切、重排、变速并烧录字幕；不调用 Seedance、数字人或付费画面生成']
        : input.productionApproach === 'material_polish'
          ? ['在“我的素材”剪辑基础上增加本地图文、调色、字幕与转场；不调用 Seedance、数字人或付费画面生成']
          : ['自动制作配音、字幕、动态图文、数字人或辅助画面']),
      '逐镜检查事实边界、素材来源和生成内容标识',
    ],
    optionalEnhancements: [
      '用户可自愿补充更多产品角度图以提高产品身份保真，不要求拍摄产品运镜视频',
      '用户可自愿补充真实工厂、案例或效果证据以恢复对应实拍镜头',
    ],
    shots,
  };
}
