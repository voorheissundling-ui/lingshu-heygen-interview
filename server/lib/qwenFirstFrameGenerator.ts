import { FirstFrameProviderError, validateFirstFrameRequest, type FirstFrameGenerator, type FirstFrameRequest, type FirstFrameResult } from './firstFrameGenerator.js';
import {QWEN_COMPATIBLE_BASE_URL} from './qwenCompatibleEndpoint.js';

type QwenPayload = { data?: Array<{ url?: string; b64_json?: string }>; output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> }; request_id?: string; error?: { message?: string }; message?: string };
const dataUrl = (reference: FirstFrameRequest['references'][number]) => `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`;
const size = (ratio: FirstFrameRequest['ratio']) => ratio === '9:16' ? '1024*1792' : ratio === '16:9' ? '1792*1024' : '1024*1024';
const mime = (contentType: string | null): FirstFrameResult['mimeType'] => /webp/i.test(contentType || '') ? 'image/webp' : /jpe?g/i.test(contentType || '') ? 'image/jpeg' : 'image/png';

export class QwenFirstFrameGenerator implements FirstFrameGenerator {
  readonly provider='qwen' as const;
  readonly model:string;
  readonly estimatedCostCny:number;
  constructor(private readonly options:{apiKey?:string;baseUrl?:string;model?:string;estimatedCostCny?:number;transport?:typeof fetch}={}){
    this.model=options.model||process.env.QWEN_IMAGE_MODEL||'qwen-image-3.0';
    this.estimatedCostCny=options.estimatedCostCny??Number(process.env.QWEN_FIRST_FRAME_ESTIMATED_CNY||.22);
  }
  async generate(input:FirstFrameRequest):Promise<FirstFrameResult>{
    validateFirstFrameRequest(input);const apiKey=String(this.options.apiKey||process.env.DASHSCOPE_API_KEY||'').trim();if(!apiKey)throw new FirstFrameProviderError('千问 Image 未配置 DASHSCOPE_API_KEY','rejected','','before_submit');if(!Number.isFinite(this.estimatedCostCny)||this.estimatedCostCny<=0)throw new FirstFrameProviderError('千问首帧预计费用配置无效','rejected','','before_submit');
    const base=String(this.options.baseUrl||process.env.DASHSCOPE_IMAGE_BASE_URL||process.env.DASHSCOPE_BASE_URL||QWEN_COMPATIBLE_BASE_URL).replace(/\/+$/,'');if(!/\/compatible-mode\/v1$/i.test(base))throw new FirstFrameProviderError('DASHSCOPE_IMAGE_BASE_URL 必须是百炼 OpenAI 兼容端点','rejected','','before_submit');const fetcher=this.options.transport||fetch;let response:Response;
    try{response=await fetcher(`${base}/images/generations`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','X-Client-Request-Id':input.idempotencyKey},body:JSON.stringify({model:this.model,prompt:input.prompt.trim(),image:input.references.map(dataUrl),n:1,size:size(input.ratio)}),signal:AbortSignal.timeout(120_000),redirect:'error'});}catch(error){throw new FirstFrameProviderError(`千问首帧请求状态未知：${error instanceof Error?error.message:'network_error'}`,'uncertain',input.idempotencyKey);}
    const payload=await response.json().catch(()=>({})) as QwenPayload;const requestId=response.headers.get('x-request-id')||payload.request_id||input.idempotencyKey;if(!response.ok)throw new FirstFrameProviderError(`千问 Image ${response.status}: ${String(payload.error?.message||payload.message||response.statusText).slice(0,300)}`,[400,401,403,404,422].includes(response.status)?'rejected':'uncertain',requestId);
    const item=payload.data?.[0];const outputUrl=String(item?.url||payload.output?.choices?.[0]?.message?.content?.[0]?.image||'');let bytes:Buffer;let mimeType:FirstFrameResult['mimeType']='image/png';if(item?.b64_json)bytes=Buffer.from(item.b64_json,'base64');else if(/^https:\/\//i.test(outputUrl)){let download:Response;try{download=await fetcher(outputUrl,{signal:AbortSignal.timeout(90_000),redirect:'error'});}catch(error){throw new FirstFrameProviderError(`千问已生成但产物下载状态未知：${error instanceof Error?error.message:'network_error'}`,'uncertain',requestId);}if(!download.ok)throw new FirstFrameProviderError(`千问已生成但产物下载失败：HTTP ${download.status}`,'uncertain',requestId);mimeType=mime(download.headers.get('content-type'));try{bytes=Buffer.from(await download.arrayBuffer());}catch(error){throw new FirstFrameProviderError(`千问已生成但产物读取状态未知：${error instanceof Error?error.message:'body_error'}`,'uncertain',requestId);}}else throw new FirstFrameProviderError('千问返回成功但缺少图片产物','uncertain',requestId);if(!bytes.length)throw new FirstFrameProviderError('千问返回空图片','uncertain',requestId);return{bytes,mimeType,provider:this.provider,model:this.model,providerRequestId:requestId,estimatedCostCny:this.estimatedCostCny};
  }
}
