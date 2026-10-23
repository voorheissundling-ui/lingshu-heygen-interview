import {createHash} from 'node:crypto';
import {dashscopeApiKey} from '../agents/qwen.js';
import {classifyQwenCompatibleEndpoint} from './qwenCompatibleEndpoint.js';

export interface QwenMaaSCatalogEvidence {
  model:string;
  endpoint:string;
  credentialSha256:string;
  responseSha256:string;
  evidenceRef:string;
}

/** A read-only, account-bound preflight. Missing capability metadata is not
 * evidence that a text-only model accepts visual frames. */
export async function readQwenMaaSVisionCatalog(input:{endpoint:string;credentialSha256:string;model:string},ports:{fetch?:typeof fetch;apiKey?:()=>string}={}):Promise<QwenMaaSCatalogEvidence|null>{
  if(classifyQwenCompatibleEndpoint(input.endpoint)!=='qianwen-maas'||!/^[a-f0-9]{64}$/.test(input.credentialSha256)||!input.model.trim())return null;
  let key:string;try{key=(ports.apiKey??dashscopeApiKey)();}catch{return null;}
  if(createHash('sha256').update(key).digest('hex')!==input.credentialSha256)return null;
  const endpoint=input.endpoint.replace(/\/+$/,'');
  let response:Response;try{response=await (ports.fetch??fetch)(`${endpoint}/models`,{method:'GET',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{return null;}
  if(!response.ok)return null;
  let body:string;try{body=await response.text();if(body.length>1024*1024)return null;}catch{return null;}
  let payload:unknown;try{payload=JSON.parse(body);}catch{return null;}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
  const root=payload as Record<string,unknown>;
  if(root.object!=='list'||!Array.isArray(root.data)||root.data.length===0)return null;
  const rows=root.data.filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value));
  if(rows.length!==root.data.length)return null;
  const matches=rows.filter(row=>row.id===input.model);
  if(matches.length!==1)return null;
  const row=matches[0]!;
  const metadata=row.capabilities??row.input_modalities??row.modalities;
  const modalities=Array.isArray(metadata)?metadata:metadata&&typeof metadata==='object'?(metadata as Record<string,unknown>).input:undefined;
  if(!Array.isArray(modalities)||!modalities.some(value=>value==='image'||value==='vision'))return null;
  const responseSha256=createHash('sha256').update(body).digest('hex');
  return {model:input.model,endpoint,credentialSha256:input.credentialSha256,responseSha256,evidenceRef:`qwen-maas-catalog:${createHash('sha256').update(JSON.stringify({endpoint,credentialSha256:input.credentialSha256,model:input.model,responseSha256})).digest('hex')}`};
}
