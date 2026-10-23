import fs from 'node:fs/promises';
import {parseHeyGenPublishedPrice,parseEcbUsdCny,HEYGEN_PRICE_URL,ECB_FX_URL} from '../server/lib/heygenPublishedPricing.js';
const results=await Promise.all([HEYGEN_PRICE_URL,ECB_FX_URL].map(async url=>{try{const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});const body=await r.text();return{url,status:r.status,body}}catch{return{url,status:0,body:''}}}));
const price=parseHeyGenPublishedPrice(results[0].body,'photo_avatar');const fx=parseEcbUsdCny(results[1].body);
await fs.mkdir('.interview-data',{recursive:true});await fs.writeFile('.interview-data/public-pricing.json',JSON.stringify({checkedAt:new Date().toISOString(),responses:results,price,fx},null,2));
console.log(JSON.stringify({pricingStatus:results[0].status,fxStatus:results[1].status,photoAvatarUsdPerMinute:price,fx}));
