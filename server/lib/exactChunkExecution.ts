import {classifyDiscoverySourceFailure} from '../socialDiscovery/sourceFailure.js';

/** Already submitted siblings are awaited; a definite model rejection prevents
 * smaller-frame retries and every subsequent batch, not merely result display. */
export async function executeExactChunks<C,T>(chunks:C[],concurrency:number,run:(chunk:C,attempt:1|2)=>Promise<T>,allowRetry=true):Promise<PromiseSettledResult<T>[]> {
 const settled:PromiseSettledResult<T>[]=[];
 const execute=async(chunk:C)=>{try{return await run(chunk,1);}catch(error){const message=error instanceof Error?error.message:String(error);if(!allowRetry||classifyDiscoverySourceFailure(error)==='model_unavailable'||/\b(?:401|402|403)\b|quota exhausted|insufficient (?:quota|balance|funds)|billing|invalid api key/i.test(message))throw error;return run(chunk,2);}};
 for(let offset=0;offset<chunks.length;offset+=concurrency){settled.push(...await Promise.allSettled(chunks.slice(offset,offset+concurrency).map(execute)));if(settled.some(r=>r.status==='rejected'&&classifyDiscoverySourceFailure(r.reason)==='model_unavailable'))break;}
 return settled;
}
