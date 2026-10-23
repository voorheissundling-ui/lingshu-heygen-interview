import { createHash } from 'node:crypto';

export type FirstFrameProvider = 'seedream' | 'qwen';
export type FirstFrameReferenceRole = 'source_composition' | 'authorized_presenter' | 'product_identity' | 'enterprise_environment';

export interface FirstFrameReference {
  role: FirstFrameReferenceRole;
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sha256: string;
}

export interface FirstFrameRequest {
  /** Presenter replacement keeps the historic two-image contract. Product
   * scenes accept one composition frame plus one or more product references. */
  referenceMode?: 'presenter_replace' | 'product_scene' | 'environment_plate' | 'storyboard_scene';
  tenantId: string;
  videoId: string;
  compositionId: string;
  presenterVersion: string;
  prompt: string;
  ratio: '9:16' | '16:9' | '1:1';
  references: FirstFrameReference[];
  idempotencyKey: string;
}

export interface FirstFrameResult {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  provider: FirstFrameProvider;
  model: string;
  providerRequestId: string;
  estimatedCostCny: number;
}

export interface FirstFrameGenerator {
  readonly provider: FirstFrameProvider;
  readonly model: string;
  readonly estimatedCostCny: number;
  generate(input: FirstFrameRequest): Promise<FirstFrameResult>;
}

export class FirstFrameProviderError extends Error {
  constructor(message: string, public readonly status: 'rejected' | 'uncertain', public readonly providerRequestId = '',
    /** Only a failure proven to precede the transport submission may release
     * the original operation. An HTTP error is already past that boundary. */
    public readonly submissionBoundary: 'before_submit' | 'submitted_or_unknown' = 'submitted_or_unknown') {
    super(message);
  }
}

export function validateFirstFrameRequest(input: FirstFrameRequest, options: { requireIdempotencyKey?: boolean } = {}): void {
  if (!input.tenantId.trim() || !input.videoId.trim() || !input.compositionId.trim() || !input.presenterVersion.trim()) throw new Error('首帧请求缺少租户、成片、构图或身份版本');
  if (!input.prompt.trim()) throw new Error('首帧请求缺少构图提示词');
  if (options.requireIdempotencyKey !== false && !input.idempotencyKey.trim()) throw new Error('首帧请求缺少稳定幂等键');
  const roles = input.references.map(item => item.role);
  if (input.referenceMode === 'storyboard_scene') {
    if (input.references.length > 3 || input.references.some(reference =>
      !['source_composition', 'authorized_presenter', 'product_identity', 'enterprise_environment'].includes(reference.role))) {
      throw new Error('分镜首帧最多支持三张已分类参考图');
    }
  } else if (input.referenceMode === 'product_scene') {
    const products = roles.filter(role => role === 'product_identity').length;
    if (roles.filter(role => role === 'source_composition').length !== 1 || products < 1 || products > 9 || input.references.length !== products + 1) {
      throw new Error('产品场景首帧必须包含一张原构图和一至九张同产品参考图');
    }
  } else if (input.referenceMode === 'environment_plate') {
    if (input.references.length !== 1 || roles[0] !== 'source_composition') {
      throw new Error('环境空景首帧必须且只能包含一张原构图');
    }
  } else {
    const products=roles.filter(role=>role==='product_identity').length;
    if(roles.filter(role => role === 'source_composition').length !== 1 || roles.filter(role => role === 'authorized_presenter').length !== 1
      || products>9 || input.references.length!==2+products)throw new Error('人物首帧必须包含一张原构图、一张已授权人物参考图，并可附带一至九张同产品参考图');
  }
  for (const reference of input.references) {
    if (!reference.bytes.length || !/^[a-f0-9]{64}$/i.test(reference.sha256)) throw new Error(`首帧参考图无效:${reference.role}`);
    if (createHash('sha256').update(reference.bytes).digest('hex') !== reference.sha256.toLowerCase()) throw new Error(`首帧参考图哈希不匹配:${reference.role}`);
  }
}

export function firstFrameInputFingerprint(input: FirstFrameRequest, provider: FirstFrameProvider, model: string): string {
  validateFirstFrameRequest(input, { requireIdempotencyKey: false });
  return createHash('sha256').update(JSON.stringify({ tenantId: input.tenantId, videoId: input.videoId,
    compositionId: input.compositionId, presenterVersion: input.presenterVersion, referenceMode: input.referenceMode || 'presenter_replace', prompt: input.prompt.trim(), ratio: input.ratio,
    references: input.references.map(item => ({ role: item.role, sha256: item.sha256.toLowerCase() })), provider, model })).digest('hex');
}
