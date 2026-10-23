import {createHash} from 'node:crypto';
import type {SocialTaskBudgetScope} from '../lib/socialContentTaskBudget.js';
import type {SocialPaidOperationIntent} from '../lib/socialContentTaskBudgetAuthority.js';
import type {createSocialContentPaidOperationPermit} from '../lib/socialContentPaidOperationPermit.js';
import {paidProductionHash, type PaidStageRequirement, type BoundPaidRoute} from './socialContentPaidOperationPlan.js';

export type ProductPaidStage = 'first_frame' | 'first_frame_qa' | 'video' | 'video_qa';
export interface ProductPaidContext {
  scope: SocialTaskBudgetScope;
  requirements: PaidStageRequirement[];
  routeBindings: Record<string, BoundPaidRoute>;
  intents: SocialPaidOperationIntent[];
  readReservedCny(operationId: string): number;
  assertRecovery(operationId: string): Promise<void>;
  permit: ReturnType<typeof createSocialContentPaidOperationPermit>;
  /** Canonical configured credential/account route is checked independently of the intent. */
  assertProviderBinding(route: BoundPaidRoute): Promise<void>;
  /** Model-aware upper bound derived from this actual request, not the plan maximum. */
  measureVideoOutputTokens?(request: Record<string, unknown>, route: BoundPaidRoute): Promise<number>;
  measureInputTokens(request: Record<string, unknown>, route: BoundPaidRoute): Promise<number>;
}
const fail = (reason: string): never => {throw Error('product_paid_' + reason);};
export function bindProductPaidStage(context: ProductPaidContext, shotId: string, stage: ProductPaidStage, attempt = 0) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1 || (attempt > 0 && !['video', 'video_qa'].includes(stage))) fail('attempt_invalid');
  const requirements = context.requirements.filter(r => r.shotId === shotId && r.stage === stage);
  if (requirements.length !== 1) fail('requirement_missing_or_ambiguous');
  const requirement = requirements[0]!, route = context.routeBindings[requirement.key];
  if (!route) fail('canonical_route_missing');
  const operationId = 'paid-plan:' + paidProductionHash({scope: context.scope, key: requirement.key, attempt});
  const intents = context.intents.filter(i => i.operationId === operationId);
  if (intents.length !== 1) fail('intent_missing_or_ambiguous');
  const intent = intents[0]!;
  if (intent.inputContractHash !== paidProductionHash({requirement, route, attempt}) || intent.shotId !== shotId || intent.stage !== stage
    || intent.provider !== route.provider || intent.model !== route.model || intent.accountRef !== route.accountRef
    || paidProductionHash(intent.maximumUnits) !== paidProductionHash(route.maximumUnits)) fail('canonical_intent_changed');
  return {
    intent,
    async beforeSubmit(body: Record<string, unknown>) {
      const request = structuredClone(body);
      await context.assertProviderBinding(route);
      if (request.model !== intent.model) fail('actual_model_changed');
      const actualUnits: Record<string, number> = {};
      const images = stage.endsWith('_qa')
        ? (Array.isArray(request.messages) ? request.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((i: any) => i.type === 'image_url').length : NaN)
        : stage === 'first_frame' ? (Array.isArray(request.image) ? request.image.length : 0) : 1;
      for (const unit of Object.keys(intent.maximumUnits)) {
        if (unit === 'requests') actualUnits.requests = 1;
        else if (unit === 'frames' || unit === 'images') actualUnits[unit] = images;
        else if (unit === 'providerSeconds') actualUnits.providerSeconds = Number(intent.provider==='wan'?(request.parameters as Record<string,unknown>|undefined)?.duration:request.duration);
        else if (unit === 'outputTokens') {
          if(stage === 'video'){if(!context.measureVideoOutputTokens)fail('video_token_measurement_missing');actualUnits.outputTokens=await context.measureVideoOutputTokens!(request,route);}
          else actualUnits.outputTokens = Number(request.max_tokens);
        }
        else if (unit === 'inputImages') actualUnits.inputImages = images;
        else if (unit === 'outputImages') {if(stage!=='first_frame' || request.sequential_image_generation==='auto'||['layers','layer','layered_output','image_generation_mode','tools','stream'].some(key=>key in request))fail('image_output_mode_unsupported');actualUnits.outputImages=1;}
        else if (unit === 'inputTokens') actualUnits.inputTokens = await context.measureInputTokens(request, route);
        else fail('actual_usage_dimension_unsupported:' + unit);
      }
      if (Object.values(actualUnits).some(n => !Number.isFinite(n) || n < 0)) fail('actual_usage_invalid');
      if (stage === 'first_frame' && (!images || typeof request.prompt !== 'string' || !request.prompt.trim())) fail('actual_KB_frame_request_changed');
      if(stage==='video'&&intent.provider==='wan'){const params=request.parameters as Record<string,unknown>|undefined,input=request.input as Record<string,unknown>|undefined;const expected=intent.model==='wan2.2-i2v-flash'?5:Math.max(2,Math.ceil(requirement.durationSeconds||0));if(!params||!input||Number(params.duration)!==expected||params.resolution!=='720P'||params.prompt_extend!==false||typeof input.img_url!=='string'||!input.img_url.startsWith('data:image/')||(intent.model==='wan2.6-i2v-flash'&&params.audio!==false))fail('actual_wan_i2v_request_changed');}
      if (stage === 'video' && intent.provider!=='wan' && (Number(request.duration) !== Math.max(4, Math.ceil(requirement.durationSeconds || 0)) || request.generate_audio !== false || request.resolution !== '720p' || !Array.isArray(request.content)
        || !request.content.some((i: any) => i.role === 'first_frame'))) fail('actual_i2v_request_changed');
      if (stage.endsWith('_qa') && (images > (requirement.frameCount ?? 0))) fail('actual_qa_frames_exceed_contract');
      if (stage.endsWith('_qa') && (!Array.isArray(request.messages) || request.enable_thinking !== false || Number(request.max_tokens) !== 4096 || !images)) fail('actual_qa_request_changed');
      const {maximumUnits: _maximum, ...binding} = intent;
      await context.permit.beforeSubmit({...binding, actualUnits});
      return {operationId, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), actualUnits};
    },
    async completed(receiptRef: string) {await context.permit.markOutcome(operationId, 'completed', receiptRef);},
  };
}
export function hasProductPaidStage(context: ProductPaidContext, shotId: string, stage: ProductPaidStage, attempt = 0) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1 || (attempt > 0 && !['video', 'video_qa'].includes(stage))) fail('attempt_invalid');
  const requirements = context.requirements.filter(r => r.shotId === shotId && r.stage === stage);
  if (requirements.length !== 1) fail('requirement_missing_or_ambiguous');
  const requirement = requirements[0]!;
  if (!context.routeBindings[requirement.key]) fail('canonical_route_missing');
  const operationId = 'paid-plan:' + paidProductionHash({scope: context.scope, key: requirement.key, attempt});
  const count = context.intents.filter(intent => intent.operationId === operationId).length;
  if (count > 1) fail('intent_ambiguous');
  if (count === 0) return false;
  bindProductPaidStage(context, shotId, stage, attempt);
  return true;
}
/** Upper-bound money retained for one product shot, including its separately
 * funded directed retry. Providers in this chain do not return a trustworthy
 * final invoice, so callers must keep this labelled as estimated/reserved. */
export function productPaidReservedCostCny(context: ProductPaidContext, shotId: string) {
  let total = 0;
  for (const stage of ['first_frame', 'first_frame_qa', 'video', 'video_qa'] as const) {
    const attempts: readonly number[] = stage === 'video' || stage === 'video_qa' ? [0, 1] : [0];
    for (const attempt of attempts) {
      if (!hasProductPaidStage(context, shotId, stage, attempt)) continue;
      const amount = context.readReservedCny(bindProductPaidStage(context, shotId, stage, attempt).intent.operationId);
      if (!Number.isFinite(amount) || amount < 0) fail('reservation_missing');
      total += amount;
    }
  }
  return Math.round(total * 1e6) / 1e6;
}
