import { storyboardGeometryObservationPrompt, type StoryboardGeometryInference,
  type StoryboardGeometryObservation } from './storyboardGeometryPlanner.js';
import {qwenCompatibleBaseUrl} from './qwenCompatibleEndpoint.js';

export interface StoryboardGeometryQwenOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
}

/** Adapter only observes geometry in the already-confirmed current-shot frame.
 * The provider-independent planner separately checks source identity, numeric
 * geometry, contact, aspect, view, occlusion and confidence. */
export function createStoryboardGeometryQwenObserver(options: StoryboardGeometryQwenOptions = {}): StoryboardGeometryInference {
  return async request => {
    const apiKey = String(options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured');
    const baseUrl = String(options.baseUrl ?? qwenCompatibleBaseUrl()).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(baseUrl)) throw new Error('Qwen geometry endpoint must be HTTPS');
    const model = String(options.model ?? process.env.QWEN_VL_MODEL ?? 'qwen-vl-max').trim();
    if (!model) throw new Error('Qwen geometry model is not configured');
    const fetcher = options.fetcher || fetch;
    const prompt = storyboardGeometryObservationPrompt({ shotId: request.shotId,
      scene: request.scene, confirmedVisual: request.confirmedVisual,
      product: { assetId: '', version: '', view: request.productView, cutoutAspectRatio: 1 } });
    const response = await fetcher(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: `${prompt}\nThe frame identity to echo exactly is sourceFrameAssetId=${JSON.stringify(request.sourceFrame.assetId)}, sourceFrameVersion=${JSON.stringify(request.sourceFrame.version)}. Return only the JSON object, with no markdown.` },
          { type: 'image_url', image_url: { url: `data:${request.sourceFrame.mimeType};base64,${request.sourceFrame.base64}` } },
        ] }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(`Qwen geometry observation failed: HTTP ${response.status}`);
    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || raw.length > 10_000) throw new Error('Qwen geometry response is missing or oversized');
    let parsed: unknown;
    try { parsed = JSON.parse(raw.trim()); }
    catch { throw new Error('Qwen geometry response is not strict JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Qwen geometry response must be an object');
    const item = parsed as Partial<StoryboardGeometryObservation>;
    if (typeof item.shotId !== 'string' || typeof item.sourceFrameAssetId !== 'string'
      || typeof item.sourceFrameVersion !== 'string' || (item.scene !== 'tabletop' && item.scene !== 'conveyor')
      || !item.productBox || typeof item.productBox !== 'object' || typeof item.contactSurfaceY !== 'number'
      || typeof item.productView !== 'string' || !['none', 'required', 'uncertain'].includes(String(item.foregroundOcclusion))
      || typeof item.confidence !== 'number' || typeof item.evidence !== 'string')
      throw new Error('Qwen geometry response is missing required fields');
    return item as StoryboardGeometryObservation;
  };
}
