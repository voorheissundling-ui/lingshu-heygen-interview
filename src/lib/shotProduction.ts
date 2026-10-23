import type { DigitalHumanRequirements } from './digitalHumanPlan';
export type AppearancePreference = 'auto' | 'avatar' | 'real' | 'none';
export type ShotSource = 'material' | 'avatar' | 'ai' | 'shoot';
/**
 * The visual intent of a storyboard shot.  This deliberately stays separate
 * from `source`: a product close-up can be made from material or AI, while an
 * enterprise presenter can use an existing take or the digital-human route.
 */
export type ShotContentType = 'enterprise_presenter' | 'ugc' | 'product' | 'factory_scene' | 'broll' | 'information';
export type ShotSound = 'voiceover' | 'source' | 'silent';
export type ShotLayout = 'full' | 'split' | 'pip';
export type PresenterChannel = 'default' | 'tiktok' | 'youtube' | 'facebook' | 'instagram' | 'live';
export interface PresenterRoute {
  channel: PresenterChannel;
  presenterId: string;
  voiceId: string;
  layout: ShotLayout;
}
export type PresenterCapability = 'talking' | 'reference_image' | 'reference_video' | 'person_replacement';
export type ArkCertificationStatus = 'profile_incomplete' | 'authorization_pending' | 'ark_pending' | 'processing' | 'active' | 'failed' | 'disabled';
export interface ArkPresenterCertification {
  projectName: string;
  /** Provider-side real-person asset group. Kept separate from the usable image asset ID. */
  groupId?: string;
  assetUri: string;
  assetType: 'image' | 'video' | '';
  status: ArkCertificationStatus;
  materialId: string;
  syncedAt?: string;
  failureReason?: string;
  verificationSource?: 'ark_api' | 'manual_console';
  manualConfirmation?: { imageTypeConfirmed: boolean; activeConfirmed: boolean; samePersonConfirmed: boolean; confirmedAt: string };
}
export interface PresenterAsset {
  id: string; name: string;
  /** Legacy aliases retained while existing HeyGen records migrate to toolMappings. */
  avatarId: string; voiceId: string;
  voiceAuthorization?: { voiceId: string; recordedAt: string; source: 'user_confirmation'; authorizationRef?: string };
  imageUrl?: string; videoUrl?: string; creationMode?: 'quick' | 'expert';
  authorized: boolean; supportsAlpha: boolean; nativeOrientation?: 'unknown' | 'portrait' | 'landscape' | 'square';
  assetVersion?: number;
  /** Machine-readable retained consent evidence. A bare `authorized` flag is not sufficient for supplier submission. */
  /** User declaration retained at ingestion; does not replace provider identity verification. */
  authorizationConfirmation?: { id?: string; recordedAt?: string; version?: string; subjectAdultConfirmed: boolean; arkProcessingAuthorized?: boolean; heygenProcessingAuthorized?: boolean };
  rightsEvidence?: {
    authorizationRef: string; consentRef: string; grantedAt: string; expiresAt?: string; revokedAt?: string;
    subjectAdultConfirmed: boolean; permittedProviders: Array<'heygen' | 'volcengine_ark' | 'dashscope'>;
    permittedUses: Array<'digital_presenter' | 'voice_synthesis' | 'person_replacement' | 'quality_inspection'>;
    providerScopes?: Array<{ provider: 'heygen' | 'volcengine_ark' | 'dashscope'; uses: Array<'digital_presenter' | 'voice_synthesis' | 'person_replacement' | 'quality_inspection'> }>;
  };
  capabilities?: PresenterCapability[];
  referenceMaterialIds?: string[];
  /** Published social-account identity. All presenter shots for this account pin this exact version. */
  socialAccountId?: string;
  presenterProfileId?: string;
  presenterProfileVersion?: string;
  presenterProfileStatus?: 'published' | 'retired';
  commercialRightsStatus?: 'cleared' | 'restricted' | 'expired';
  consistencyKey?: string;
  arkCertification?: ArkPresenterCertification;
  toolMappings?: {
    heygen?: { avatarId: string; voiceId: string };
    /** One user recording is retained as the cross-provider voice identity. */
    volcengineArk?: { speakerId?: string; referenceAudioMaterialId?: string };
    runway?: { referenceMaterialIds: string[] };
    sd?: { referenceMaterialIds: string[] };
    seedance?: { referenceMaterialIds: string[] };
  };
}
export interface ProductionDefaults {
  preference: AppearancePreference;
  presenters: PresenterAsset[];
  defaultPresenterId: string;
  defaultSound: ShotSound;
  defaultLayout: ShotLayout;
  presenterRoutes: PresenterRoute[];
}
export type PresenterProductionGateReason = 'ready' | 'selection_required' | 'authorization_required' | 'appearance_required';
export interface PresenterProductionGate {
  ready: boolean;
  reason: PresenterProductionGateReason;
  presenter?: PresenterAsset;
  message: string;
}

/**
 * A production presenter is an explicit, authorized identity with a real
 * appearance asset.  This gate deliberately does not accept a preference or
 * another visual route as a substitute for the selected person.
 */
export function presenterHasAppearance(asset?: PresenterAsset): boolean {
  if (!asset) return false;
  return Boolean(
    asset.toolMappings?.heygen?.avatarId
    || asset.avatarId
    || asset.imageUrl
    || asset.videoUrl
    || asset.referenceMaterialIds?.some(Boolean)
    || asset.toolMappings?.runway?.referenceMaterialIds?.some(Boolean)
    || asset.toolMappings?.seedance?.referenceMaterialIds?.some(Boolean)
    || asset.toolMappings?.sd?.referenceMaterialIds?.some(Boolean)
  );
}

export function presenterProductionGate(defaults?: Partial<ProductionDefaults> | null, presenterId?: string): PresenterProductionGate {
  const selectedId = String(presenterId || defaults?.defaultPresenterId || '').trim();
  if (!selectedId) return {
    ready: false,
    reason: 'selection_required',
    message: '请选择或录入一个数字人形象；没有形象不能开始生产，也不会改用素材匹配或其他路线。',
  };
  const presenter = defaults?.presenters?.find(item => item.id === selectedId);
  if (!presenter?.authorized) return {
    ready: false,
    reason: 'authorization_required',
    presenter,
    message: '当前数字人形象不存在或未取得授权，请重新选择已授权形象后再生产。',
  };
  if (!presenterHasAppearance(presenter)) return {
    ready: false,
    reason: 'appearance_required',
    presenter,
    message: '当前人物还没有可用形象，请上传照片、视频或选择已有数字人形象后再生产。',
  };
  return { ready: true, reason: 'ready', presenter, message: `已选择数字人形象“${presenter.name}”。` };
}
export interface ShotCandidate { id: string; materialId: string; fingerprint: string; createdAt: string; source: ShotSource; jobId?: string }
export interface ShotProduction {
  materialSourceAudioEnabled?: boolean;
  digitalHuman?: DigitalHumanRequirements;
  /** Older saved shots omit this and are treated as enterprise presenters only when their source is avatar. */
  contentType?: ShotContentType;
  /** Role constraints are for a newly generated, non-identifiable UGC character. */
  ugcRole?: string;
  ugcScenario?: string;
  ugcExpression?: string;
  source: ShotSource; sound: ShotSound; layout: ShotLayout; presenterId: string;
  productId: string; productMaterialId: string; backgroundMaterialId: string; backgroundMode: 'independent' | 'baked';
  transparent: boolean; narration: string; locked: boolean; factsConfirmed: boolean;
  candidates: ShotCandidate[]; adoptedId: string; revision: number;
}
export const EMPTY_DEFAULTS: ProductionDefaults = { preference: 'auto', presenters: [], defaultPresenterId: '', defaultSound: 'voiceover', defaultLayout: 'full', presenterRoutes: [] };
export function presenterCapabilities(asset: PresenterAsset): PresenterCapability[] {
  const inferred: PresenterCapability[] = Array.isArray(asset.capabilities) ? [...asset.capabilities] : [];
  const avatarId = asset.toolMappings?.heygen?.avatarId || asset.avatarId;
  const voiceId = asset.toolMappings?.heygen?.voiceId || asset.voiceId;
  const referenceMaterialIds = asset.toolMappings?.runway?.referenceMaterialIds || asset.toolMappings?.seedance?.referenceMaterialIds || asset.toolMappings?.sd?.referenceMaterialIds || asset.referenceMaterialIds || [];
  if ((avatarId || referenceMaterialIds.length) && voiceId) inferred.push('talking');
  if (referenceMaterialIds.length) inferred.push('reference_image', 'reference_video', 'person_replacement');
  return [...new Set(inferred)];
}

/** Stable identity of generation-affecting presenter inputs. Labels and defaults do not change generated media. */
export function presenterAssetFingerprint(asset: PresenterAsset): string {
  const avatarId = asset.toolMappings?.heygen?.avatarId || asset.avatarId || '';
  const voiceId = asset.toolMappings?.heygen?.voiceId || asset.voiceId || '';
  const runway = asset.toolMappings?.runway?.referenceMaterialIds || asset.referenceMaterialIds || [];
  const sd = asset.toolMappings?.seedance?.referenceMaterialIds || asset.toolMappings?.sd?.referenceMaterialIds || asset.referenceMaterialIds || [];
  const rights = asset.rightsEvidence ? {
    authorizationRef: asset.rightsEvidence.authorizationRef, consentRef: asset.rightsEvidence.consentRef,
    grantedAt: asset.rightsEvidence.grantedAt, expiresAt: asset.rightsEvidence.expiresAt || '', revokedAt: asset.rightsEvidence.revokedAt || '',
    subjectAdultConfirmed: asset.rightsEvidence.subjectAdultConfirmed,
    permittedProviders: [...new Set(asset.rightsEvidence.permittedProviders)].sort(),
    permittedUses: [...new Set(asset.rightsEvidence.permittedUses)].sort(),
    providerScopes: (asset.rightsEvidence.providerScopes || []).map(item=>({provider:item.provider,uses:[...new Set(item.uses)].sort()})).sort((a,b)=>a.provider.localeCompare(b.provider)),
  } : null;
  const ark = asset.arkCertification ? { projectName: asset.arkCertification.projectName, groupId: asset.arkCertification.groupId || '', assetUri: asset.arkCertification.assetUri,
    assetType: asset.arkCertification.assetType, status: asset.arkCertification.status, materialId: asset.arkCertification.materialId,
    syncedAt: asset.arkCertification.syncedAt || '', verificationSource: asset.arkCertification.verificationSource || '', manualConfirmation: asset.arkCertification.manualConfirmation || null } : null;
  const arkVoice = asset.toolMappings?.volcengineArk || null;
  return JSON.stringify({ avatarId, voiceId, voiceAuthorization: asset.voiceAuthorization || null, arkVoice, runway: [...new Set(runway.map(String))].sort(), sd: [...new Set(sd.map(String))].sort(), rights, ark,
    supportsAlpha: Boolean(asset.supportsAlpha), nativeOrientation: asset.nativeOrientation || 'unknown' });
}
export const newShotProduction = (narration = '', presenterId = '', defaults?: Pick<ProductionDefaults, 'defaultSound' | 'defaultLayout'>): ShotProduction => ({
  source: 'material', sound: 'voiceover', layout: defaults?.defaultLayout || 'full', presenterId, productId: '', productMaterialId: '', backgroundMaterialId: '',
  backgroundMode: 'independent', transparent: false, narration, locked: false, factsConfirmed: false, candidates: [], adoptedId: '', revision: 1,
});

/** Apply whole-video defaults only to editable digital-human shots in one assembly. */
export function applyDefaultsToUnlockedAvatarShots(
  shots: Record<string, ShotProduction>,
  assemblyId: string,
  defaults: Pick<ProductionDefaults, 'defaultPresenterId' | 'defaultSound' | 'defaultLayout'>,
): Record<string, ShotProduction> {
  return Object.fromEntries(Object.entries(shots).map(([key, shot]) => {
    if (!key.startsWith(`${assemblyId}:`) || shot.source !== 'avatar' || shot.locked) return [key, shot];
    return [key, patchShot(shot, {
      presenterId: defaults.defaultPresenterId || shot.presenterId,
      sound: defaults.defaultSound,
      layout: defaults.defaultLayout,
    })];
  }));
}

/** Independent layers don't invalidate an expensive presenter generation. */
export function shotFingerprint(shot: ShotProduction, context: string, shotId?: string): string {
  let normalizedContext = context;
  try {
    const value = JSON.parse(context);
    if (shot.source !== 'avatar' || shot.sound !== 'voiceover') {
      delete value.audioIdentity; delete value.audioDuration; delete value.audioSegments; delete value.alignment; delete value.alignmentSource;
    } else if (shotId && Array.isArray(value.audioSegments)) {
      // A shared voiceover is rendered once, but each digital-human shot only depends on
      // its own aligned slice. Global file URLs and total duration would invalidate every
      // candidate when one sentence changes.
      const scopedSegments = value.audioSegments.filter((segment: { id?: unknown }) => String(segment?.id || '') === shotId);
      if (scopedSegments.length) {
        value.audioSegments = scopedSegments;
        delete value.audioIdentity; delete value.audioDuration; delete value.alignment; delete value.alignmentSource;
      }
    }
    normalizedContext = JSON.stringify(value);
  } catch { /* opaque legacy context */ }
  const digitalHuman = shot.digitalHuman ? structuredClone(shot.digitalHuman) : undefined;
  if (digitalHuman?.workflow==='viral_replication' && digitalHuman.method==='reenact' && digitalHuman.replicationMode!=='direct_reference') { delete digitalHuman.targetFramesConfirmed; digitalHuman.contentConfirmed=true; }
  if (digitalHuman?.reference?.cues) digitalHuman.reference.cues = digitalHuman.reference.cues.map(cue => {
    const { sourceFirstFrame: _sourceFirstFrame, targetFirstFrame: _targetFirstFrame, generatedClip: _generatedClip, draftFirstFrame: _draftFirstFrame, ...inputCue } = cue;
    return inputCue;
  });
  return JSON.stringify({ source: shot.source, contentType: shot.contentType || (shot.source === 'avatar' ? 'enterprise_presenter' : 'product'), sound: shot.sound, narration: shot.source === 'avatar' || shot.sound === 'source' ? shot.narration : '',
    presenterId: shot.presenterId, productId: shot.productId, transparent: shot.transparent,
    ...(shot.contentType === 'ugc' ? { ugcRole: shot.ugcRole || '', ugcScenario: shot.ugcScenario || '', ugcExpression: shot.ugcExpression || '' } : {}),
    background: shot.backgroundMode === 'baked' ? shot.backgroundMaterialId : '', context: normalizedContext,
    ...(shot.source === 'avatar' && digitalHuman ? { digitalHuman } : {}) });
}
export function normalizeMaterialAudio(shot: ShotProduction): ShotProduction {
  return shot.source !== 'avatar' && shot.sound === 'source' && shot.materialSourceAudioEnabled !== true
    ? { ...shot, sound: 'voiceover' } : shot;
}

export function patchShot(current: ShotProduction, patch: Partial<ShotProduction>): ShotProduction {
  if (current.locked && patch.locked !== false) throw new Error('请先解锁镜头');
  const changesFacts = patch.productId !== undefined && patch.productId !== current.productId;
  const next = { ...current, ...patch, ...(patch.sound !== undefined ? { materialSourceAudioEnabled: patch.sound === 'source' } : {}), ...(changesFacts ? { factsConfirmed: false } : {}), revision: current.revision + 1 };
  if (next.digitalHuman && (next.narration !== current.narration || next.presenterId !== current.presenterId
    || (patch.digitalHuman && JSON.stringify({ ...patch.digitalHuman, contentConfirmed: false }) !== JSON.stringify({ ...current.digitalHuman, contentConfirmed: false })))) {
    next.digitalHuman = { ...next.digitalHuman, contentConfirmed: false };
  }
  if (next.digitalHuman?.reference?.cues) {
    const before=current.digitalHuman; const after=next.digitalHuman;
    const globalFrameChanged = next.presenterId!==current.presenterId || next.productId!==current.productId
      || before?.presenterMode!==after.presenterMode || before?.replacementScope!==after.replacementScope
      || before?.scene!==after.scene || before?.action!==after.action || before?.preserve!==after.preserve
      || before?.reference?.materialId!==after.reference?.materialId || before?.reference?.videoUrl!==after.reference?.videoUrl;
    let frameChanged=false;
    const cues=after.reference!.cues!.map(cue=>{
      const old=before?.reference?.cues?.find(item=>item.id===cue.id);
      if (!old) return cue;
      const changed=globalFrameChanged || old.start!==cue.start || old.end!==cue.end
        || old.personShot!==cue.personShot || JSON.stringify(old.composition)!==JSON.stringify(cue.composition)
        || old.compositionClusterId!==cue.compositionClusterId;
      if(!changed)return cue;
      frameChanged=true;
      return {...cue,targetFirstFrame:undefined,generatedClip:undefined};
    });
    if(frameChanged) next.digitalHuman={...after,targetFramesConfirmed:false,reference:{...after.reference!,cues}};
  }
  if(next.digitalHuman?.workflow==='viral_replication' && next.digitalHuman.method==='reenact' && next.digitalHuman.replicationMode!=='direct_reference') next.digitalHuman={...next.digitalHuman,contentConfirmed:true};
  return next;
}
export function recommendShot(input: { detail: string; preference: AppearancePreference; locked: boolean; hasMaterial: boolean; hasPresenter: boolean }): { source: ShotSource; reason: string } {
  if (input.locked) return { source: 'material', reason: '镜头已锁定，保持当前选择' };
  if (/证书|检测|质检|操作|安装|客户案例|证言|proof|certificate|test report|testimonial/i.test(input.detail)) return input.hasMaterial
    ? { source: 'material', reason: '事实证明镜头优先核验并复用真实素材' } : { source: 'shoot', reason: '缺少事实证据，安排实拍或补充原始资料' };
  if (input.hasMaterial) return { source: 'material', reason: '已有画面可复用，请确认内容与台词匹配' };
  if (input.preference === 'real') return { source: 'shoot', reason: '按真人实拍偏好安排拍摄' };
  if (input.preference === 'none') return { source: 'material', reason: '不出镜，优先选产品原图或实拍' };
  if ((input.preference === 'avatar' || /口播|讲解|解释|FAQ|presenter|talking/i.test(input.detail)) && input.hasPresenter) return { source: 'avatar', reason: '使用授权人物讲解，按确认台词生成新口型' };
  return { source: 'material', reason: '优先补充产品素材；创意场景可手动选择AI生成' };
}
export function shotBlockers(shot: ShotProduction, context: string, shotId?: string, options?: { sourceMaterialVerified?: boolean }): string[] {
  const result: string[] = [];
  const candidate = shot.candidates.find(item => item.id === shot.adoptedId);
  if (shot.source === 'avatar' && !options?.sourceMaterialVerified && (!candidate || candidate.source !== 'avatar')) result.push('请生成并采用当前数字人镜头候选，不能将原素材视为已生成数字人');
  if (candidate && candidate.fingerprint !== shotFingerprint(shot, context, shotId)) result.push('已采用画面与当前人物/台词/产品要求不一致，请生成或采用匹配候选');
  if (shot.productId && !shot.factsConfirmed) result.push('更换产品后，请核对并确认台词中的产品事实');
  if (shot.layout !== 'full' && !shot.productMaterialId) result.push('分屏或画中画缺少产品素材');
  if (shot.source === 'avatar' && shot.layout === 'pip' && !shot.transparent) result.push('数字人画中画需要去背景的透明人物层；当前可改用全屏普通混剪');
  if (shot.backgroundMaterialId && shot.backgroundMode === 'independent' && !shot.transparent) result.push('人物更换独立背景需要透明人物素材');
  return result;
}

export interface AvatarJob {
  id: string; projectId: string; shotId: string; assemblyId: string; fingerprint: string;
  status: 'submitting' | 'pending' | 'completed' | 'failed' | 'uncertain';
  remoteId?: string; materialId?: string; error?: string; createdAt: string; updatedAt: string;
}

export function avatarCandidateReady(candidate: ShotCandidate, jobs: AvatarJob[]): boolean {
  if (candidate.source !== 'avatar') return true;
  return jobs.some(job => job.id === candidate.jobId && job.status === 'completed' && !job.error
    && job.materialId === candidate.materialId && job.fingerprint === candidate.fingerprint);
}

/** Failed technical checks need a deliberate retry; cap automatic download/decode concurrency. */
export function automaticAvatarRefreshes(jobs: AvatarJob[], projectId: string): AvatarJob[] {
  return jobs.filter(job => job.projectId === projectId && job.status === 'pending' && !job.error)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 3);
}

/** Small, explicit command vocabulary. Never triggers generation, payments or bulk writes. */
export function parseShotCommand(text: string): Partial<ShotProduction> | null {
  const value = text.trim().replace(/[。！!\s]/g, '');
  if (/^(解锁|解锁镜头)$/.test(value)) return { locked: false };
  if (/^(锁定|锁定镜头)$/.test(value)) return { locked: true };
  if (/^(改成|换成|使用|切换到)?(数字人|数字人口播)$/.test(value)) return { source: 'avatar', sound: 'source' };
  if (/^(改成|换成|使用|切换到)?(真人拍摄|安排拍摄|待拍)$/.test(value)) return { source: 'shoot' };
  if (/^(改成|换成|使用|切换到)?(已有素材|选素材)$/.test(value)) return { source: 'material' };
  if (/^(改成|换成|使用|切换到)?(AI画面|AI创意画面)$/i.test(value)) return { source: 'ai' };
  if (/^(改成|换成|使用|切换到)?(画中画|产品主画面人物小窗)$/.test(value)) return { layout: 'pip' };
  if (/^(改成|换成|使用|切换到)?(分屏|人物与产品分屏)$/.test(value)) return { layout: 'split' };
  if (/^(改成|换成|使用|切换到)?(全屏|全屏人物)$/.test(value)) return { layout: 'full' };
  if (/^(改成|换成|使用|切换到)?(连续旁白|旁白)$/.test(value)) return { sound: 'voiceover' };
  if (/^(改成|换成|使用|切换到)?(镜头原声|原声)$/.test(value)) return { sound: 'source' };
  if (/^(改成|换成|使用|切换到)?(无声|静音)$/.test(value)) return { sound: 'silent' };
  const narration = text.trim().match(/^(?:台词改成|台词改为|改台词)[：:]?\s*([\s\S]+)$/);
  return narration ? { narration: narration[1] } : null;
}

export function productionSummary(spec: Record<string, unknown>): string {
  const shots = Object.values((spec.shotProductions || {}) as Record<string, ShotProduction>);
  if (!shots.length) return '';
  const pending = shots.filter(shot => shot.source === 'shoot' && !shot.adoptedId).length;
  const stale = shots.filter(shot => shotBlockers(shot, String(spec.shotProductionContext || '')).length).length;
  const locked = shots.filter(shot => shot.locked).length;
  return [`${shots.length} 个制作镜头`, pending ? `${pending} 个待拍/待核验` : '', stale ? `${stale} 个待更新` : '', locked ? `${locked} 个已锁定` : ''].filter(Boolean).join(' · ');
}
