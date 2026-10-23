import { createHash } from 'node:crypto';
import type { PaidStageRequirement, BoundPaidRoute } from './socialContentPaidOperationPlan.js';
import { paidProductionHash } from './socialContentPaidOperationPlan.js';
import { getQwenProviderBinding, getDirectorG5QwenModel, materialAnalysisTokenBudget } from '../agents/qwen.js';
import {readQwenMaaSVisionCatalog} from '../lib/qwenMaaSModelCatalog.js';
import {classifyQwenCompatibleEndpoint} from '../lib/qwenCompatibleEndpoint.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';
import { validateFirstFrameRequest, firstFrameInputFingerprint, type FirstFrameRequest } from '../lib/firstFrameGenerator.js';
export interface FrozenProductBudgetInputs {
    inputContractHash: string;
    firstFrame: FirstFrameRequest;
    productReferenceCount: number;
    video: {
        model: string;
        baseUrl: string;
        credentialSha256: string;
        providerDurationSeconds: number;
        resolution: '720p';
        ratio: '9:16';
        maximumOutputTokens: number;
        usageBoundRef: string;
    };
    qaModel: string;
}
export interface CanonicalProductBudgetBounds {qaModel?:'qwen3-vl-plus';videoProvider?:'wan'|'seedance';videoModel?:'wan2.6-i2v-flash'|'wan2.2-i2v-flash';firstFrameMaximumFrames:number;videoMaximumFrames:number;productSha256s:string[];providerDurationSeconds:number;evidenceRef:string;}
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const official = (base: string, host: string) => { try {
    const u = new URL(base);
    return u.protocol === 'https:' && u.hostname === host && u.pathname.replace(/\/+$/, '') === (host === 'dashscope.aliyuncs.com' ? '/compatible-mode/v1' : '/api/v3') && !u.username && !u.password && !u.search && !u.hash;
}
catch {
    return false;
} };
export function productionBillingAccountRef(provider: string, baseUrl: string, credentialSha256: string) { if (!/^[a-f0-9]{64}$/.test(credentialSha256))
    throw Error('production_billing_credential_missing'); return `${provider}:${paidProductionHash({ baseUrl: baseUrl.replace(/\/+$/, ''), credentialSha256 })}`; }
/** Actual SDK configuration, read again at every submission boundary. */
export function createProductionBudgetRouteReaders(input: {
    env?: () => NodeJS.ProcessEnv;
    readQwenBinding?: typeof getQwenProviderBinding;
    readFrozenProduct?: (requirement: PaidStageRequirement) => Promise<FrozenProductBudgetInputs | null>;
    readCanonicalProductBounds?: (requirement:PaidStageRequirement)=>Promise<CanonicalProductBudgetBounds|null>;
    readQwenVisionCatalog?: typeof readQwenMaaSVisionCatalog;
} = {}) {
    const env = () => input.env?.() || process.env;
    const qwen = () => input.readQwenBinding?.() || getQwenProviderBinding();
    const ark = (provider: 'seedance' | 'seedream') => { const e = env(), key = (provider === 'seedream' ? e.SEEDREAM_API_KEY || e.SEEDANCE_API_KEY : e.SEEDANCE_API_KEY) || '', base = (provider === 'seedream' ? e.SEEDREAM_BASE_URL || e.SEEDANCE_BASE_URL : e.SEEDANCE_BASE_URL) || 'https://ark.cn-beijing.volces.com/api/v3'; if (!key.trim() || !official(base, 'ark.cn-beijing.volces.com'))
        return null; return { baseUrl: base, credentialSha256: digest(key.trim()), model: provider === 'seedream' ? e.SEEDREAM_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628' : e.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128' }; };
    const qwenRoute = async (stage: string, model: string, frames: number, output: number): Promise<BoundPaidRoute | null> => {
        let binding: ReturnType<typeof getQwenProviderBinding>;
        try {
            binding = qwen();
        }
        catch {
            return null;
        }
        if (classifyQwenCompatibleEndpoint(binding.baseUrl)!=='qianwen-maas' || !(/^(qwen3-vl-(flash|plus)|qwen-vl-max)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)))
            return null;
        const catalog=await (input.readQwenVisionCatalog??readQwenMaaSVisionCatalog)({endpoint:binding.baseUrl,credentialSha256:binding.credentialSha256,model});
        if(!catalog||catalog.endpoint!==binding.baseUrl.replace(/\/+$/,'')||catalog.credentialSha256!==binding.credentialSha256||catalog.model!==model||!catalog.evidenceRef)return null;
        // Official model context window is an absolute accepted-request envelope,
        // not observed usage. Consumer must measure its actual multimodal body.
        return { provider: 'qwen', model, accountRef: productionBillingAccountRef('qwen', binding.baseUrl, binding.credentialSha256), routeEvidenceRef: catalog.evidenceRef, usageBoundRef: `https://help.aliyun.com/zh/model-studio/${model.startsWith('qwen-vl-max') ? 'qwen-vl-max' : `qwen3-vl-${model.includes('plus') ? 'plus' : 'flash'}`}#context-window:${stage}:actual-frames:${frames}`, maximumAttempts: 1, maximumUnits: { inputTokens: qwenVisionInputLimit(model), outputTokens: output } };
    };
    return {
        async resolveBoundRoute(r: PaidStageRequirement): Promise<BoundPaidRoute | null> {
            if(r.stage==='director_review_capacity'){
                if(!Number.isSafeInteger(r.frameCount)||r.frameCount!<3||r.frameCount!>90)return null;
                const route=await qwenRoute(r.stage,getDirectorG5QwenModel(),r.frameCount!,2400);
                return route?{...route,maximumUnits:{inputTokens:route.maximumUnits.inputTokens!,outputTokens:2400}}:null;
            }
            if (['material_image_analysis', 'material_video_analysis', 'material_video_review'].includes(r.stage)) {
                let b: ReturnType<typeof getQwenProviderBinding>;
                try {
                    b = qwen();
                }
                catch {
                    return null;
                }
                if (!Number.isSafeInteger(r.frameCount) || r.frameCount! <= 0)
                    return null;
                return await qwenRoute(r.stage, r.stage === 'material_image_analysis' ? b.imageModel : b.materialModel, r.frameCount!, r.stage === 'material_image_analysis' ? 7000 : materialAnalysisTokenBudget(r.frameCount!));
            }
            if (!['first_frame', 'first_frame_qa', 'video', 'video_qa'].includes(r.stage))
                return null;
            const p = await input.readFrozenProduct?.(r);
            if(!p){
             const b=await input.readCanonicalProductBounds?.(r);if(!b||!b.evidenceRef||!b.productSha256s.length||b.productSha256s.some(h=>!/^[a-f0-9]{64}$/.test(h)))return null;
             if(r.stage.endsWith('_qa')){const expected=r.stage==='first_frame_qa'?b.firstFrameMaximumFrames:b.videoMaximumFrames;if(r.frameCount!==expected||expected>5)return null;const route=await qwenRoute(r.stage,b.qaModel||env().QWEN_VL_MODEL||'qwen3-vl-plus',expected,4096);return route?{...route,usageBoundRef:`${route.usageBoundRef}:${b.evidenceRef}`}:null;}
             if(r.stage==='first_frame'){const config=ark('seedream');if(!config||!/^doubao-seedream-5-0-(pro|flash)-/.test(config.model))return null;return {provider:'seedream',model:config.model,accountRef:productionBillingAccountRef('seedream',config.baseUrl,config.credentialSha256),routeEvidenceRef:`sdk:seedream:${paidProductionHash(config)}`,usageBoundRef:b.evidenceRef,maximumAttempts:1,maximumUnits:{outputImages:1,inputImages:b.firstFrameMaximumFrames-1}};}
             if(b.videoProvider==='wan') {const config=qwen();if(!['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(b.videoModel||'')||!Number.isInteger(b.providerDurationSeconds)||b.providerDurationSeconds<2||b.providerDurationSeconds>15)return null;return {provider:'wan',model:b.videoModel!,accountRef:productionBillingAccountRef('wan','https://dashscope.aliyuncs.com/api/v1',config.credentialSha256),routeEvidenceRef:`sdk:wan-native:${paidProductionHash({model:b.videoModel,credentialSha256:config.credentialSha256})}`,usageBoundRef:`https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/#duration:${b.evidenceRef}`,maximumAttempts:1,maximumUnits:{providerSeconds:b.providerDurationSeconds}};}
             // Public video token formula is an estimate, not a documented hard
             // billable ceiling. Do not invent one from an environment cost.
             return null;
            }
            if (p.inputContractHash !== r.inputContractHash) return null;
            validateFirstFrameRequest(p.firstFrame, { requireIdempotencyKey: false });
            if (r.stage.endsWith('_qa')) {
                const route = r.frameCount && r.frameCount <= 5 ? await qwenRoute(r.stage, p.qaModel, r.frameCount, 4096) : null;
                return route ? { ...route, usageBoundRef: `${route.usageBoundRef}:frozen-product:${firstFrameInputFingerprint(p.firstFrame, 'seedream', env().SEEDREAM_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628')}` } : null;
            }
            const provider = r.stage === 'first_frame' ? 'seedream' : 'seedance', b = ark(provider);
            if (!b)
                return null;
            if (provider === 'seedream') {
                const n = p.firstFrame.references.length;
                if (n < 1 || n > 10 || !/^doubao-seedream-5-0-(pro|flash)-/.test(b.model))
                    return null;
                return { provider, model: b.model, accountRef: productionBillingAccountRef(provider, b.baseUrl, b.credentialSha256), routeEvidenceRef: `sdk:seedream:${paidProductionHash(b)}`, usageBoundRef: `first-frame-request:${paidProductionHash({ model: b.model, ratio: p.firstFrame.ratio, references: n })}`, maximumAttempts: 1, maximumUnits: { outputImages: 1, inputImages: n } };
            }
            const v = p.video;
            if (v.model !== b.model || v.baseUrl !== b.baseUrl || v.credentialSha256 !== b.credentialSha256 || v.resolution !== '720p' || v.ratio !== '9:16' || !Number.isSafeInteger(v.maximumOutputTokens) || v.maximumOutputTokens <= 0 || !v.usageBoundRef || v.providerDurationSeconds !== Math.max(4, Math.min(15, Math.ceil(r.durationSeconds || 0))))
                return null;
            return { provider, model: b.model, accountRef: productionBillingAccountRef(provider, b.baseUrl, b.credentialSha256), routeEvidenceRef: `sdk:seedance:${paidProductionHash(b)}`, usageBoundRef: `${v.usageBoundRef}:${firstFrameInputFingerprint(p.firstFrame, 'seedream', env().SEEDREAM_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628')}`, maximumAttempts: 1, maximumUnits: { outputTokens: v.maximumOutputTokens } };
        },
        async readProductFrameBounds(r: PaidStageRequirement) {
            const p = await input.readFrozenProduct?.(r);
            if(!p){const b=await input.readCanonicalProductBounds?.(r);if(!b||!b.evidenceRef||!b.productSha256s.length||b.productSha256s.some(h=>!/^[a-f0-9]{64}$/.test(h))||![b.firstFrameMaximumFrames,b.videoMaximumFrames].every(n=>Number.isInteger(n)&&n>0&&n<=5))return null;return {inputContractHash:r.inputContractHash,evidenceRef:b.evidenceRef,firstFrameMaximumFrames:b.firstFrameMaximumFrames,videoMaximumFrames:b.videoMaximumFrames};}
            if (p.inputContractHash !== r.inputContractHash || !Number.isSafeInteger(p.productReferenceCount) || p.productReferenceCount < 1)
                return null;
            validateFirstFrameRequest(p.firstFrame, { requireIdempotencyKey: false });
            const first = 1 + p.firstFrame.references.length, video = p.productReferenceCount === 1 ? 3 + p.productReferenceCount : 2 + p.productReferenceCount;
            if (first > 5 || video > 5)
                return null;
            return { inputContractHash: r.inputContractHash, evidenceRef: `product-qa-extraction:${paidProductionHash({ firstFrame: p.firstFrame.references.map(x => x.sha256), productReferenceCount: p.productReferenceCount })}`, firstFrameMaximumFrames: first, videoMaximumFrames: video };
        },
        async assertProviderBinding(expected: {
            stage: string;
            provider: string;
            model: string;
            accountRef: string;
        }) {
            let actual: {
                model: string;
                accountRef: string;
            } | null = null;
            if(expected.provider==='wan'){const b=qwen();if(!['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(expected.model))throw Error('production_provider_gateway_changed');actual={model:expected.model,accountRef:productionBillingAccountRef('wan','https://dashscope.aliyuncs.com/api/v1',b.credentialSha256)};}
            else if (expected.provider === 'qwen') {
                const b = qwen();
                if (classifyQwenCompatibleEndpoint(b.baseUrl)!=='qianwen-maas')
                    throw Error('production_provider_gateway_changed');
                const model = expected.stage === 'material_image_analysis' ? b.imageModel : ['material_video_analysis', 'material_video_review'].includes(expected.stage) ? b.materialModel : ['director_review','director_review_capacity'].includes(expected.stage)?getDirectorG5QwenModel(): (expected.model === 'qwen3-vl-plus' ? expected.model : env().QWEN_VL_MODEL || 'qwen3-vl-plus');
                const catalog=await (input.readQwenVisionCatalog??readQwenMaaSVisionCatalog)({endpoint:b.baseUrl,credentialSha256:b.credentialSha256,model});
                if(!catalog||catalog.endpoint!==b.baseUrl.replace(/\/+$/,'')||catalog.credentialSha256!==b.credentialSha256||catalog.model!==model||!catalog.evidenceRef)throw Error('production_provider_catalog_unverified');
                actual = { model, accountRef: productionBillingAccountRef('qwen', b.baseUrl, b.credentialSha256) };
            }
            else if (expected.provider === 'seedance' || expected.provider === 'seedream') {
                const b = ark(expected.provider);
                if (b)
                    actual = { model: b.model, accountRef: productionBillingAccountRef(expected.provider, b.baseUrl, b.credentialSha256) };
            }
            if (!actual || actual.model !== expected.model || actual.accountRef !== expected.accountRef)
                throw Error('production_provider_binding_changed');
        }
    };
}
