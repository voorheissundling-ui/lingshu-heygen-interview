import type {PrepaidOriginalGetPort,PrepaidOriginalGetReceipt} from './weeklyAccountCollectionBudget.js';

const API='https://api.apify.com';
const fail=():never=>{throw Error('weekly_account_collection_budget_prepaid_original_get_unverified');};

/** A narrow, authenticated, uncached provider reader for the original run and
 * its storage. It intentionally cannot submit an Actor or mint a paid permit.
 * An injected fetcher exists for transport tests, not caller-supplied JSON. */
export function createApifyPrepaidOriginalGetPort(fetcher:typeof fetch=fetch):PrepaidOriginalGetPort {
 return {async get(input:{url:string;token:string}):Promise<PrepaidOriginalGetReceipt>{
  if(!input.token||input.token.trim()!==input.token||input.token.includes('\n')||input.token.includes('\r'))fail();
  let url:URL;try{url=new URL(input.url);}catch{return fail();}
  if(url.origin!==API||url.username||url.password||url.hash||url.searchParams.has('token'))fail();
  const path=url.pathname;
  const actor=/^\/v2\/actors\/[a-zA-Z0-9_-]+~[a-zA-Z0-9_-]+$/;
  const run=/^\/v2\/actor-runs\/[a-zA-Z0-9_-]+$/;
  const dataset=/^\/v2\/datasets\/[a-zA-Z0-9_-]+\/items$/;
  if(!(actor.test(path)||run.test(path)||dataset.test(path)))fail();
  if(dataset.test(path)){
   if([...url.searchParams.keys()].sort().join(',')!=='format,limit,offset'||url.searchParams.get('format')!=='json'||url.searchParams.get('limit')!=='5'||url.searchParams.get('offset')!=='0')fail();
  }else if(url.search)fail();
  const response=await fetcher(input.url,{method:'GET',headers:{Authorization:`Bearer ${input.token}`,Accept:'application/json','Cache-Control':'no-store'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(response.url!==input.url)fail();
  if(response.status!==200)fail();
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length===0||bytes.length>2_000_000)fail();
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
  return {status:response.status,url:input.url,body};
 }};
}
