export function storyboardFirstFrameExecutionRoute(input: {
  hasReliableComposition: boolean;
  hasExactProductLayer: boolean;
  seedanceModel: string;
  multimodalEnabled?: boolean;
}): 'direct_seedance_input' | 'seedream' {
  const supportsSeedance2 = /seedance-2(?:-|_|\.)?0/i.test(String(input.seedanceModel || ''));
  return input.hasReliableComposition && input.hasExactProductLayer && input.multimodalEnabled !== false && supportsSeedance2
    ? 'direct_seedance_input' : 'seedream';
}
