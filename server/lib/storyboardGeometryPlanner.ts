import type { StoryboardLayoutSpec } from '../../shared/storyboardShotSpec.js';

/** Clone geometry is measured from the current shot's confirmed frame. Free
 * creation may use an explicit layout or an authored default slot; the latter
 * is a proposal that still needs first-frame visual QA, not an observation. */
export type StoryboardGeometryScene = 'tabletop' | 'conveyor';
export type NormalizedBox = { x: number; y: number; width: number; height: number };

export interface StoryboardGeometryFrame {
  assetId: string;
  version: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export interface StoryboardGeometryInput {
  shotId: string;
  mode: 'replication' | 'free_creation';
  scene: StoryboardGeometryScene;
  confirmedVisual: string;
  product: { assetId: string; version: string; view: string; cutoutAspectRatio: number };
  /** For clone, this must be the real first frame of this same shot. */
  sourceFrame?: StoryboardGeometryFrame;
  /** Free creation may use a layout explicitly confirmed for this shot. */
  confirmedLayout?: {
    shotId: string;
    productBox: NormalizedBox;
    contactSurfaceY: number;
    productView: string;
    scene: StoryboardGeometryScene;
    foregroundOcclusion?: 'none' | 'required';
    foregroundOccluderAssetId?: string;
  };
  foregroundOccluderAssetId?: string;
}

export interface StoryboardGeometryObservation {
  shotId: string;
  sourceFrameAssetId: string;
  sourceFrameVersion: string;
  scene: StoryboardGeometryScene;
  productBox: NormalizedBox;
  contactSurfaceY: number;
  productView: string;
  foregroundOcclusion: 'none' | 'required' | 'uncertain';
  confidence: number;
  /** A short visible fact, not an inferred marketing/action claim. */
  evidence: string;
}

export type StoryboardGeometryInference = (request: {
  shotId: string;
  scene: StoryboardGeometryScene;
  confirmedVisual: string;
  sourceFrame: StoryboardGeometryFrame;
  productView: string;
}) => Promise<unknown>;

export type StoryboardGeometryPlan =
  | { status: 'ready'; source: 'observed_source_frame' | 'confirmed_layout' | 'authored_template'; confidence: number;
      evidence: string; shotId: string; productAssetId: string; productVersion: string;
      sourceFrameAssetId?: string; sourceFrameVersion?: string;
      layout: Pick<StoryboardLayoutSpec, 'contactScene' | 'productBox' | 'contactSurfaceY' | 'productView'>;
      foregroundOccluderAssetId?: string }
  | { status: 'blocked'; code: string; reason: string; shotId: string };

const blocked = (shotId: string, code: string, reason: string): StoryboardGeometryPlan => ({ status: 'blocked', code, reason, shotId });
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const boxValid = (box: any): box is NormalizedBox => box && unit(box.x) && unit(box.y) && unit(box.width)
  && unit(box.height) && box.width >= .06 && box.height >= .06 && box.x + box.width <= 1 && box.y + box.height <= 1;

function freeCreationTemplate(input: StoryboardGeometryInput): StoryboardGeometryObservation | null {
  const visual = input.confirmedVisual.toLowerCase();
  const left = /左侧|左边|画面左|\bleft\b/.test(visual);
  const right = /右侧|右边|画面右|\bright\b/.test(visual);
  if (left && right) return null;
  const requestedView = /背面|背部|\bback\s+(?:view|side)\b/.test(visual) ? 'back'
    : /侧面|侧边|\bside\s+view\b/.test(visual) ? 'side' : input.product.view;
  const height = Math.min(input.scene === 'tabletop' ? .42 : .32, .5 / input.product.cutoutAspectRatio);
  const width = height * input.product.cutoutAspectRatio;
  const centerX = left ? .3 : right ? .7 : .5;
  const contactSurfaceY = input.scene === 'tabletop' ? .78 : .68;
  return { shotId: input.shotId, sourceFrameAssetId: '', sourceFrameVersion: '', scene: input.scene,
    productBox: { x: Number((centerX - width / 2).toFixed(5)), y: Number((contactSurfaceY - height).toFixed(5)),
      width: Number(width.toFixed(5)), height: Number(height.toFixed(5)) },
    contactSurfaceY, productView: requestedView, foregroundOcclusion: 'none', confidence: 1,
    evidence: `依据当前已确认分镜描述生成${input.scene === 'tabletop' ? '桌面' : '传送带'}默认构图；该位置为创作方案，需经首帧画面质检`,
  };
}

/** Strict parser around a mockable vision adapter. The adapter is allowed to
 * propose coordinates, but its claim of confidence is never sufficient by
 * itself: identity, contact, aspect, occlusion and provenance are checked here. */
export async function planStoryboardExactProductGeometry(
  input: StoryboardGeometryInput,
  infer?: StoryboardGeometryInference,
): Promise<StoryboardGeometryPlan> {
  const shotId = String(input.shotId || '').trim();
  if (!shotId || !input.product.assetId || !input.product.version || !input.product.view
    || !Number.isFinite(input.product.cutoutAspectRatio) || input.product.cutoutAspectRatio <= 0)
    return blocked(shotId, 'PRODUCT_GEOMETRY_INPUT_INVALID', '产品身份、来源版本、视角或透明底图比例不完整');
  if (input.scene !== 'tabletop' && input.scene !== 'conveyor')
    return blocked(shotId, 'GEOMETRY_SCENE_UNSUPPORTED', '当前精确保真合成只支持桌面与传送带接触场景');
  if (!String(input.confirmedVisual || '').trim())
    return blocked(shotId, 'CONFIRMED_VISUAL_REQUIRED', '缺少当前分镜已确认的可见画面要求');

  let source: 'observed_source_frame' | 'confirmed_layout' | 'authored_template';
  let geometry: Pick<StoryboardGeometryObservation, 'productBox' | 'contactSurfaceY' | 'productView' | 'foregroundOcclusion' | 'confidence' | 'evidence'>;
  if (input.mode === 'replication') {
    if (!input.sourceFrame?.assetId || !input.sourceFrame.version || !input.sourceFrame.base64)
      return blocked(shotId, 'SOURCE_SHOT_FRAME_REQUIRED', '爆款复刻缺少当前分镜真实首帧，不能推断精确产品位置');
    if (!infer) return blocked(shotId, 'GEOMETRY_OBSERVER_REQUIRED', '尚无当前首帧的几何观测结果');
    let raw: unknown;
    try {
      raw = await infer({ shotId, scene: input.scene, confirmedVisual: input.confirmedVisual,
        sourceFrame: input.sourceFrame, productView: input.product.view });
    } catch {
      return blocked(shotId, 'GEOMETRY_OBSERVER_FAILED', '当前首帧几何观测失败，请改用一般首帧生成或补充参考');
    }
    if (!raw || typeof raw !== 'object') return blocked(shotId, 'GEOMETRY_OBSERVATION_INVALID', '几何观测没有结构化结果');
    const observed = raw as Partial<StoryboardGeometryObservation>;
    if (observed.shotId !== shotId || observed.sourceFrameAssetId !== input.sourceFrame.assetId
      || observed.sourceFrameVersion !== input.sourceFrame.version || observed.scene !== input.scene)
      return blocked(shotId, 'GEOMETRY_EVIDENCE_MISMATCH', '几何观测不属于当前分镜及其真实首帧版本');
    geometry = observed as typeof geometry;
    source = 'observed_source_frame';
  } else if (input.mode === 'free_creation') {
    const layout = input.confirmedLayout;
    if (layout) {
      if (layout.shotId !== shotId || layout.scene !== input.scene)
        return blocked(shotId, 'CONFIRMED_LAYOUT_MISMATCH', '显式布局纠正不属于当前分镜或场景');
      geometry = { productBox: layout.productBox, contactSurfaceY: layout.contactSurfaceY,
        productView: layout.productView, foregroundOcclusion: layout.foregroundOcclusion || 'none',
        confidence: 1, evidence: '当前分镜已确认的目标首帧布局' };
      source = 'confirmed_layout';
    } else {
      const authored = freeCreationTemplate(input);
      if (!authored) return blocked(shotId, 'FREE_LAYOUT_AMBIGUOUS', '当前分镜同时要求左右两侧产品位置，无法生成唯一产品槽位');
      geometry = authored;
      source = 'authored_template';
    }
  } else return blocked(shotId, 'GEOMETRY_MODE_UNSUPPORTED', '创作模式无效');

  if (!unit(geometry.confidence) || geometry.confidence < .85 || !geometry.evidence || geometry.evidence.trim().length < 8)
    return blocked(shotId, 'GEOMETRY_CONFIDENCE_LOW', '产品槽位缺少高置信度的可见画面证据');
  if (!boxValid(geometry.productBox) || !unit(geometry.contactSurfaceY))
    return blocked(shotId, 'GEOMETRY_COORDINATES_INVALID', '产品框或接触面超出归一化画面范围');
  const bottom = geometry.productBox.y + geometry.productBox.height;
  if (Math.abs(bottom - geometry.contactSurfaceY) > .05)
    return blocked(shotId, 'PRODUCT_NOT_ON_SURFACE', '产品框底边与桌面或传送带接触线不吻合');
  if (geometry.productView !== input.product.view)
    return blocked(shotId, 'PRODUCT_VIEW_MISMATCH', '知识库产品透明底图视角与目标首帧所需视角不同');
  const boxAspect = geometry.productBox.width / geometry.productBox.height;
  const aspectFactor = Math.max(boxAspect / input.product.cutoutAspectRatio, input.product.cutoutAspectRatio / boxAspect);
  if (aspectFactor > 1.45)
    return blocked(shotId, 'PRODUCT_ASPECT_MISMATCH', '产品原图比例与目标槽位差异过大，不能强行拉伸贴图');
  if (geometry.foregroundOcclusion === 'uncertain')
    return blocked(shotId, 'FOREGROUND_OCCLUSION_UNCERTAIN', '前景遮挡关系无法确认，不能直接覆盖原图像素');
  const occluderId = input.foregroundOccluderAssetId || input.confirmedLayout?.foregroundOccluderAssetId;
  if (geometry.foregroundOcclusion === 'required' && !occluderId)
    return blocked(shotId, 'FOREGROUND_OCCLUDER_REQUIRED', '目标画面需要前景遮挡层，当前没有可用遮挡素材');
  if (geometry.foregroundOcclusion !== 'none' && geometry.foregroundOcclusion !== 'required')
    return blocked(shotId, 'FOREGROUND_OCCLUSION_INVALID', '前景遮挡状态无效');

  return { status: 'ready', source, confidence: geometry.confidence, evidence: geometry.evidence.trim().slice(0, 500),
    shotId, productAssetId: input.product.assetId, productVersion: input.product.version,
    ...(source === 'observed_source_frame' ? { sourceFrameAssetId: input.sourceFrame!.assetId,
      sourceFrameVersion: input.sourceFrame!.version } : {}),
    layout: { contactScene: input.scene, productBox: geometry.productBox,
      contactSurfaceY: geometry.contactSurfaceY, productView: geometry.productView },
    ...(geometry.foregroundOcclusion === 'required' ? { foregroundOccluderAssetId: occluderId } : {}),
  };
}

/** Provider-neutral request text for a vision adapter. The model must report
 * observations from the supplied current-shot frame only; the parser above
 * remains the admission gate. */
export function storyboardGeometryObservationPrompt(input: Pick<StoryboardGeometryInput, 'shotId' | 'scene' | 'confirmedVisual' | 'product'>): string {
  return [
    'Measure only the supplied current storyboard shot first frame. Do not infer adjacent shots, hidden product sides or later motion.',
    'The source product is a composition placeholder; never use its brand as the enterprise product identity.',
    `Shot ID: ${input.shotId}. Contact scene: ${input.scene}. Confirmed visible requirement: ${input.confirmedVisual.slice(0, 1000)}.`,
    `Enterprise product available view: ${input.product.view}.`,
    'Return JSON with shotId, sourceFrameAssetId, sourceFrameVersion, scene, productBox {x,y,width,height}, contactSurfaceY, productView, foregroundOcclusion (none|required|uncertain), confidence (0..1), evidence.',
    'Coordinates are fractions of image width/height. Product box includes the visible product silhouette only. ContactSurfaceY is where the bottom of the product meets the supporting surface.',
    'If the box, contact, view or occlusion cannot be observed, use low confidence or uncertain. Do not invent coordinates.',
  ].join('\n');
}
