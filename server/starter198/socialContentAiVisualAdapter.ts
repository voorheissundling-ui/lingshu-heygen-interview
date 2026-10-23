import {accountProductionConstraintPrompt} from './socialAccountProductionConstraints.js';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { generatePosterImage, imageExt } from '../lib/imageGen.js';
import {
  estimateSeedanceCostCny,
  generateSeedanceConceptVideo,
  generateVeoConceptVideo,
} from '../lib/generativeVideoGateway.js';
import type {
  SocialAssetSupplyAdapterContext,
  SocialAssetSupplyAdapterResult,
  SocialAssetSupplyProviderAdapter,
} from './socialContentAssetSupplyExecution.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

export interface SocialAiVisualGeneratedMedia {
  type: 'image' | 'video';
  providerId: string;
  model: string;
  providerTaskId?: string;
  bytes?: Buffer;
  mimeType?: string;
  url?: string;
  duration?: number;
  estimatedCostCny: number;
}

export interface SocialAiVisualGenerator {
  generatorId: string;
  mediaType: 'image' | 'video';
  estimatedCostCny: number;
  generate(input: {
    tenantId: string;
    outputDirectory: string;
    prompt: string;
    ratio: '9:16';
    durationSeconds: number;
    idempotencyKey: string;
    timeoutMs: number;
  }): Promise<SocialAiVisualGeneratedMedia>;
}

export interface SocialAiVisualAdapterOptions {
  enabled: boolean;
  generators: SocialAiVisualGenerator[];
  maxCostCnyPerShot: number;
  timeoutMs: number;
  /** A confirmed scene-rework tariff remains an explicit authorization cap. */
  enforceCostCeilingForExemptTenant?: boolean;
}

export function aiVisualExceedsInternalBudget(tenantId: string, amountCny: number, maximumCostCny: number): boolean {
  if (!Number.isFinite(amountCny) || amountCny < 0 || !Number.isFinite(maximumCostCny) || maximumCostCny < 0) return true;
  return !isInternalBudgetExemptTenant(tenantId) && amountCny > maximumCostCny;
}

function compact(value: unknown, max = 240): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function idempotencyKey(context: SocialAssetSupplyAdapterContext): string {
  return createHash('sha256').update(JSON.stringify({
    tenantId: context.tenantId,
    taskId: context.taskId,
    operationId: context.operationId,
    ...(context.accountPlaybookConstraints?{accountConstraintHash:context.accountPlaybookConstraints.constraintHash}:{}),
    shotId: context.shot.shotId,
    strategy: context.shot.sourceStrategy,
    instruction: context.shot.productionInstruction,
    replacement: context.shot.functionalEquivalentReplacement,
    scene: context.baselineScene,
  })).digest('hex');
}

function controlledPrompt(context: SocialAssetSupplyAdapterContext): string {
  const requested = compact(context.shot.functionalEquivalentReplacement.description
    || context.shot.productionInstruction
    || context.shot.requestedDescription
    || `${context.baselineScene.subject} ${context.baselineScene.action}`);
  return [
    'Create one vertical 9:16 conceptual supporting visual for a short social video.',
    `Visual goal: ${requested || 'abstract topic illustration'}.`,
    `Shot function: ${compact(context.shot.function, 60)}.`,
    'This is a synthetic, non-evidentiary illustration.',
    'Do not depict or imply the customer\'s real factory, workshop, production line, warehouse, client case, testimonial, certification, measured result, before/after result, or exact product performance.',
    'Do not add logos, company names, product claims, statistics, certificates, UI text, labels, or readable text.',
    'Use generic people, locations, objects, and abstract visual metaphors. No identifiable real customer or facility.',
    accountProductionConstraintPrompt(context.accountPlaybookConstraints),
  ].join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ai_visual_timeout:${timeoutMs}`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function materialize(
  context: SocialAssetSupplyAdapterContext,
  generated: SocialAiVisualGeneratedMedia,
  key: string,
): Promise<SocialAssetSupplyAdapterResult> {
  if (!generated.bytes && !generated.url) throw new Error('ai_visual_provider_returned_no_media');
  const ext = generated.type === 'image'
    ? imageExt(generated.mimeType || 'image/png')
    : 'mp4';
  const filename = `ai-visual-${context.shot.shotId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${key.slice(0, 12)}.${ext}`;
  const localPath = generated.bytes ? path.join(context.outputDirectory, filename) : undefined;
  if (localPath && generated.bytes) {
    await fsp.mkdir(context.outputDirectory, { recursive: true });
    await fsp.writeFile(localPath, generated.bytes);
  }
  const contentHash = generated.bytes
    ? createHash('sha256').update(generated.bytes).digest('hex')
    : undefined;
  const providerRef = generated.providerTaskId || `${generated.model}:${key.slice(0, 16)}`;
  const disclosure = 'AI 生成示意画面 · 非客户实拍/案例/效果证据';
  return {
    asset: {
      id: `ai-visual-${key.slice(0, 24)}`,
      name: `${compact(context.baselineScene.shotFunction, 40) || '辅助画面'} · AI 示意`,
      type: generated.type,
      sourceId: `${generated.providerId}:${providerRef}`,
      url: localPath || generated.url!,
      ...(localPath ? { localPath } : {}),
      ...(contentHash ? { contentHash } : {}),
      duration: generated.type === 'video' ? Math.max(1, generated.duration || 5) : 2.8,
      visualObservations: [
        compact(`${context.baselineScene.shotFunction} ${context.baselineScene.subject} ${context.baselineScene.action}`),
        disclosure,
      ].filter(Boolean),
      segments: [{
        provenance: 'synthetic_non_evidentiary',
        providerId: generated.providerId,
        model: generated.model,
        providerTaskId: generated.providerTaskId || null,
        idempotencyKey: key,
        estimatedCostCny: generated.estimatedCostCny,
        disclosure,
      }],
      selectionOrigin: 'system_graphic',
    },
    sourceStrategy: 'non_evidentiary_ai_visual',
    providerId: generated.providerId,
    sourceRef: `${generated.providerId}:${providerRef}`,
    synthetic: true,
    representation: 'non_evidentiary_visual',
    authorizationRef: null,
    disclosure,
  };
}

export function createSocialAiVisualAdapter(options: SocialAiVisualAdapterOptions): SocialAssetSupplyProviderAdapter {
  const executions = new Map<string, Promise<SocialAssetSupplyAdapterResult | null>>();
  return {
    adapterId: 'controlled_ai_visual.v1',
    sourceStrategies: ['non_evidentiary_ai_visual'],
    async execute(context) {
      if (!options.enabled) return null;
      if (!context.shot.truthBoundary.syntheticVisualAllowed
        || context.shot.truthBoundary.customerEvidenceRequired) return null;
      const key = idempotencyKey(context);
      const existing = executions.get(key);
      if (existing) return existing;
      const execution = (async () => {
        const prompt = controlledPrompt(context);
        const exceedsCostCeiling = (amountCny: number) => options.enforceCostCeilingForExemptTenant
          ? amountCny > options.maxCostCnyPerShot
          : aiVisualExceedsInternalBudget(context.tenantId, amountCny, options.maxCostCnyPerShot);
        const eligible = options.generators.filter(generator => (
          !exceedsCostCeiling(generator.estimatedCostCny)
        ));
        for (const generator of eligible) {
          try {
            const generated = await withTimeout(generator.generate({
              tenantId: context.tenantId,
              outputDirectory: context.outputDirectory,
              prompt,
              ratio: '9:16',
              durationSeconds: 5,
              idempotencyKey: key,
              timeoutMs: options.timeoutMs,
            }), options.timeoutMs);
            if (exceedsCostCeiling(generated.estimatedCostCny)) {
              throw new Error('ai_visual_actual_cost_exceeds_shot_budget');
            }
            return await materialize(context, generated, key);
          } catch (error) {
            const reason = String(error instanceof Error ? error.message : error || '');
            // A timed-out or ambiguously submitted paid operation may still be
            // running at the supplier. Never submit the same shot to another
            // provider in that state; the outer router may safely render its
            // local motion-graphics fallback.
            if (/timeout|timed out|提交结果未知|unknown submission|provider_submission_(?:unknown|uncertain)|do not resubmit/i.test(reason)) throw new Error(`provider_submission_unknown:ai_visual:${reason}`);
            // Try the next explicitly registered provider. If all fail, the
            // governed router records this adapter as unavailable and uses its
            // planned motion-graphics fallback.
          }
        }
        return null;
      })();
      executions.set(key, execution);
      try {
        return await execution;
      } finally {
        // Successful calls stay deduplicated for this process. Failed calls are
        // released so an operator-controlled retry can run later.
        if ((await execution.catch(() => null)) === null) executions.delete(key);
      }
    },
  };
}

export function createConfiguredSocialAiVisualAdapter(options:{recoveryOnly?:boolean;qwenOnly?:boolean;maximumCostCnyPerImage?:number;frozenModel?:string}={}): SocialAssetSupplyProviderAdapter {
  const enabled = (process.env.SOCIAL_AI_VISUAL_ENABLED || '').trim().toLowerCase() === 'true';
  if(options.qwenOnly&&(!Number.isFinite(options.maximumCostCnyPerImage)||options.maximumCostCnyPerImage!<0||options.frozenModel!==(process.env.QWEN_IMAGE_MODEL||'qwen-image-3.0').trim()))throw new Error('scene_rework_qwen_tariff_changed');
  const maxCostCnyPerShot = options.qwenOnly?options.maximumCostCnyPerImage!:Number(process.env.SOCIAL_AI_VISUAL_MAX_COST_CNY_PER_SHOT || 2);
  const timeoutMs = Number(process.env.SOCIAL_AI_VISUAL_TIMEOUT_MS || 120_000);
  const qwenImage: SocialAiVisualGenerator = {
    generatorId: 'qwen_image',
    mediaType: 'image',
    estimatedCostCny:options.qwenOnly?options.maximumCostCnyPerImage!:Number(process.env.SOCIAL_QWEN_IMAGE_ESTIMATED_COST_CNY || 0.3),
    async generate(input) {
      if(options.qwenOnly&&options.frozenModel!==(process.env.QWEN_IMAGE_MODEL||'qwen-image-3.0').trim())throw new Error('scene_rework_qwen_tariff_changed');
      const output = await generatePosterImage({ prompt: input.prompt, ratio: input.ratio, idempotencyKey:input.idempotencyKey,recoveryOnly:options.recoveryOnly });
      return {
        type: 'image', providerId: output.source, model: output.model,
        bytes: output.bytes, mimeType: output.mimeType,
        estimatedCostCny: this.estimatedCostCny,
      };
    },
  };
  const videoProvider = (process.env.SOCIAL_AI_VISUAL_VIDEO_PROVIDER || '').trim().toLowerCase();
  const videoGenerators: SocialAiVisualGenerator[] = [];
  if (!options.recoveryOnly && !options.qwenOnly && videoProvider === 'seedance' && process.env.SEEDANCE_VIDEO_ENABLED === 'true'
    && (process.env.SEEDANCE_API_KEY || '').trim()) {
    const duration = 5;
    videoGenerators.push({
      generatorId: 'seedance_concept_video', mediaType: 'video',
      estimatedCostCny: estimateSeedanceCostCny(duration, '720p'),
      async generate(input) {
        const output = await generateSeedanceConceptVideo({
          tenantId: input.tenantId,
          prompt: input.prompt,
          durationSeconds: input.durationSeconds,
          ratio: input.ratio,
          resolution: '720p',
          idempotencyKey: input.idempotencyKey,
          timeoutMs: input.timeoutMs,
          apiKey: (process.env.SEEDANCE_API_KEY || '').trim(),
          model: (process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128').trim(),
          baseUrl: process.env.SEEDANCE_BASE_URL,
        });
        return { ...output, type: 'video', mimeType: 'video/mp4' };
      },
    });
  }
  if (!options.recoveryOnly && !options.qwenOnly && videoProvider === 'veo' && process.env.GEMINI_VIDEO_ENABLED === 'true'
    && (process.env.GEMINI_API_KEY || '').trim()) {
    videoGenerators.push({
      generatorId: 'veo_concept_video', mediaType: 'video',
      estimatedCostCny: Number(process.env.SOCIAL_VEO_ESTIMATED_COST_CNY || 6),
      async generate(input) {
        const output = await generateVeoConceptVideo({
          tenantId: input.tenantId,
          prompt: input.prompt,
          durationSeconds: input.durationSeconds,
          ratio: input.ratio,
          resolution: '720p',
          idempotencyKey: input.idempotencyKey,
          timeoutMs: input.timeoutMs,
          model: (process.env.GEMINI_VIDEO_MODEL || 'veo-2.0-generate-001').trim(),
          outputDirectory: input.outputDirectory,
          estimatedCostCny: this.estimatedCostCny,
        });
        return { ...output, type: 'video', mimeType: 'video/mp4' };
      },
    });
  }
  return createSocialAiVisualAdapter({
    enabled,
    generators: [...videoGenerators, qwenImage],
    maxCostCnyPerShot: Number.isFinite(maxCostCnyPerShot) ? Math.max(0, maxCostCnyPerShot) : 2,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 120_000,
    enforceCostCeilingForExemptTenant: options.qwenOnly === true,
  });
}
