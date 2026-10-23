/** Read-only provider probe. No video generation, uploads, or billing changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
async function main(){
 const keyFile=process.env.HEYGEN_KEY_FILE;
 if(!keyFile)throw Error('missing_HEYGEN_KEY_FILE');
 const key=(await fs.readFile(path.resolve(keyFile),'utf8')).trim();
 if(!key||key.includes('\n')||/\s/.test(key))throw Error('key_file_must_contain_only_the_API_key');
 async function get(route){
  const response=await fetch('https://api.heygen.com'+route,{method:'GET',redirect:'error',headers:{'x-api-key':key},signal:AbortSignal.timeout(20000)});
  // Never print provider error bodies, key, account names, or signed media URLs.
  if(!response.ok)throw Error('heygen_read_http_'+response.status);
  const value=await response.json();if(value.error||value.data==null)throw Error('heygen_read_invalid_response');return value;
 }
 const [account,avatars,voices]=await Promise.all([get('/v3/users/me'),get('/v3/avatars/looks?ownership=public&limit=20'),get('/v3/voices?type=public&limit=20')]);
 if(!Array.isArray(avatars.data)||!Array.isArray(voices.data))throw Error('heygen_catalog_shape_unverified');
 const report={checkedAt:new Date().toISOString(),mode:'read_only_no_generation',billingType:account.data.billing_type??null,wallet:account.data.wallet?{currency:account.data.wallet.currency,remainingBalance:account.data.wallet.remaining_balance,autoReloadEnabled:account.data.wallet.auto_reload?.enabled??null}:null,
 publicAvatars:avatars.data.map(v=>({id:v.id,status:v.status,avatarType:v.avatar_type,supportedEngines:v.supported_api_engines})),publicVoices:voices.data.map(v=>({id:v.voice_id,language:v.language,engines:v.available_engines})),catalogPaginated:!!avatars.has_more||!!voices.has_more,paidGenerationVerified:false,accountSpendingCapConfigured:false};
 await fs.mkdir('.interview-data',{recursive:true});await fs.writeFile('.interview-data/provider-preflight.json',JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({preflight:'READ_ONLY_COMPLETE',publicAvatarCount:report.publicAvatars.length,publicVoiceCount:report.publicVoices.length,paidGenerationVerified:false,report:'.interview-data/provider-preflight.json'}));
}
main().catch(error=>{console.error(error?.code==='ENOENT'?'key_file_not_found':String(error.message??'preflight_failed').replace(/https?:\/\/\S+/g,'[redacted-url]'));process.exitCode=1});
