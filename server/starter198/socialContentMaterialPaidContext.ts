import type { MaterialAnalysisPaidContext, MaterialAnalysisPaidCall } from '../digitalEmployees/materialAnalysisPaidOperation.js';
import type { SocialPaidOperationIntent } from '../lib/socialContentTaskBudgetAuthority.js';
import type { SocialTaskBudgetScope } from '../lib/socialContentTaskBudget.js';
import type { createSocialContentPaidOperationPermit } from '../lib/socialContentPaidOperationPermit.js';
import { paidProductionHash, type PaidStageRequirement } from './socialContentPaidOperationPlan.js';

export interface SocialMaterialPaidRuntimePorts {
  assertProviderBinding(input: Pick<SocialPaidOperationIntent, 'provider' | 'model' | 'accountRef' | 'stage'>): Promise<void>;
  measureInputTokens: MaterialAnalysisPaidCall['measureInputTokens'];
  persistProviderReceipt: MaterialAnalysisPaidCall['persistProviderReceipt'];
}

/** Binds the real material executor to the already reserved canonical plan.
 * Runtime readers supply measurement and receipt storage, never operation IDs. */
export function createSocialContentMaterialPaidContext(input: {
  scope: SocialTaskBudgetScope;
  requirements: PaidStageRequirement[];
  intents: SocialPaidOperationIntent[];
  permit: ReturnType<typeof createSocialContentPaidOperationPermit>;
  ports: SocialMaterialPaidRuntimePorts;
}): MaterialAnalysisPaidContext {
  return {
    async forRequest(request) {
      const key = request.stage === 'material_image_analysis' ? `asset:${request.assetId}:image`
        : `asset:${request.assetId}:${request.batchIndex}:${request.stage === 'material_video_analysis' ? 'analysis' : 'review'}`;
      const requirements = input.requirements.filter(row => row.key === key && row.stage === request.stage);
      const operationId = `paid-plan:${paidProductionHash({scope: input.scope, key, attempt: 0})}`;
      const intents = input.intents.filter(row => row.operationId === operationId);
      if (requirements.length !== 1 || requirements[0]!.sourceRef !== request.sourceSha256
        || intents.length !== 1 || intents[0]!.provider !== request.provider
        || intents[0]!.model !== request.model || intents[0]!.stage !== request.stage) {
        throw Error('material_paid_canonical_request_changed');
      }
      await input.ports.assertProviderBinding(intents[0]!);
      return { requirementKey: key, intent: structuredClone(intents[0]!), permit: input.permit, ...input.ports,
        async measureInputTokens(body){const frames=Array.isArray(body.messages)?body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).filter((part:any)=>part.type==='image_url').length:0;if(!Number.isSafeInteger(requirements[0]!.frameCount)||frames!==requirements[0]!.frameCount)throw Error('material_paid_actual_frame_count_changed');return input.ports.measureInputTokens(body);}
      };
    },
  };
}
