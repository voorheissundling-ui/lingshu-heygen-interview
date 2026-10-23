import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {inspectSocialOwnedVideo} from './socialOwnedVideoMetadata.js';
import {socialRequestHash} from './socialContentValidation.js';
import type {SocialOwnedVideoMetadata} from '../../shared/contracts/socialWeeklyG6Review.js';

/** Changing filters or encoding options requires a new version and fresh output review. */
export const INSTAGRAM_DELIVERY_CONVERSION_VERSION='instagram-blurred-fit-720x1280-h264-aac-v2';
export interface InstagramDeliveryConversion {
 conversionVersion:typeof INSTAGRAM_DELIVERY_CONVERSION_VERSION;
 sourceSha256:string;deliverySha256:string;bytes:Buffer;
 metadata:SocialOwnedVideoMetadata;conversionHash:string;
}
/** Local packaging only. It neither publishes nor claims technical/creative approval. */
export async function convertInstagramDelivery(source:Buffer,expectedSourceSha256:string):Promise<InstagramDeliveryConversion>{
 const sourceSha256=createHash('sha256').update(source).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(expectedSourceSha256)||sourceSha256!==expectedSourceSha256)throw Error('instagram_delivery_source_hash_changed');
 if(!source.length||source.length>110*1024*1024)throw Error('instagram_delivery_source_size_invalid');
 const root=await mkdtemp(path.join(os.tmpdir(),'social-instagram-delivery-'));
 try{
  const input=path.join(root,'source'),output=path.join(root,'delivery.mp4');await writeFile(input,source);
  const converted=await runVisualFfmpeg(['-y','-i',input,'-filter_complex',
   '[0:v]split=2[background][foreground];[background]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:10[background_ready];[foreground]scale=720:1280:force_original_aspect_ratio=decrease[foreground_ready];[background_ready][foreground_ready]overlay=(W-w)/2:(H-h)/2,format=yuv420p[video]',
   '-map','[video]','-map','0:a?','-c:v','libx264','-profile:v','high','-level:v','4.0','-preset','medium','-crf','20','-maxrate','8M','-bufsize','16M','-r','30','-g','60','-keyint_min','60','-sc_threshold','0','-flags','+cgop','-c:a','aac','-profile:a','aac_low','-ar','48000','-ac','2','-b:a','128k','-movflags','+faststart','-use_editlist','0',output],false,{timeoutMs:120000});
  if(!converted.ok)throw Error('instagram_delivery_conversion_failed');
  const bytes=await readFile(output);if(!bytes.length||bytes.length>110*1024*1024)throw Error('instagram_delivery_output_size_invalid');
  const metadata=await inspectSocialOwnedVideo(bytes);
  if(!metadata||metadata.width!==720||metadata.height!==1280||metadata.framesPerSecond!==30||metadata.videoCodec!=='h264'||metadata.container!=='mp4')throw Error('instagram_delivery_output_decode_failed');
  // Explicitly decode optional audio too; header observations alone are not audio QC.
  const decoded=await runVisualFfmpeg(['-i',output,'-map','0:v:0','-map','0:a?','-f','null','-'],false,{timeoutMs:120000});
  if(!decoded.ok)throw Error('instagram_delivery_output_decode_failed');
  const deliverySha256=createHash('sha256').update(bytes).digest('hex');
  const proof={conversionVersion:INSTAGRAM_DELIVERY_CONVERSION_VERSION as typeof INSTAGRAM_DELIVERY_CONVERSION_VERSION,sourceSha256,deliverySha256,metadataHash:metadata.recordHash};
  return {...proof,bytes,metadata,conversionHash:socialRequestHash(proof)};
 }finally{await rm(root,{recursive:true,force:true});}
}
