import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import type { PresenterShotMeasurements, PresenterStackDecision } from '../../shared/contracts/presenterStackPolicy.js';
import { decidePresenterStack } from './presenterStackPolicy.js';
import type { DataStore } from '../storage/datastore.js';
import { validatePresenterRightsEvidence } from '../lib/presenterAssetTrust.js';

export interface PresenterExecutionSelection {
  sceneId: string;
  referenceShotId: string | null;
  decision: PresenterStackDecision;
  providerId: 'heygen' | 'seedance' | null;
  executionStatus: 'ready' | 'blocked';
  reasonCodes: string[];
  /** Exact enterprise product evidence carried into dynamic-presenter execution. */
  enterpriseProductAssetLock: {
    productId: string;
    enterpriseFactRef: string;
    referenceImageIds: string[];
  } | null;
}

export interface ReplicationExecutionGap {
  sceneId: string;
  referenceShotId: string | null;
  reasonCodes: string[];
  nextActions: string[];
}

/** The last read-only gate before a replication task may reuse an artifact or
 * call any paid producer. A model-written approval is not source evidence. */
export function replicationExecutionGaps(
  detail: Pick<SocialContentTaskDetail, 'agentWorkflow' | 'referenceVideoAnalysis' | 'replicationScript'>,
): ReplicationExecutionGap[] {
  const workflow = detail.agentWorkflow;
  const analysis = detail.referenceVideoAnalysis;
  if (!workflow || !analysis || analysis.status !== 'ready') return [{
    sceneId: 'task', referenceShotId: null,
    reasonCodes: ['reference_analysis_not_ready'],
    nextActions: ['完成并验收参考视频精确分析，再冻结编导交接物'],
  }];
  const result: ReplicationExecutionGap[] = [];
  const sourceShots = new Map(analysis.shots.map(shot => [shot.shotId, shot]));
  const normalizeSpeech = (value: string) => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const measuredSourceLines = analysis.shots.flatMap(shot => shot.spokenLines ?? [])
    .filter(line => line.precision === 'phrase' && Boolean(line.provenance.trim())
      && Boolean(line.text.trim()) && Number.isFinite(line.startSeconds) && Number.isFinite(line.endSeconds)
      && line.endSeconds > line.startSeconds);
  // Director lines may contain the permitted company/brand/product identity
  // substitution, so their text need not equal the source ASR verbatim. The
  // frozen source interval is the join key back to measured source evidence.
  const sourceLineExists = (line: { text: string; sourceStartSeconds: number; sourceEndSeconds: number }) => measuredSourceLines.some(source =>
    Math.abs(source.startSeconds - line.sourceStartSeconds) <= 0.05
      && Math.abs(source.endSeconds - line.sourceEndSeconds) <= 0.05);
  if (!analysis.coverage?.fullTimelineCovered || analysis.coverage.gaps.length) result.push({
    sceneId: 'task', referenceShotId: null,
    reasonCodes: ['reference_timeline_unverified'],
    nextActions: ['核对全片切点与时间覆盖，清除未解释的区间'],
  });
  const primaryHook = workflow.directorBrief.scenes.find(scene => scene.referenceMaterial?.isPrimaryHook);
  if (!primaryHook || primaryHook.duration.targetSeconds <= 0 || !primaryHook.referenceMaterial?.hookDetail
    || !primaryHook.action.startState.trim() || !primaryHook.action.path.trim() || !primaryHook.action.endState.trim()) result.push({
    sceneId: primaryHook?.sceneId ?? 'hook', referenceShotId: primaryHook?.referenceShotId ?? null,
    reasonCodes: ['primary_hook_script_unverified'],
    nextActions: ['排除不足 0.2 秒的封面闪帧，逐帧复核 0–1 秒截流动作的起始状态、快速靠近与敲门手势、结束状态及详细分镜脚本'],
  });
  for (const scene of workflow.directorBrief.scenes) {
    const reasons: string[] = [];
    const actions: string[] = [];
    const reference = scene.referenceShotId ? sourceShots.get(scene.referenceShotId) : null;
    const authoredRevision = detail.replicationScript?.shots.find(shot => shot.shotId === scene.sceneId)?.scriptOrigin === 'budget_semantic_revision';
    if (!reference) {
      reasons.push('reference_shot_missing');
      actions.push('将执行镜头绑定到已验收的参考分镜');
    }
    if (reference && (!scene.referenceMaterial || scene.referenceMaterial.extractionStatus !== 'ready'
      || !scene.referenceMaterial.clipRef || !scene.referenceMaterial.firstFrameRef)) {
      reasons.push('reference_clip_or_first_frame_missing');
      actions.push('提取并验证该镜切片与真实首帧可读');
    }
    const mappedLines = scene.voiceoverLines ?? [];
    const mappedSourceSpeech = mappedLines.length > 0 && mappedLines.every(line => sourceLineExists(line));
    const sourceSpeech = Boolean(reference?.spokenText?.trim() || reference?.audioLayers?.voice?.trim() || mappedSourceSpeech);
    const scriptSpeech = Boolean(scene.audioLayers.dialogue?.trim() || scene.audioLayers.voiceover?.trim());
    const cue = scene.voiceoverAlignment;
    // A summary timing span, L3 model analysis and a generated voiceover cue
    // cannot certify every sentence in a long physical shot.
    const lines = reference?.spokenLines ?? [];
    const ownedMappedLines = mappedLines.filter(line => line.isNarrationOwner
      || line.narrationOwnerShotId === scene.sceneId);
    const sharedVisualSpeech = mappedLines.some(line => !line.isNarrationOwner
      && line.narrationOwnerShotId !== scene.sceneId && line.visualShotIds.includes(scene.sceneId)
      && sourceLineExists(line));
    const phraseTimed = Boolean(reference && reference.spokenText?.trim() && lines.length
      && normalizeSpeech(lines.map(line => line.text).join('')) === normalizeSpeech(reference.spokenText)
      && lines.every((line, index) => line.precision === 'phrase' && Boolean(line.provenance.trim())
        && Boolean(line.text.trim()) && Number.isFinite(line.startSeconds) && Number.isFinite(line.endSeconds)
        && line.endSeconds > line.startSeconds && line.startSeconds >= reference.startSeconds - 0.05
        && line.endSeconds <= reference.endSeconds + 0.05
        && (index === 0 || line.startSeconds >= lines[index - 1]!.endSeconds - 0.05))
      && cue && Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds)
      && cue.endSeconds > cue.startSeconds && cue.startSeconds >= reference.startSeconds - 0.05
      && cue.endSeconds <= reference.endSeconds + 0.05)
      || Boolean(scriptSpeech && ownedMappedLines.length && ownedMappedLines.every(sourceLineExists)
        && cue && Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds)
        && cue.endSeconds > cue.startSeconds);
    if (!authoredRevision && sourceSpeech && !scriptSpeech && !sharedVisualSpeech) {
      reasons.push('source_speech_missing_from_handoff');
      actions.push('将原片该镜口播逐句映射到编导脚本，保留可追溯原句');
    }
    if (!authoredRevision && scriptSpeech && (!sourceSpeech || !phraseTimed)) {
      reasons.push('source_phrase_timing_unverified');
      actions.push('对照原声逐句校准起止时间，并将原句准确映射到参考分镜');
    }
    if (scene.productionRouting?.needsPreciseLipSync
      || scene.productionRouting?.presenterIdentityReplacementRequired) {
      // Publishing-account binding happens later. At generation time an exact
      // enterprise asset reference is sufficient for this synchronous gate;
      // verifyNamedPresenterLock performs the tenant/version/mapping/rights
      // checks before a provider can be called.
      if (!scene.productionRouting.enterprisePresenterAssetRef) {
        reasons.push('enterprise_presenter_version_unlocked');
        actions.push('锁定同一已授权企业销售人物资产及版本');
      }
      if (!scene.referenceMaterial?.firstFrameRef) {
        reasons.push('presenter_first_frame_missing');
        actions.push('以该真人分镜真实首帧建立企业人物替换输入');
      }
    }
    if (reasons.length) result.push({ sceneId: scene.sceneId, referenceShotId: scene.referenceShotId,
      reasonCodes: reasons, nextActions: actions });
  }
  return result;
}

/** Resolve the user's named enterprise identity inside this tenant. Never
 * substitute the account's default presenter or a fuzzy name match. */
export async function verifyNamedPresenterLock(input: {
  store: DataStore | null;
  tenantId: string;
  name?: string | null;
  requestedPresenterAssetId?: string | null;
  selectedEnterprisePresenterAssetId?: string | null;
  provider?: 'heygen' | 'volcengine_ark';
  lock: NonNullable<SocialContentTaskDetail['agentWorkflow']>['directorBrief']['accountPresenterLock'];
}): Promise<{ ok: true; presenterAssetId: string; assetVersion: number } | { ok: false; reason: string }> {
  if (!input.lock && !String(input.selectedEnterprisePresenterAssetId || '').trim()) {
    return { ok: false, reason: 'published_account_presenter_lock_missing' };
  }
  if (!input.store) return { ok: false, reason: 'tenant_presenter_store_unavailable' };
  const rows = await input.store.list<{ payload?: { presenters?: Array<Record<string, unknown>> } }>('studio_production_defaults',
    { where: { tenant_id: input.tenantId }, perPage: 2 });
  if (rows.totalItems !== 1 || rows.items.length !== 1) return { ok: false, reason: 'tenant_presenter_defaults_not_unique' };
  const requestedName = String(input.name || '').trim();
  const requestedId = String(input.selectedEnterprisePresenterAssetId || input.requestedPresenterAssetId || input.lock?.presenterAssetId || '').trim();
  const presenters = rows.items[0]?.payload?.presenters ?? [];
  const named = requestedName ? presenters.filter(item => String(item.name || '').trim() === requestedName
    || String(item.role || '').trim() === requestedName) : presenters;
  if (requestedName && named.length !== 1) return { ok: false,
    reason: named.length ? 'requested_presenter_ambiguous' : 'requested_presenter_missing_or_lock_mismatch' };
  const matches = named.filter(item => String(item.id || '').trim() === requestedId);
  if (matches.length !== 1) return { ok: false, reason: matches.length ? 'requested_presenter_ambiguous' : 'requested_presenter_missing_or_lock_mismatch' };
  const presenter = matches[0]!;
  const version = Number(presenter.assetVersion);
  const rights = validatePresenterRightsEvidence(presenter.rightsEvidence, {
    provider: input.provider??'heygen', uses: input.provider==='volcengine_ark'?['digital_presenter','person_replacement']:['digital_presenter', 'voice_synthesis'],
  });
  if (!rights.ok) return { ok: false, reason: `named_presenter_rights_invalid:${rights.reasons.join(',')}` };
  // During production setup the enterprise asset is authoritative even before
  // a publishing account is connected. Account/profile consistency is checked
  // later when publishing is bound; generation still requires an exact tenant
  // asset ID, immutable version, provider mapping and rights evidence.
  if (!input.lock) {
    if (presenter.authorized !== true || !Number.isSafeInteger(version) || version < 1
      || (input.provider!=='volcengine_ark'&&(!String((presenter.toolMappings as { heygen?: { avatarId?: string; voiceId?: string } } | undefined)?.heygen?.avatarId || presenter.avatarId || '').trim()
      || !String((presenter.toolMappings as { heygen?: { avatarId?: string; voiceId?: string } } | undefined)?.heygen?.voiceId || presenter.voiceId || '').trim()))) {
      return { ok: false, reason: 'named_enterprise_presenter_not_authorized' };
    }
    return { ok: true, presenterAssetId: String(presenter.id), assetVersion: version };
  }
  const lock = input.lock;
  if (presenter.authorized !== true || presenter.presenterProfileStatus !== 'published'
    || presenter.commercialRightsStatus !== 'cleared'
    || !Number.isSafeInteger(version) || version < 1) return { ok: false, reason: 'named_presenter_not_published_or_authorized' };
  if (!lock || lock.status !== 'published' || lock.commercialRightsStatus !== 'cleared'
    || lock.presenterAssetId !== presenter.id
    || lock.socialAccountId !== presenter.socialAccountId
    || lock.presenterProfileId !== presenter.presenterProfileId
    || lock.presenterProfileVersion !== presenter.presenterProfileVersion
    || lock.consistencyKey !== presenter.consistencyKey
    || lock.consentRef !== presenter.consentRef
    || (input.provider!=='volcengine_ark'&&(lock.avatarId !== String((presenter.toolMappings as { heygen?: { avatarId?: string } } | undefined)?.heygen?.avatarId || presenter.avatarId || '')
    || lock.voiceProfileId !== String((presenter.toolMappings as { heygen?: { voiceId?: string } } | undefined)?.heygen?.voiceId || presenter.voiceId || '')))) {
    return { ok: false, reason: 'named_presenter_lock_mismatch' };
  }
  return { ok: true, presenterAssetId: String(presenter.id), assetVersion: version };
}

/** A missing model measurement is an explicit non-executable decision. The
 * social Seedance product-scene adapter is not a presenter reenactment adapter. */
export function selectPresenterExecutions(input: {
  detail: Pick<SocialContentTaskDetail, 'agentWorkflow' | 'referenceVideoAnalysis' | 'assetSupplyPlan' | 'enterpriseProductBinding'>;
  heygenReady: boolean;
  /** Must describe an actual social presenter first-frame executor, not product-scene Seedance. */
  seedancePresenterReady: boolean;
  budgetReady: boolean;
}): PresenterExecutionSelection[] {
  const workflow = input.detail.agentWorkflow;
  if (!workflow) return [];
  const references = new Map((input.detail.referenceVideoAnalysis?.shots ?? []).map(shot => [shot.shotId, shot]));
  const executionByScene = new Map(workflow.executionPlan.scenes.map(scene => [scene.sceneId, scene]));
  const supplyByScene = new Map((input.detail.assetSupplyPlan?.shots ?? []).map(shot => [shot.shotId, shot]));
  const normalizeProductRef = (value: unknown) => String(value ?? '').normalize('NFKC').trim()
    .replace(/^product\s*:\s*/i, '').toLocaleLowerCase();
  return workflow.directorBrief.scenes.filter(scene => scene.productionRouting?.needsPreciseLipSync
    || scene.productionRouting?.presenterIdentityReplacementRequired).map(scene => {
    const execution = executionByScene.get(scene.sceneId);
    const selectedCandidate = execution?.candidates?.find(item => execution.recommendedCandidateIds?.includes(item.candidateId));
    const selectedStrategy = selectedCandidate?.sourceStrategy ?? execution?.selectedSourceStrategy;
    const reference = scene.referenceShotId ? references.get(scene.referenceShotId) : undefined;
    const supply = supplyByScene.get(scene.sceneId);
    const productBinding = input.detail.enterpriseProductBinding;
    const productAliases = new Set([productBinding?.productId, productBinding?.productSku]
      .map(normalizeProductRef).filter(Boolean));
    const matchingProductGroups = productBinding ? (supply?.productSceneReplication?.productIdentity.groups ?? [])
      .filter(group => productAliases.has(normalizeProductRef(group.productRef))) : [];
    const productImageIds = [...new Set(matchingProductGroups.flatMap(group => group.referenceImageIds)
      .map(value => value.trim()).filter(Boolean))];
    const enterpriseProductAssetLock = productBinding && productImageIds.length ? {
      productId: productBinding.productId,
      enterpriseFactRef: productBinding.enterpriseFactRef,
      referenceImageIds: productImageIds,
    } : null;
    const measurement = reference?.presenterMeasurements as PresenterShotMeasurements | undefined;
    const missing: PresenterShotMeasurements = {
      shotId: scene.referenceShotId || scene.sceneId,
      durationSeconds: scene.duration.targetSeconds,
      sourceFirstFrameRef: scene.referenceMaterial?.firstFrameRef ?? null,
      enterprisePresenterAssetRef: scene.productionRouting?.enterprisePresenterAssetRef ?? null,
      visibleSpeechSeconds: null, lipSyncRequired: null, specificGestureCount: null,
      bodyCenterTravelFrameWidth: null, cameraTravelFrameDiagonal: null,
      compositionLockRequired: null, physicalProductContact: null,
      decisionConfidence: 0, evidence: [],
    };
    const verifiedFirstFrame = scene.referenceMaterial?.extractionStatus === 'ready'
      ? scene.referenceMaterial.firstFrameRef : null;
    const governed: PresenterShotMeasurements = {
      ...(measurement ?? missing),
      shotId: scene.referenceShotId || scene.sceneId,
      sourceFirstFrameRef: verifiedFirstFrame || null,
      enterprisePresenterAssetRef: scene.productionRouting?.enterprisePresenterAssetRef ?? null,
      lipSyncRequired: scene.productionRouting?.needsPreciseLipSync ?? null,
      compositionLockRequired: scene.productionRouting?.needsCameraOrCompositionReconstruction ?? null,
    };
    // Phrase-level ASR is a measured source track. Intersect it with this
    // exact visual interval so narration shared across adjacent visual slots
    // becomes an auditable per-shot speech measurement. It does not claim
    // gesture, body, or camera CV measurements that were never performed.
    const verifiedSpeechIntervals = (reference?.spokenLines ?? []).flatMap(line => {
      if (line.precision !== 'phrase' || !line.provenance.trim()
        || !Number.isFinite(line.startSeconds) || !Number.isFinite(line.endSeconds)
        || line.endSeconds <= line.startSeconds || !reference) return [];
      const start = Math.max(reference.startSeconds, line.startSeconds);
      const end = Math.min(reference.endSeconds, line.endSeconds);
      return end > start ? [{ start, end, provenance: line.provenance }] : [];
    });
    const verifiedSpeechSeconds = +verifiedSpeechIntervals
      .reduce((total, interval) => total + interval.end - interval.start, 0).toFixed(3);
    if (verifiedSpeechSeconds > 0 && governed.sourceFirstFrameRef) {
      governed.visibleSpeechSeconds = verifiedSpeechSeconds;
      governed.evidence = [...governed.evidence, ...verifiedSpeechIntervals.map(interval => ({
        startSeconds: +(interval.start - reference!.startSeconds).toFixed(3),
        endSeconds: +(interval.end - reference!.startSeconds).toFixed(3),
        frameRef: governed.sourceFirstFrameRef!,
        observation: `逐句 ASR 与本镜头画面区间相交 ${verifiedSpeechSeconds.toFixed(3)} 秒（${interval.provenance}）`,
        fieldName: 'visibleSpeechSeconds' as const,
        sourceKind: 'verified_asr' as const,
      }))];
    }
    let decision = decidePresenterStack(governed, {
      heygen: input.heygenReady, seedance: input.seedancePresenterReady, budget: input.budgetReady,
      enterpriseProductAsset: Boolean(enterpriseProductAssetLock),
    });
    const selected = selectedStrategy;
    // Exact source speech plus the Director's frozen lip-sync requirement is
    // sufficient to select the talking presenter when optional motion CV was
    // not run. This does not infer a gesture or camera route.
    const verifiedSpeech = verifiedSpeechSeconds > 0;
    if (decision.route === 'needs_evidence' && scene.productionRouting?.needsPreciseLipSync
      && verifiedSpeech && governed.sourceFirstFrameRef && governed.enterprisePresenterAssetRef) {
      decision = {
        policyVersion: '1', route: 'heygen_talking', executable: input.heygenReady && input.budgetReady,
        reasonCodes: ['verified_phrase_speech_requires_talking_presenter'], measurements: governed,
      };
    }
    const reasonCodes = [...decision.reasonCodes];
    let providerId: PresenterExecutionSelection['providerId'] = null;
    if (selected !== 'authorized_digital_presenter') {
      reasonCodes.push('presenter_visible_requires_authorized_digital_presenter');
    } else if (decision.route === 'heygen_talking' && decision.executable) {
      providerId = 'heygen';
    }
    if (selected === 'authorized_digital_presenter' && decision.route === 'seedance_first_frame'
      && decision.executable && input.seedancePresenterReady) providerId = 'seedance';
    if (decision.route === 'no_presenter_stack') reasonCodes.push('presenter_visible_but_no_executable_stack_required');
    return {
      sceneId: scene.sceneId,
      referenceShotId: scene.referenceShotId,
      decision,
      providerId,
      executionStatus: providerId ? 'ready' : 'blocked',
      reasonCodes,
      enterpriseProductAssetLock,
    };
  });
}
