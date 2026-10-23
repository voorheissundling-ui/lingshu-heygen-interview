import {readOwnedStreamObservations} from './socialOwnedStreamObservations.js';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {socialRequestHash} from './socialContentValidation.js';
import type {SocialOwnedVideoMetadata} from '../../shared/contracts/socialWeeklyG6Review.js';
/** Independently decodes the exact owned bytes. Unknown output is never replaced with template metadata. */
export async function inspectSocialOwnedVideo(bytes:Buffer):Promise<SocialOwnedVideoMetadata|null>{
 const root=await mkdtemp(path.join(os.tmpdir(),'social-g6-metadata-')),file=path.join(root,'owned-video');
 try{await writeFile(file,bytes);const [probe,version]=await Promise.all([runVisualFfmpeg(['-hide_banner','-i',file,'-map','0:v:0','-f','null','-'],false,{logLevel:'info',timeoutMs:30000}),runVisualFfmpeg(['-version'],true)]);
 if(!probe.ok||!version.ok)return null;const video=/Stream #[^\n]+Video: ([^,\s]+)[^\n]*?\b(\d{2,5})x(\d{2,5})(?:\s|\[|,)[^\n]*?([\d.]+) fps/.exec(probe.stderr),duration=/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr),audio=/Stream #[^\n]+Audio: ([^,\s]+)/.exec(probe.stderr);if(!video||!duration)return null;
 let container:SocialOwnedVideoMetadata['container']=null;if(bytes.subarray(4,8).toString()==='ftyp'){container=bytes.subarray(8,12).toString()==='qt  '?'mov':'mp4';}else if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&/Input #0, [^\n]*webm/.test(probe.stderr))container='webm';
 const value={...readOwnedStreamObservations(probe.stderr),fileSha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,container,videoCodec:video[1]!,width:Number(video[2]),height:Number(video[3]),framesPerSecond:Number(video[4]),durationSeconds:Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]),audioCodec:audio?.[1]??null,probeTool:'ffmpeg_owned_byte_decode',probeVersion:version.stdout.toString().split('\n')[0]??''};if(!value.probeVersion||![value.width,value.height,value.framesPerSecond,value.durationSeconds].every(n=>Number.isFinite(n)&&n>0))return null;return {...value,recordHash:socialRequestHash(value)};
 }finally{await rm(root,{recursive:true,force:true});}
}
