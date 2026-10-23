import type {SocialAssetSupplyProviderAdapter} from './socialContentAssetSupplyExecution.js';
/** The external adapter contract is one opaque execute() call. It cannot prove
 * whether or how many supplier POSTs occur inside that call. The default weekly
 * worker registers no external adapters; its known-operation GET recovery uses
 * the built-in provider bridges, not this injection point. A recoveryOnly flag
 * alone is not evidence that an arbitrary adapter cannot submit again. */
export function admitExternalSupplyAdapters(input:{adapters:SocialAssetSupplyProviderAdapter[];weekly:boolean}):SocialAssetSupplyProviderAdapter[]{
 if(input.weekly&&input.adapters.length)throw Error('weekly_custom_supplier_submit_boundary_unverified');
 return input.adapters;
}
export function socialProductionSupplyAdapters(input:{recoveryOnly?:boolean;hasPresenterExecution:boolean;custom:SocialAssetSupplyProviderAdapter[];free:SocialAssetSupplyProviderAdapter[];paid:()=>SocialAssetSupplyProviderAdapter[]}):SocialAssetSupplyProviderAdapter[]{
  const custom=input.custom.filter(adapter=>adapter.adapterId==='presenter_mother_segment.v1'||input.recoveryOnly||!input.hasPresenterExecution||!adapter.sourceStrategies.includes('authorized_digital_presenter'));
  return [...custom,...(input.recoveryOnly?[]:input.paid()),...input.free];
}
