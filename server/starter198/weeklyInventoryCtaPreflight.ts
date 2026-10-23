/** Only the exact CTA frozen into the actual director handoff is proven by the
 * source G5 audit. A target label or a reused template cannot rewrite that video. */
export function inventoryCtaPreflightGap(input:{sourceCta:unknown;targetCta:unknown;bindingCta:unknown}):string|null{
 const exact=(value:unknown)=>typeof value==='string'?value.trim():'';
 const source=exact(input.sourceCta),target=exact(input.targetCta),binding=exact(input.bindingCta);
 if(!source)return 'inventory_actual_source_cta_unverified';
 if(!target||!binding||source!==target||source!==binding)return 'inventory_target_cta_requires_explicit_source_compatibility';
 return null;
}
