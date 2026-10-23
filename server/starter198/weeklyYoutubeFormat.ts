import type {SocialOwnedVideoMetadata,SocialWeeklyG6Check} from '../../shared/contracts/socialWeeklyG6Review.js';
import {socialRequestHash} from './socialContentValidation.js';

const sources=[
 'https://support.google.com/youtube/troubleshooter/2888402?hl=en',
 'https://support.google.com/youtube/answer/71673?hl=en',
 'https://developers.google.com/youtube/v3/docs/videos/insert',
];
/** Published upload limits, verified 2026-10-10. Account long-video eligibility
 * is a separate provider fact; absence never becomes a client approval flag. */
export function checkWeeklyYoutubeFormat(metadata:SocialOwnedVideoMetadata|null):SocialWeeklyG6Check {
 const result=(status:SocialWeeklyG6Check['status'],reasons:string[]):SocialWeeklyG6Check=>({code:'platform_format',status,reasons,evidenceRefs:[...sources,...(metadata?[`owned_metadata:${metadata.recordHash}`]:[])]});
 if(!metadata)return result('unknown',['owned_media_metadata_unavailable']);
 const {recordHash,...body}=metadata;
 if(recordHash!==socialRequestHash(body)||!/^[a-f0-9]{64}$/.test(metadata.fileSha256)||!Number.isSafeInteger(metadata.bytes)||metadata.bytes<=0||!Number.isSafeInteger(metadata.width)||metadata.width<=0||!Number.isSafeInteger(metadata.height)||metadata.height<=0||!Number.isFinite(metadata.framesPerSecond)||metadata.framesPerSecond<=0||!Number.isFinite(metadata.durationSeconds)||metadata.durationSeconds<=0||metadata.probeTool!=='ffmpeg_owned_byte_decode'||!metadata.probeVersion)return result('unknown',['owned_media_metadata_integrity_unverified']);
 const blocked:string[]=[];
 // Use decimal GB conservatively: the official pages state GB without a
 // binary-unit guarantee. Production also enforces its own smaller read cap.
 if(metadata.bytes>256_000_000_000)blocked.push('actual_file_size_exceeds_youtube_limit');
 if(metadata.durationSeconds>12*60*60)blocked.push('actual_duration_exceeds_youtube_limit');
 if(blocked.length)return result('blocked',blocked);
 if(!metadata.container||!['mp4','mov','webm'].includes(metadata.container))return result('unknown',['actual_youtube_supported_container_unverified']);
 if(!metadata.videoCodec)return result('unknown',['actual_video_codec_unverified']);
 if(metadata.durationSeconds>15*60)return result('unknown',['actual_youtube_long_video_account_eligibility_unverified']);
 return result('passed',[]);
}
