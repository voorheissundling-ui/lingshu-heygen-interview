import { paidProductionHash, type PaidStageRequirement, type BoundPaidRoute } from './socialContentPaidOperationPlan.js';
import type { SocialPaidOperationIntent } from '../lib/socialContentTaskBudgetAuthority.js';
import type { SocialTaskBudgetScope } from '../lib/socialContentTaskBudget.js';
import type { createSocialContentPaidOperationPermit } from '../lib/socialContentPaidOperationPermit.js';
import type { ProductPaidContext } from './socialContentProductPaidContext.js';
export function createSeedancePresenterFunding(input: {
  scope: SocialTaskBudgetScope; requirements: PaidStageRequirement[]; routes: Record<string, BoundPaidRoute>;
  intents: SocialPaidOperationIntent[]; permit: ReturnType<typeof createSocialContentPaidOperationPermit>;
  ports: Pick<ProductPaidContext, 'assertProviderBinding' | 'measureInputTokens' | 'measureVideoOutputTokens'>;
  readReservedCny(operationId: string): number;
  persistReceipt(receipt: { requestSha256: string; response: unknown }): Promise<string>;
}) {
  function bound(shotId: string, stage: 'presenter_video' | 'video_qa') {
    const groupId = `presenter-motion:${shotId}`;
    const matches = input.requirements.filter(r => r.presenterGroupId === groupId && r.stage === stage);
    if (matches.length !== 1) throw Error('seedance_presenter_paid_requirement_missing');
    const requirement = matches[0]!, route = input.routes[requirement.key];
    const operationId = `paid-plan:${paidProductionHash({ scope: input.scope, key: requirement.key, attempt: 0 })}`;
    const intents = input.intents.filter(i => i.operationId === operationId);
    if (!route || intents.length !== 1) throw Error('seedance_presenter_paid_intent_missing');
    const intent = intents[0]!;
    if (intent.stage!==stage||intent.shotId!==requirement.shotId||intent.inputContractHash !== paidProductionHash({ requirement, route, attempt: 0 }) || intent.provider !== (stage === 'presenter_video' ? 'seedance' : 'qwen')
      || intent.model !== route.model || intent.accountRef !== route.accountRef || paidProductionHash(intent.maximumUnits) !== paidProductionHash(route.maximumUnits)) throw Error('seedance_presenter_paid_binding_changed');
    return { requirement, route, intent, operationId };
  }
  return {
    bound,
    async authorize(shotId: string, maximumCostCny: number) {
      const binding = bound(shotId, 'presenter_video');
      const reserved = input.readReservedCny(binding.operationId);
      if (!Number.isFinite(reserved) || reserved < 0 || reserved > maximumCostCny) throw Error('seedance_presenter_reservation_exceeds_allowance');
      return { allowed: true as const, reservationRef: binding.operationId };
    },
    async beforeSubmit(shotId: string, stage: 'presenter_video' | 'video_qa', body: Record<string, unknown>) {
      const { route, requirement, intent } = bound(shotId, stage);
      await input.ports.assertProviderBinding(route);
      if (body.model !== route.model) throw Error('seedance_presenter_paid_model_changed');
      const actualUnits: Record<string, number> = {};
      if (stage === 'presenter_video' && (body.generate_audio !== false || body.resolution !== '720p' || Number(body.duration) !== Math.max(4, Math.ceil(requirement.durationSeconds || 0))
        || !Array.isArray(body.content) || !body.content.some((part: any) => part.role === 'first_frame'))) throw Error('seedance_presenter_actual_i2v_changed');
      const frameCount = Array.isArray(body.messages) ? body.messages.flatMap((message: any) => message.content ?? []).filter((part: any) => part.type === 'image_url').length : 0;
      if (stage === 'video_qa' && (frameCount !== requirement.frameCount || body.enable_thinking !== false || body.max_tokens !== 4096)) throw Error('seedance_presenter_actual_qa_changed');
      for (const unit of Object.keys(intent.maximumUnits)) {
        if (unit === 'providerSeconds' && stage === 'presenter_video') actualUnits[unit] = Number(body.duration);
        else if (unit === 'outputTokens' && stage === 'presenter_video') {
          if (!input.ports.measureVideoOutputTokens) throw Error('seedance_presenter_actual_usage_bound_missing');
          actualUnits[unit] = await input.ports.measureVideoOutputTokens(body, route);
        } else if (unit === 'inputTokens' && stage === 'video_qa') actualUnits[unit] = await input.ports.measureInputTokens(body, route);
        else if (unit === 'outputTokens' && stage === 'video_qa') actualUnits[unit] = Number(body.max_tokens);
        else if (unit === 'requests') actualUnits[unit] = 1;
        else if (['frames', 'images'].includes(unit) && stage === 'video_qa') actualUnits[unit] = frameCount;
        else throw Error('seedance_presenter_usage_dimension_unsupported');
      }
      const { maximumUnits: _, ...binding } = intent;
      await input.permit.beforeSubmit({ ...binding, actualUnits });
    },
    async receipt(shotId: string, stage: 'presenter_video' | 'video_qa', response: unknown) {
      const { operationId, intent } = bound(shotId, stage);
      const receiptRef = await input.persistReceipt({ requestSha256: paidProductionHash({ intent }), response });
      await input.permit.markOutcome(operationId, 'completed', receiptRef);
    },
  };
}
