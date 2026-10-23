import type { BoundPresenterVoice } from './socialContentBoundPresenterVoice.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {createProductionBudgetRouteReaders} from './socialContentProductionBudgetRoutes.js';
import type { ProductionBudgetReadPorts } from './socialContentProductionBudgetPreflight.js';
import type { InternalSocialContentFormula } from './socialContentThemes.js';
import { socialDirectorFrozenDirection } from './socialContentDirectorPlan.js';
import { socialDirectorSpokenNarration } from './socialContentDirectorHandoff.js';
import {resolveStudioVoiceExecutionPlan} from '../lib/socialContentLegacyPorts.js';
import {nativeVoiceBillableCharacters} from '../lib/studioVoiceBilling.js';
import {productionBillingAccountRef} from './socialContentProductionBudgetRoutes.js';
import {paidProductionHash,type BoundPaidRoute} from './socialContentPaidOperationPlan.js';
import {getQwenAsrProviderBinding,getQwenProviderBinding} from '../agents/qwen.js';
/** Trusted server factory. No request body, supplier request or business write.
 * Formula is the resolved version already used by production; an absent or
 * different formula cannot be replaced by a speculative voice selection. */
export function createProductionBudgetRuntimeReaders(input: {
    tenantId?: string;
    readPresenterVoice?: () => Promise<BoundPresenterVoice | null>;
    requiresMeasuredAlignment?: boolean;
    frozenTrackSeconds?: number;
    formula?: InternalSocialContentFormula | null;
    env?: NodeJS.ProcessEnv;
    localExecutionReader?: ProductionBudgetReadPorts['readVerifiedLocalExecution'];
} = {}): Pick<ProductionBudgetReadPorts, 'readVoicePlan' | 'readAnalysisFrames' | 'readVerifiedLocalExecution' | 'resolveBoundRoute' | 'readProductFrameBounds'> {
    const env = { ...(input.env || process.env) };
    const baseReaders=createProductionBudgetRouteReaders({env:()=>input.env||process.env});
    let voicePlan: ReturnType<typeof resolveStudioVoiceExecutionPlan>|null=null;
    const configuredTrackSeconds = Number(input.frozenTrackSeconds);
    const frozenTrackSeconds = Number.isFinite(configuredTrackSeconds) && configuredTrackSeconds > 0
      ? Math.ceil(configuredTrackSeconds) : 300;
    return {
        ...baseReaders,
        async resolveBoundRoute(requirement) {
            if(requirement.stage==='tts') {
                const p=voicePlan?.primary;if(!p)return null;
                const index=Number(requirement.key.match(/^voice:(\d+):tts$/)?.[1]);
                if(!Number.isSafeInteger(index)||voicePlan?.texts[index]!==requirement.text||!p.texts[index])return null;
                return {provider:p.provider,model:p.model,accountRef:productionBillingAccountRef(p.provider,p.endpoint,p.accountKeyHash),routeEvidenceRef:'studio-native:'+paidProductionHash(p),usageBoundRef:'actual-native-prepared-text:'+paidProductionHash({text:p.texts[index],voiceId:p.voiceId}),maximumAttempts:1,maximumUnits:p.provider==='heygen'?{audioSeconds:frozenTrackSeconds*2}:{characters:nativeVoiceBillableCharacters(p.texts[index])}} satisfies BoundPaidRoute;
            }
            if(requirement.stage==='voice_alignment'&&voicePlan?.asrConfigured) {
                let b:ReturnType<typeof getQwenProviderBinding>;try{b=getQwenProviderBinding(env);}catch{return null;}
                const base=(env.DASHSCOPE_ASR_BASE_URL||'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/,'');
                if(base!=='https://dashscope.aliyuncs.com/api/v1')return null;
                const endpoint=base+'/services/audio/asr/transcription';
                return {provider:'qwen',model:'qwen3-asr-flash-filetrans',accountRef:productionBillingAccountRef('qwen',endpoint,b.credentialSha256),routeEvidenceRef:'sdk-native-alignment:'+paidProductionHash({endpoint,credentialSha256:b.credentialSha256}),usageBoundRef:`frozen-native-track-${frozenTrackSeconds}-seconds`,maximumAttempts:1,maximumUnits:{audioSeconds:frozenTrackSeconds}} satisfies BoundPaidRoute;
            }
            if(requirement.stage==='voice_asr'&&voicePlan?.asrConfigured) {
                let binding:ReturnType<typeof getQwenAsrProviderBinding>;try{binding=getQwenAsrProviderBinding(env);}catch{return null;}
                const model=env.QWEN_ASR_MODEL||'qwen3-asr-flash';
                if(model!=='qwen3-asr-flash'||binding.baseUrl!=='https://dashscope.aliyuncs.com/compatible-mode/v1')return null;
                return {provider:'qwen',model,accountRef:productionBillingAccountRef('qwen',binding.baseUrl,binding.credentialSha256),routeEvidenceRef:'sdk-native-asr:'+paidProductionHash({binding,frozenTrackSeconds}),usageBoundRef:`frozen-native-track-${frozenTrackSeconds}-seconds`,maximumAttempts:1,maximumUnits:{audioSeconds:frozenTrackSeconds}} satisfies BoundPaidRoute;
            }
            return baseReaders.resolveBoundRoute(requirement);
        },
        async readVoicePlan(baseline) {
            const ref = baseline.formulaReference;
            if (ref && (!input.formula || input.formula.formulaId !== ref.formulaId || input.formula.version !== ref.version))
                return null;
            const direction = socialDirectorFrozenDirection({ baseline, formula: input.formula, duration: 0 });
            const text = socialDirectorSpokenNarration(baseline.scenes.map(scene => ({ voiceover: scene.voiceover || scene.narration })), baseline.language);
            if(!input.tenantId)return null;
            voicePlan=resolveStudioVoiceExecutionPlan({tenantId:input.tenantId,text,voice:(await input.readPresenterVoice?.())?.logicalVoice || direction.voiceover.voice,language:baseline.language,style:{preset:direction.voiceover.preset,speed:direction.voiceover.speed,pauseStyle:direction.voiceover.pauseStyle},env});
            // Select a supported native CNY route while creating a new paid plan;
            // freeze this choice in canonical routes. Existing execution never
            // changes provider implicitly after an accepted request.
            if(!voicePlan.logicalVoice.startsWith('heygen:')&&!voicePlan.custom&&voicePlan.primary?.provider==='minimax'&&new URL(voicePlan.primary.endpoint).hostname==='api.minimax.io'&&(env.QWEN_TTS_MODEL||'qwen3-tts-flash')==='qwen3-tts-flash') {
                const qwenPlan=resolveStudioVoiceExecutionPlan({tenantId:input.tenantId,text,voice:(await input.readPresenterVoice?.())?.logicalVoice || direction.voiceover.voice,language:baseline.language,style:{preset:direction.voiceover.preset,speed:direction.voiceover.speed,pauseStyle:direction.voiceover.pauseStyle},env,nativeProvider:'qwen'});
                if(qwenPlan.primary&&qwenPlan.primary.endpoint==='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')voicePlan=qwenPlan;
            }
            return {mode:voicePlan.mode,lines:voicePlan.mode==='continuous'?voicePlan.texts:voicePlan.lines,requiresClone:Boolean(voicePlan.custom?.requiresClone||voicePlan.custom?.requiresActivation),allowFallback:false,requiresAsr:voicePlan.asrConfigured,requiresAlignment:input.requiresMeasuredAlignment===true,reuseReceiptRef:null,presenterBinding:await input.readPresenterVoice?.() || null};
        },
        async readAnalysisFrames(asset) {
            if (asset.type !== 'video' || !asset.localPath || (env.VIDEO_ANALYSIS_PROVIDER || 'qwen').trim().toLowerCase() !== 'qwen')
                return null;
            const h = createHash('sha256');
            for await (const part of fs.createReadStream(asset.localPath))
                h.update(part);
            if (h.digest('hex') !== asset.contentHash)
                throw Error('production_budget_analysis_source_changed');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-analysis-'));
            try {
                const { resolveSourceDurations } = await import('../lib/videoSourcePlan.js');
                const { runVisualFfmpeg } = await import('../lib/renderVisualQuality.js');
                const { extractQwenAnalysisFrames } = await import('../lib/videoAnalysisLegacyPort.js');
                const { materialFrameBatches } = await import('../digitalEmployees/productionMaterialAnalysis.js');
                const [resolved] = await resolveSourceDurations([asset]);
                if (!resolved?.duration)
                    return null;
                const proxy = path.join(dir, 'analysis-proxy.mp4');
                const prepared = await runVisualFfmpeg(['-i', asset.localPath, '-map', '0:v:0', '-an', '-vf', "scale='min(960,iw)':-2", '-r', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-y', proxy], false, { timeoutMs: 120000 });
                if (!prepared.ok || !fs.existsSync(proxy))
                    throw Error('production_budget_analysis_proxy_failed');
                const frames = await extractQwenAnalysisFrames(proxy, Math.max(18, Math.min(48, Math.ceil(resolved.duration * 2))), resolved.duration);
                const after = createHash('sha256');
                for await (const part of fs.createReadStream(asset.localPath))
                    after.update(part);
                if (after.digest('hex') !== asset.contentHash)
                    throw Error('production_budget_analysis_source_changed');
                return { frameCount: frames.length, batchFrameCounts: materialFrameBatches(frames, resolved.duration).map(batch => batch.frames.length) };
            }
            finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        async readVerifiedLocalExecution(requirement) {
            // Strategy names are not receipts: animation/stock/graphics can all incur
            // supplier charges. Only the actual selected canonical adapter may attest.
            return input.localExecutionReader ? input.localExecutionReader(requirement) : null;
        }
    };
}
