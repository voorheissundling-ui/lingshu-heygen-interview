import { createHash } from 'node:crypto';
import type { SocialTaskBudgetScope, SocialTaskCorrectionBudgetAuthorization } from '../lib/socialContentTaskBudget.js';
import type { SocialApprovedBudgetPlan, SocialPaidOperationIntent } from '../lib/socialContentTaskBudgetAuthority.js';
import type { SocialAssetSupplyShotPlan } from '../../shared/contracts/socialContentReplication.js';
export interface FrozenPaidProduction {
    scope: SocialTaskBudgetScope;
    baselineHash: string;
    recordHash: string;
    approval: {
        approved: boolean;
        reviewRef: string;
        sourceHash: string;
        planHash: string;
    };
    authorization: {
        ref: string;
        maximumCny: number;
        maximumExecutionCny?:number;
    };
    maximumRetries: number;
    /** Product shots with a completed, failed attempt-0 video QA receipt. */
    directedRetryShotIds?: string[];
    scenes: Array<{
        shotId: string;
        durationSeconds: number;
        spokenText: string;
        presenterSpeech?: 'included' | 'separate' | 'reused' | 'whole_track';
        presenterSpeechReceiptRef?: string | null;
    }>;
    /** A presenter group is one provider execution spanning an ordered, contiguous
     * run of frozen scenes. Scenes remain independently addressable downstream. */
    presenterGroups?: Array<{
        groupId: string;
        shotIds: string[];
        durationSeconds: number;
        spokenText: string;
        presenterAssetId: string;
        contractHash: string;
        executionKind?: 'seedance_motion';
    }>;
    shots: Array<Pick<SocialAssetSupplyShotPlan, 'shotId' | 'sourceStrategy' | 'fallbackSourceStrategy' | 'materialRouting' | 'sourceRefs' | 'digitalHumanPlan'>>;
    assets: Array<{
        assetId: string;
        contentHash: string;
        type: 'image' | 'video';
        verifiedAnalysisRef: string | null;
        analysisMode: 'image' | 'qwen_batches' | 'single_video';
        frameCount: number | null;
        analysisBatchFrameCounts: number[] | null;
    }>;
    voice: {
        presenterBinding?: import('./socialContentBoundPresenterVoice.js').BoundPresenterVoice | null;
        mode: 'none' | 'reuse' | 'continuous' | 'sentences';
        lines: string[];
        requiresClone: boolean;
        allowFallback: boolean;
        requiresAsr: boolean;
        requiresAlignment?: boolean;
        reuseReceiptRef: string | null;
    };
    finalReview: 'local' | 'paid' | 'paid_capacity';
}
export interface PaidStageRequirement {
    key: string;
    stage: string;
    shotId: string | null;
    sourceRef: string | null;
    durationSeconds: number | null;
    text: string | null;
    frameCount: number | null;
    presenterGroupId?: string;
    presenterGroupShotIds?: string[];
    presenterAssetId?: string;
    presenterGroupContractHash?: string;
    inputContractHash: string;
}
export interface BoundPaidRoute {
    provider: string;
    model: string;
    accountRef: string;
    routeEvidenceRef: string;
    usageBoundRef: string;
    maximumUnits: Record<string, number>;
    maximumAttempts: number;
}
export interface VerifiedLocalExecution {
    kind: 'existing_media' | 'local_render' | 'existing_audio' | 'analysis_cache';
    scopeHash: string;
    inputContractHash: string;
    receiptRef: string;
    sourceSha256: string;
    sourceRef: string | null;
}
export interface PaidOperationPlannerPorts {
    /** Reads canonical task/job executor binding, current approved execution review,
     * locked baseline/supply plan and actual server voice route. No request manifest. */
    readFrozenProduction(scope: SocialTaskBudgetScope): Promise<FrozenPaidProduction | null>;
    /** Confirms current tenant/task/run/plan and approved review identity again. */
    assertCurrent(scope: SocialTaskBudgetScope): Promise<void>;
    /** Reads provider/account configuration + enforced request usage bounds. */
    resolveBoundRoute(requirement: PaidStageRequirement): Promise<BoundPaidRoute | null>;
    /** Validates real tenant-bound registered bytes/caches and selected LOCAL executor.
     * Strategy names and client verified booleans are not execution evidence. */
    readVerifiedLocalExecution(requirement: PaidStageRequirement): Promise<VerifiedLocalExecution | null>;
    readProductFrameBounds(requirement: PaidStageRequirement): Promise<{
        inputContractHash: string;
        evidenceRef: string;
        firstFrameMaximumFrames: number;
        videoMaximumFrames: number;
    } | null>;
}
function stable(v: unknown): unknown {
    if (Array.isArray(v))
        return v.map(stable);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, stable(value)]));
    return v;
}
export const paidProductionHash = (v: unknown) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
export type FrozenPresenterGroup = NonNullable<FrozenPaidProduction['presenterGroups']>[number];
export function presenterGroupContractHash(input: Omit<FrozenPresenterGroup, 'contractHash'> | FrozenPresenterGroup) { const {contractHash:_,...value}=input as FrozenPresenterGroup; return paidProductionHash(value); }
export function paidProductionApprovalHash(input: FrozenPaidProduction) { return paidProductionHash({ scope: input.scope, baselineHash: input.baselineHash, scenes: input.scenes, presenterGroups: input.presenterGroups, shots: input.shots, voice: input.voice }); }
export function paidProductionRecordHash(input: Omit<FrozenPaidProduction, 'recordHash'> | FrozenPaidProduction) { const { recordHash: _, ...value } = input as FrozenPaidProduction; return paidProductionHash(value); }
const text = (v: unknown) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 512;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const potentiallyLocalRoutes = new Set(['customer_real_asset', 'licensed_stock_asset', 'customer_product_image_animation', 'motion_graphics', 'verified_fact_card']);
/** Appends exactly one new paid identity for each of the three presenter groups
 * affected by the historical first-frame consumption defect. Original attempt
 * zero operations and receipts remain part of the same plan and ledger. */
export function appendPresenterFirstFrameCorrectionAttempts(input:{scope:SocialTaskBudgetScope;requirements:PaidStageRequirement[];routeBindings:Record<string,BoundPaidRoute>;intents:SocialPaidOperationIntent[];authorization:SocialTaskCorrectionBudgetAuthorization;rejectedCorrectionOperationIds?:string[]}){
    const grant=input.authorization,groups=[...grant.affectedPresenterGroupIds];
    if(grant.runId!==input.scope.runId||grant.planHash!==input.scope.planHash||grant.tenantId!==input.scope.tenantId||grant.taskId!==input.scope.taskId
        ||grant.maximumCny>(grant.correctionCause==='approved_first_frame_not_consumed'?16.5:20)||groups.length!==3||new Set(groups).size!==3)throw Error('presenter_correction_authorization_invalid');
    const additions:SocialPaidOperationIntent[]=[];
    for(const groupId of groups){
        const requirements=input.requirements.filter(r=>r.stage==='presenter_video'&&r.presenterGroupId===groupId),requirement=requirements[0];
        if(requirements.length!==1||!requirement)throw Error('presenter_correction_group_invalid');
        const route=input.routeBindings[requirement.key],approval=grant.presenterApprovalBindings.find(item=>item.groupId===groupId);
        if(!route||!approval)throw Error('presenter_correction_binding_missing');
        const originalId=`paid-plan:${paidProductionHash({scope:input.scope,key:requirement.key,attempt:0})}`;
        const originals=input.intents.filter(intent=>intent.operationId===originalId&&intent.stage==='presenter_video');
        if(originals.length!==1)throw Error('presenter_correction_original_missing');
        const first={attempt:1 as const,kind:'presenter_video' as const,cause:grant.correctionCause,authorizationRef:grant.authorizationRef,presenterGroupId:groupId,approvalRecordHash:approval.approvalRecordHash};
        const firstId=`paid-plan:${paidProductionHash({scope:input.scope,key:requirement.key,attempt:1,correction:first})}`;
        const rejected=input.rejectedCorrectionOperationIds?.includes(firstId)===true;
        const attempt=rejected?2 as const:1 as const;
        const correction={...first,attempt};
        additions.push({operationId:`paid-plan:${paidProductionHash({scope:input.scope,key:requirement.key,attempt,correction})}`,provider:route.provider,model:route.model,accountRef:route.accountRef,stage:'presenter_video',shotId:null,inputContractHash:paidProductionHash({requirement,route,attempt,correction}),maximumUnits:{...route.maximumUnits},correction});
    }
    if(additions.some(add=>input.intents.some(intent=>intent.operationId===add.operationId&&paidProductionHash(intent)!==paidProductionHash(add))))throw Error('presenter_correction_operation_conflict');
    if(grant.correctionCause==='approved_first_frame_not_consumed_and_bound_voice_mismatch'){
        if(!grant.selectedVoiceId||!grant.selectedVoiceFingerprint)throw Error('presenter_correction_voice_binding_missing');
        const voiceStages=['tts',...(input.requirements.some(r=>r.stage==='voice_alignment')?['voice_alignment']:[])] as const;
        for(const stage of voiceStages){
            const matches=input.requirements.filter(r=>r.stage===stage),requirement=matches[0];
            if(matches.length!==1||!requirement)throw Error(`presenter_correction_${stage}_requirement_invalid`);
            const route=input.routeBindings[requirement.key];
            if(!route||(stage==='tts'&&(route.provider!=='heygen'||route.model!=='starfish')))throw Error(`presenter_correction_${stage}_route_invalid`);
            const correction={attempt:1 as const,kind:(stage==='tts'?'voice_tts':'voice_alignment') as 'voice_tts'|'voice_alignment',cause:grant.correctionCause,authorizationRef:grant.authorizationRef,selectedVoiceId:grant.selectedVoiceId,selectedVoiceFingerprint:grant.selectedVoiceFingerprint};
            additions.push({operationId:`paid-plan:${paidProductionHash({scope:input.scope,key:requirement.key,attempt:1,correction})}`,provider:route.provider,model:route.model,accountRef:route.accountRef,stage:requirement.stage,shotId:requirement.shotId,inputContractHash:paidProductionHash({requirement,route,attempt:1,correction}),maximumUnits:{...route.maximumUnits},correction});
        }
    }
    if(additions.some(add=>input.intents.some(intent=>intent.operationId===add.operationId&&paidProductionHash(intent)!==paidProductionHash(add))))throw Error('presenter_correction_operation_conflict');
    return [...input.intents,...additions.filter(add=>!input.intents.some(intent=>intent.operationId===add.operationId))];
}
/** Enumerates actual dependencies, not client-provided paid operations. Unknown
 * executable routes/batch sizes/fallbacks are blockers; no model/account guesses. */
export function createSocialContentPaidOperationPlanner(ports: PaidOperationPlannerPorts) {
    return { async plan(scope: SocialTaskBudgetScope): Promise<{
            plan: SocialApprovedBudgetPlan | null;
            requirements: PaidStageRequirement[];
            gaps: string[];
        }> {
            await ports.assertCurrent(scope);
            const input = await ports.readFrozenProduction(scope), gaps: string[] = [], requirements: PaidStageRequirement[] = [];
            const gap = (s: string) => {
                if (!gaps.includes(s))
                    gaps.push(s);
            };
            if (!input || !Array.isArray(input.scenes) || !Array.isArray(input.shots) || !Array.isArray(input.assets) || (input.presenterGroups!==undefined&&(!Array.isArray(input.presenterGroups)||input.presenterGroups.some(group=>!group||typeof group!=='object'||!Array.isArray(group.shotIds)))) || !input.voice || !Array.isArray(input.voice.lines) || input.scenes.some(s => typeof s.spokenText !== 'string') || !['local', 'paid', 'paid_capacity'].includes(input.finalReview) || paidProductionHash(input.scope) !== paidProductionHash(scope) || !hash(input.baselineHash) || input.recordHash !== paidProductionRecordHash(input) || input.approval?.approved !== true || !text(input.approval.reviewRef) || input.approval.planHash !== scope.planHash || input.approval.sourceHash !== paidProductionApprovalHash(input) || !text(input.authorization?.ref) || !Number.isFinite(input.authorization?.maximumCny) || input.authorization.maximumCny <= 0 || !Number.isInteger(input.maximumRetries) || input.maximumRetries < 0 || input.maximumRetries > 3 || (input.directedRetryShotIds !== undefined && (!Array.isArray(input.directedRetryShotIds) || input.directedRetryShotIds.some(id => !text(id)) || new Set(input.directedRetryShotIds).size !== input.directedRetryShotIds.length)))
                return { plan: null, requirements, gaps: ['frozen_approved_production_unverified'] };
            // Financial planning may select another executor, but may never
            // drop a locked scene or substitute another scene with the same count.
            // Validate coverage before any runtime reader or local render runs.
            if (!input.scenes.length || new Set(input.scenes.map(s => s.shotId)).size !== input.scenes.length || new Set(input.shots.map(s => s.shotId)).size !== input.shots.length || input.scenes.length !== input.shots.length
                || input.scenes.some(scene => !input.shots.some(shot => shot.shotId === scene.shotId)))
                return { plan: null, requirements, gaps: ['scene_mapping_invalid'] };
            if (input.scenes.some(scene => !text(scene.shotId) || !Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0))
                return { plan: null, requirements, gaps: ['scene_contract_missing'] };
            const presenterGroups=input.presenterGroups||[], presenterGroupByShot=new Map<string,FrozenPresenterGroup>();
            if(new Set(presenterGroups.map(group=>group.groupId)).size!==presenterGroups.length)return {plan:null,requirements,gaps:['presenter_group_contract_invalid']};
            let previousGroupLastIndex=-2, previousGroupPresenter='';
            for(const group of presenterGroups){
                const indexes=group.shotIds.map(id=>input.scenes.findIndex(scene=>scene.shotId===id));
                const scenes=group.shotIds.map(id=>input.scenes.find(scene=>scene.shotId===id));
                const shots=group.shotIds.map(id=>input.shots.find(shot=>shot.shotId===id));
                const presenterIds=shots.map(shot=>[...new Set(shot?.digitalHumanPlan?.presenterAssetIds?.length?shot.digitalHumanPlan.presenterAssetIds:shot?.sourceRefs||[])]);
                if(!text(group.groupId)||!group.shotIds.length||new Set(group.shotIds).size!==group.shotIds.length||group.contractHash!==presenterGroupContractHash(group)
                    ||indexes.some(i=>i<0)||indexes.some((value,index)=>index>0&&value!==indexes[index-1]!+1)
                    ||scenes.some(scene=>!scene||(group.executionKind!=='seedance_motion'&&scene.presenterSpeech!=='whole_track'))||shots.some(shot=>shot?.sourceStrategy!=='authorized_digital_presenter')
                    ||presenterIds.some(ids=>ids.length!==1||ids[0]!==group.presenterAssetId)
                    ||Math.abs(scenes.reduce((sum,scene)=>sum+(scene?.durationSeconds||0),0)-group.durationSeconds)>1e-9
                    ||scenes.map(scene=>scene?.spokenText||'').join(' ')!==group.spokenText
                    ||(group.executionKind!=='seedance_motion'&&!group.spokenText.trim())
                    ||(group.executionKind==='seedance_motion'&&(group.shotIds.length!==1||shots.some(shot=>shot?.digitalHumanPlan?.method!=='reenact'||(shot.digitalHumanPlan as typeof shot.digitalHumanPlan&{silentMotion?:boolean}).silentMotion!==true)))
                    ||indexes[0]!<=previousGroupLastIndex||(group.executionKind!=='seedance_motion'&&indexes[0]===previousGroupLastIndex+1&&group.presenterAssetId===previousGroupPresenter)
                    ||group.shotIds.some(id=>presenterGroupByShot.has(id))){
                    return {plan:null,requirements,gaps:['presenter_group_contract_invalid']};
                }
                group.shotIds.forEach(id=>presenterGroupByShot.set(id,group));
                previousGroupLastIndex=indexes.at(-1)!;previousGroupPresenter=group.executionKind==='seedance_motion'?'':group.presenterAssetId;
            }
            if(presenterGroups.length&&input.scenes.some(scene=>scene.presenterSpeech==='whole_track'&&input.shots.find(shot=>shot.shotId===scene.shotId)?.sourceStrategy==='authorized_digital_presenter'&&!presenterGroupByShot.has(scene.shotId)))
                return {plan:null,requirements,gaps:['presenter_group_coverage_invalid']};
            const make = (key: string, stage: string, shotId: string | null, sourceRef: string | null, durationSeconds: number | null, spoken: string | null, frameCount: number | null, presenterGroup?:FrozenPresenterGroup): PaidStageRequirement => {
                const groupFields=presenterGroup?{presenterGroupId:presenterGroup.groupId,presenterGroupShotIds:[...presenterGroup.shotIds],presenterAssetId:presenterGroup.presenterAssetId,presenterGroupContractHash:presenterGroup.contractHash}:{};
                return { key, stage, shotId, sourceRef, durationSeconds, text: spoken, frameCount,...groupFields, inputContractHash: paidProductionHash({ scope, baselineHash: input.baselineHash, approvalSourceHash: input.approval.sourceHash, key, stage, shotId, sourceRef, durationSeconds, spoken, frameCount,...groupFields }) };
            };
            const add = (...args: Parameters<typeof make>) => { const r = make(...args); requirements.push(r); return r; };
            const local = async (requirement: PaidStageRequirement, kinds: VerifiedLocalExecution['kind'][], expectedReceipt?: string) => {
                const proof = await ports.readVerifiedLocalExecution(requirement);
                return Boolean(proof && kinds.includes(proof.kind) && proof.scopeHash === paidProductionHash(scope) && proof.inputContractHash === requirement.inputContractHash && text(proof.receiptRef) && hash(proof.sourceSha256) && (!expectedReceipt || proof.receiptRef === expectedReceipt)
                    && (requirement.stage !== 'material_analysis_cache' || proof.sourceSha256 === requirement.sourceRef)
                    && (!['render_audio_reuse', 'presenter_audio_reuse'].includes(requirement.stage) || proof.receiptRef === requirement.sourceRef)
                    && (requirement.stage !== 'local_supply_selection' || proof.kind !== 'existing_media' || Boolean(proof.sourceRef && input.shots.find(s => s.shotId === requirement.shotId)?.sourceRefs.includes(proof.sourceRef))));
            };
            if (new Set(input.assets.map(a => a.assetId)).size !== input.assets.length)
                gap('material_source_duplicate');
            for(const group of presenterGroups){
                // The review image is a real paid production artifact.  One
                // Seedream edit removes the reference person and composites
                // the authorised presenter; Qwen then independently reviews
                // that image.  Both are reserved with the later mother video
                // so the whole-film cap is proven before either provider sees
                // a request.
                add(`presenter-group:${group.groupId}:first-frame`,'first_frame',group.groupId,null,null,null,null,group);
                add(`presenter-group:${group.groupId}:first-frame-qa`,'first_frame_qa',group.groupId,null,null,null,3,group);
                add(`presenter-group:${group.groupId}:presenter`,'presenter_video',null,null,group.durationSeconds,group.spokenText,null,group);
                if(group.executionKind==='seedance_motion') add(`presenter-group:${group.groupId}:video-qa`,'video_qa',group.groupId,null,group.durationSeconds,null,4,group);
            }
            for (const asset of input.assets) {
                if (!text(asset.assetId) || !hash(asset.contentHash)) {
                    gap('material_source_hash_missing');
                    continue;
                }
                if (asset.verifiedAnalysisRef) {
                    const cached = make(`asset:${asset.assetId}:cache`, 'material_analysis_cache', null, asset.contentHash, null, null, null);
                    if (!text(asset.verifiedAnalysisRef) || !await local(cached, ['analysis_cache'], asset.verifiedAnalysisRef))
                        gap('material_analysis_receipt_invalid');
                    continue;
                }
                if (asset.type === 'image' && asset.analysisMode === 'image')
                    add(`asset:${asset.assetId}:image`, 'material_image_analysis', null, asset.contentHash, null, null, 1);
                else if (asset.type === 'video' && asset.analysisMode === 'qwen_batches') {
                    const batches = asset.analysisBatchFrameCounts;
                    if (!Number.isInteger(asset.frameCount) || Number(asset.frameCount) <= 0 || !batches?.length || batches.some(n => !Number.isInteger(n) || n <= 0) || batches.reduce((a, b) => a + b, 0) !== asset.frameCount) {
                        gap('material_analysis_batch_bound_missing');
                        continue;
                    }
                    batches.forEach((n, i) => { add(`asset:${asset.assetId}:${i}:analysis`, 'material_video_analysis', null, asset.contentHash, null, null, n); add(`asset:${asset.assetId}:${i}:review`, 'material_video_review', null, asset.contentHash, null, null, n); });
                }
                else if (asset.type === 'video' && asset.analysisMode === 'single_video' && Number.isInteger(asset.frameCount) && Number(asset.frameCount) > 0)
                    add(`asset:${asset.assetId}:video`, 'material_video_analysis', null, asset.contentHash, null, null, asset.frameCount);
                else
                    gap('material_analysis_route_unknown');
            }
            for (const shot of input.shots) {
                const scene = input.scenes.find(s => s.shotId === shot.shotId);
                if (!scene || !text(scene.shotId) || !Number.isFinite(scene.durationSeconds) || scene.durationSeconds <= 0) {
                    gap('scene_contract_missing');
                    continue;
                }
                const routes = [shot.sourceStrategy, ...(shot.fallbackSourceStrategy ? [shot.fallbackSourceStrategy] : [])];
                for (const route of [...new Set(routes)]) {
                    const key = `scene:${shot.shotId}:${route}`;
                    if (potentiallyLocalRoutes.has(route)) {
                        const selected = make(key, 'local_supply_selection', shot.shotId, null, scene.durationSeconds, scene.spokenText, null);
                        if (!await local(selected, ['existing_media', 'local_render']))
                            gap(`supply_route_execution_unverified:${route}:${shot.shotId}`);
                        continue;
                    }
                    if (route === 'aigc_product_scene_replication' && ['reference_first_frame_product_replacement_i2v', 'enterprise_authored_product_first_frame_i2v'].includes(shot.materialRouting?.generation?.method || '')) {
                        const extraction = make(`${key}:frames`, 'product_frame_extract_plan', shot.shotId, null, scene.durationSeconds, null, null);
                        const bounds = await ports.readProductFrameBounds(extraction);
                        if (!bounds || bounds.inputContractHash !== extraction.inputContractHash || !text(bounds.evidenceRef) || !Number.isInteger(bounds.firstFrameMaximumFrames) || bounds.firstFrameMaximumFrames < 1 || !Number.isInteger(bounds.videoMaximumFrames) || bounds.videoMaximumFrames < 1) {
                            gap('product_frame_extract_bound_missing');
                            continue;
                        }
                        for (const stage of ['first_frame', 'first_frame_qa', 'video', 'video_qa'])
                            add(`${key}:${stage}`, stage, shot.shotId, null, stage === 'video' || stage === 'video_qa' ? scene.durationSeconds : null, null, stage === 'first_frame_qa' ? bounds.firstFrameMaximumFrames : stage === 'video_qa' ? bounds.videoMaximumFrames : null);
                    }
                    else if (route === 'authorized_digital_presenter') {
                        // A whole-track presenter group owns one continuous speech
                        // request. Visual continuation shots may intentionally have
                        // no independent line; the frozen group text was validated
                        // above and is what the provider receives.
                        const motionGroup=presenterGroupByShot.get(shot.shotId)?.executionKind==='seedance_motion';
                        if (!motionGroup&&((!presenterGroupByShot.has(shot.shotId) && !scene.spokenText.trim()) || !scene.presenterSpeech))
                            gap('presenter_speech_route_missing');
                        if (!presenterGroupByShot.has(shot.shotId)) add(`${key}:presenter`, 'presenter_video', shot.shotId, null, scene.durationSeconds, scene.spokenText, null);
                        if (scene.presenterSpeech === 'reused' && (!text(scene.presenterSpeechReceiptRef) || !await local(make(`${key}:speech-reuse`, 'presenter_audio_reuse', shot.shotId, scene.presenterSpeechReceiptRef || null, scene.durationSeconds, scene.spokenText, null), ['existing_audio'])))
                            gap('presenter_speech_reuse_receipt_missing');
                        if (scene.presenterSpeech === 'whole_track' && (input.voice.mode !== 'continuous' || !input.voice.requiresAlignment)) gap('presenter_whole_track_alignment_dependency_missing');
                        if (scene.presenterSpeech === 'separate')
                            add(`${key}:speech`, 'presenter_tts', shot.shotId, null, scene.durationSeconds, scene.spokenText, null);
                    }
                    else
                        gap(`paid_supply_route_not_planned:${route}`);
                }
            }
            const voice = input.voice, spoken = voice.lines.join(' ').trim();
            if (voice.mode === 'none' && input.scenes.some(s => s.spokenText.trim()))
                gap('render_voice_route_missing');
            if (voice.mode === 'reuse' && (voice.requiresClone || voice.allowFallback))
                gap('voice_reuse_route_inconsistent');
            if (voice.mode !== 'none' && spoken.replace(/\s+/g, '') !== input.scenes.map(s => s.spokenText).join(' ').replace(/\s+/g, ''))
                gap('voice_text_not_frozen_baseline');
            if (!['none', 'reuse', 'continuous', 'sentences'].includes(voice.mode))
                gap('voice_route_unknown');
            if (voice.mode === 'reuse' && (!text(voice.reuseReceiptRef) || !await local(make('voice:reuse', 'render_audio_reuse', null, voice.reuseReceiptRef, null, spoken, null), ['existing_audio'])))
                gap('voice_reuse_receipt_missing');
            if (voice.mode === 'none' && (voice.requiresClone || voice.allowFallback || voice.requiresAsr))
                gap('voice_route_inconsistent');
            if (voice.mode === 'continuous' || voice.mode === 'sentences') {
                if (!voice.lines.length || voice.lines.some(s => typeof s !== 'string' || !s.trim()) || !spoken)
                    gap('voice_text_missing');
                const speech = voice.mode === 'sentences' ? voice.lines : [spoken];
                if (voice.requiresClone)
                    add('voice:clone', 'voice_clone', null, null, null, spoken, null);
                speech.forEach((s, i) => {
                    add(`voice:${i}:tts`, 'tts', null, null, null, s, null);
                    if (voice.allowFallback)
                        add(`voice:${i}:fallback`, 'tts_fallback', null, null, null, s, null);
                });
            }
            if (voice.requiresAlignment && voice.mode !== 'none') add('voice:alignment', 'voice_alignment', null, voice.reuseReceiptRef, null, spoken, null);
            if (voice.requiresAsr && voice.mode !== 'none')
                add('voice:asr', 'voice_asr', null, voice.reuseReceiptRef, null, spoken, null);
            if (input.finalReview === 'paid')
                add('final:director-review', 'director_review', null, null, null, null, null);
            if (input.finalReview === 'paid_capacity')
                add('final:director-review-capacity', 'director_review_capacity', null, null, null, null, input.scenes.length * 3);
            const operations: SocialPaidOperationIntent[] = [];
            for (const requirement of requirements) {
                const route = await ports.resolveBoundRoute(requirement);
                if (!route || ![route.provider, route.model, route.accountRef, route.routeEvidenceRef, route.usageBoundRef].every(text) || !Number.isInteger(route.maximumAttempts) || route.maximumAttempts < 1 || route.maximumAttempts > input.maximumRetries + 1 || !route.maximumUnits || !Object.keys(route.maximumUnits).length || Object.values(route.maximumUnits).some(n => !Number.isFinite(n) || n < 0)) {
                    gap(`provider_usage_bound_missing:${requirement.key}`);
                    continue;
                }
                if ((requirement.durationSeconds !== null && 'providerSeconds' in route.maximumUnits && route.maximumUnits.providerSeconds! < requirement.durationSeconds) || (requirement.text !== null && 'characters' in route.maximumUnits && route.maximumUnits.characters! < [...requirement.text].length) || (requirement.frameCount !== null && 'frames' in route.maximumUnits && route.maximumUnits.frames! < requirement.frameCount)) {
                    gap(`provider_usage_bound_insufficient:${requirement.key}`);
                    continue;
                }
                // Product video QA may authorize one directed regeneration from
                // the already-approved first frame. Frame generation is never
                // repeated; every additional video/QA POST remains a distinct
                // pre-priced operation in this same task/run budget scope.
                const plannedAttempts = ['video', 'video_qa'].includes(requirement.stage)
                    && requirement.shotId && input.directedRetryShotIds?.includes(requirement.shotId)
                    && input.shots.find(shot => shot.shotId === requirement.shotId)?.sourceStrategy === 'aigc_product_scene_replication'
                    ? Math.min(2, input.maximumRetries + 1)
                    : route.maximumAttempts;
                for (let attempt = 0; attempt < plannedAttempts; attempt++)
                    operations.push({ operationId: requirement.stage==='director_review_capacity'
                        ? `director-g5-${paidProductionHash({scope,key:requirement.key,attempt})}`
                        : `paid-plan:${paidProductionHash({ scope, key: requirement.key, attempt })}`, provider: route.provider, model: route.model, accountRef: route.accountRef, stage: requirement.stage, shotId: requirement.shotId, inputContractHash: paidProductionHash({ requirement, route, attempt }), maximumUnits: { ...route.maximumUnits } });
            }
            await ports.assertCurrent(scope);
            const current = await ports.readFrozenProduction(scope);
            if (!current || current.recordHash !== input.recordHash || paidProductionRecordHash(current) !== input.recordHash)
                gap('frozen_production_changed');
            if (gaps.length)
                return { plan: null, requirements, gaps };
            return { plan: { scope, authorizationRef: input.authorization.ref, maximumCny: Math.min(15, input.authorization.maximumCny), maximumExecutionCny:input.authorization.maximumExecutionCny,paidOperations: operations,
                ...(presenterGroups.length ? {presenterGroups: structuredClone(presenterGroups)} : {}) }, requirements, gaps };
        } };
}
