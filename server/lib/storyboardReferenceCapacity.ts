/** Plans first-frame reference slots before any paid provider call. */
export function storyboardReferenceCapacity(input: {
  source: boolean; products: number; person: boolean; environment: boolean;
}): { useProductSheet: boolean; usePersonEnvironmentSheet: boolean; referenceCount: number; fits: boolean } {
  const otherCount = Number(input.source) + Number(input.person) + Number(input.environment);
  const useProductSheet = input.products >= 2 && otherCount + input.products > 3;
  const afterProductSheet = otherCount + (useProductSheet ? 1 : input.products);
  const usePersonEnvironmentSheet = input.person && input.environment && afterProductSheet > 3;
  const referenceCount = afterProductSheet - Number(usePersonEnvironmentSheet);
  return { useProductSheet, usePersonEnvironmentSheet, referenceCount, fits: referenceCount <= 3 };
}
