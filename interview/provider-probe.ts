/** Isolated one-shot supplier environment check, NOT the complete employee production flow.
 * Explicit paid opt-in, persisted original request identity, no POST retry, no private assets.
 */
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {HeyGenClient} from '../server/lib/heygen.js';
import {parseHeyGenPublishedPrice,parseEcbUsdCny,HEYGEN_PRICE_URL,ECB_FX_URL} from '../server/lib/heygenPublishedPricing.js';
const root=path.resolve('.interview-data/provider-probe'),stateFile=path.join(root,'state.json');
await fs.mkdir(root,{recursive:true});
const lock=await fs.open(path.join(root,'execution.lock'),'wx');
try{
 const keyFile=process.env.HEYGEN_KEY_FILE;if(!keyFile)throw Error('missing_HEYGEN_KEY_FILE');const credential=(await fs.readFile(keyFile,'utf8')).trim();
 const credentialHash=createHash('sha256').update(credential).digest('hex');
 let state:any;try{state=JSON.parse(await fs.readFile(stateFile,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const persist=async()=>{const tmp=stateFile+'.tmp';await fs.writeFile(tmp,JSON.stringify(state,null,2),{mode:0o600});await fs.rename(tmp,stateFile)};
 const get=async(route:string)=>{const r=await fetch('https://api.heygen.com'+route,{headers:{'x-api-key':credential},redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('heygen_read_http_'+r.status);const j=await r.json() as any;if(j.error||!j.data)throw Error('heygen_read_invalid');return j.data};
 if(!state){
  if(!process.argv.includes('--submit-approved-probe'))throw Error('no_probe_to_resume_explicit_submission_required');
  const approvedCny=Number(process.env.HEYGEN_INTERVIEW_MAX_CNY);if(!(approvedCny>0&&approvedCny<=30))throw Error('explicit_budget_CNY_required_maximum_30');
  const [priceBody,fxBody,account,avatars,voices]=await Promise.all([fetch(HEYGEN_PRICE_URL,{redirect:'error',signal:AbortSignal.timeout(20000)}).then(r=>{if(!r.ok)throw Error('price_unavailable');return r.text()}),fetch(ECB_FX_URL,{redirect:'error',signal:AbortSignal.timeout(20000)}).then(r=>{if(!r.ok)throw Error('fx_unavailable');return r.text()}),get('/v3/users/me'),get('/v3/avatars/looks?ownership=public&limit=20'),get('/v3/voices?type=public&language=English&limit=20')]);
  const price=parseHeyGenPublishedPrice(priceBody,'photo_avatar'),fx=parseEcbUsdCny(fxBody);
  if(!price||!fx||account.billing_type!=='wallet'||String(account.wallet?.currency).toLowerCase()!=='usd'||account.wallet?.auto_reload?.enabled!==false)throw Error('verified_pricing_wallet_or_disabled_auto_reload_missing');
  const avatar=avatars.find((v:any)=>v.status==='completed'&&v.avatar_type==='photo_avatar'&&v.supported_api_engines?.includes('avatar_iv'));const voice=voices.find((v:any)=>v.type==='public'&&v.voice_id);
  if(!avatar||!voice)throw Error('public_avatar_or_voice_missing');
  // Reserve a full minute for this six-word short probe. No automatic second generation.
  const reservedCny=price*fx.cnyPerUsd;if(reservedCny>approvedCny||account.wallet.remaining_balance<price)throw Error('probe_reservation_exceeds_budget_or_wallet');
  state={schemaVersion:1,mode:'isolated_supplier_probe',baseline:'20fe685fa87c33680e3cc079fac62dcd07e0272a',phase:'prepared',requestId:'interview-'+randomUUID(),credentialHash,approvedCny,reservedCny,priceUsdPerMinute:price,fx,avatarId:avatar.id,voiceId:voice.voice_id,script:'Hello. This is a test.',walletBefore:account.wallet.remaining_balance,createdAt:new Date().toISOString(),paidSubmissions:0};await persist();
  await fs.writeFile(path.join(root,'pricing-source.html'),priceBody);await fs.writeFile(path.join(root,'fx-source.xml'),fxBody);
 }
 if(state.credentialHash!==credentialHash)throw Error('probe_credential_changed');
 const client=new HeyGenClient(credential,fetch,{
  async beforeSubmit(body,requestId){if(state.phase!=='prepared'||state.paidSubmissions!==0||requestId!==state.requestId||body.avatar_id!==state.avatarId||body.voice_id!==state.voiceId||body.script!==state.script||body.type!=='avatar'||body.output_format!=='mp4'||body.engine)throw Error('probe_submission_not_authorized');state.phase='submitting';state.paidSubmissions=1;state.requestHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');await persist()},
  async onAccepted(videoId,requestId){if(requestId!==state.requestId)throw Error('probe_identity_drift');state.videoId=videoId;state.phase='accepted';await persist()},
  async onStatus(videoId,receipt){state.providerStatus=receipt.status;state.providerDuration=receipt.duration;state.lastCheckedAt=new Date().toISOString();await persist()}
 });
 if(state.phase==='prepared'){
  if(!process.argv.includes('--submit-approved-probe'))throw Error('explicit_submission_flag_required');
  try{await client.create({avatarId:state.avatarId,voiceId:state.voiceId,script:state.script,ratio:'9:16',transparent:false,title:'Interview environment check'},state.requestId)}catch(error){state.lastError='submission_rejected_or_unknown';await persist();throw error}
 }
 if(!state.videoId)throw Error('submission_result_unknown_do_not_resubmit_reconcile_original_request');
 // One status query per invocation. Restart resumes the same video_id; no background auto-retry.
 const result=await client.status(state.videoId);
 if(result.status==='failed'){state.phase='failed';await persist();throw Error('provider_generation_failed_no_resubmission')}
 if(result.status!=='completed'){console.log(JSON.stringify({status:'pending',videoId:state.videoId,paidSubmissions:state.paidSubmissions}));}
 else{
  const url=new URL(result.url!);if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('provider_download_url_invalid');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('download_http_'+response.status);
  const chunks:Uint8Array[]=[];let length=0;const reader=response.body?.getReader();if(!reader)throw Error('probe_media_empty');try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>64*1024*1024){await reader.cancel();throw Error('probe_media_too_large')}chunks.push(next.value)}}finally{reader.releaseLock()}const bytes=Buffer.concat(chunks);await fs.writeFile(path.join(root,'provider-output.mp4'),bytes);
  state.phase='downloaded';state.duration=result.duration;state.bytes=bytes.length;state.sha256=createHash('sha256').update(bytes).digest('hex');state.estimatedCostCny=result.duration!*state.priceUsdPerMinute/60*state.fx.cnyPerUsd;
  const account=await get('/v3/users/me');state.walletAfter=account.wallet?.remaining_balance;state.observedWalletDeltaUsd=state.walletBefore-state.walletAfter;state.observedWalletDeltaCny=state.observedWalletDeltaUsd*state.fx.cnyPerUsd;state.withinApprovedCap=state.observedWalletDeltaCny<=state.approvedCny;await persist();
  console.log(JSON.stringify({status:'downloaded',videoId:state.videoId,duration:state.duration,bytes:state.bytes,sha256:state.sha256,estimatedCostCny:state.estimatedCostCny,observedWalletDeltaUsd:state.observedWalletDeltaUsd,withinApprovedCap:state.withinApprovedCap,paidSubmissions:state.paidSubmissions}));
 }
}finally{await lock.close();await fs.rm(path.join(root,'execution.lock'),{force:true})}
