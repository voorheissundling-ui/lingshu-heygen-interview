export type SocialImageLayerKind = 'background' | 'product' | 'logo' | 'text' | 'overlay' | 'badge' | 'decoration' | 'cta';
export type SocialImageProtectedAnchor = 'cap' | 'brand' | 'label' | 'product_body';

export interface SocialImageNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SocialImageLayer {
  id: string;
  kind: SocialImageLayerKind;
  zIndex: number;
  rect: SocialImageNormalizedRect;
  sourceAssetId?: string;
  content?: string;
  opacity?: number;
  rotation?: number;
  fit?: 'contain' | 'cover';
  styleToken?: string;
  protectedAnchors?: SocialImageProtectedAnchor[];
  evidenceRefs?: string[];
  mask?: {
    shape: 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'polygon' | 'linear_gradient';
    color?: string;
    cornerRadius?: number;
    feather?: number;
    angle?: number;
    points?: Array<{ x: number; y: number }>;
  };
}

export interface SocialImageLayerGraph {
  schemaVersion: 'social-image-layer-graph.v1';
  canvas: { width: number; height: number; background: string };
  templateId: string;
  layers: SocialImageLayer[];
  protectedRegions: SocialImageNormalizedRect[];
  overlayAllowedRegions: SocialImageNormalizedRect[];
  fontManifest: Array<{ token: string; family: string; fileHash: string }>;
  compiledAt: string;
}

export function socialImageRectOverlapRatio(a: SocialImageNormalizedRect, b: SocialImageNormalizedRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = Math.max(0.000001, a.width * a.height);
  return (width * height) / area;
}
