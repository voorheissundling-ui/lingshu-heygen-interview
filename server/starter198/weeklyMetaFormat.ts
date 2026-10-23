import {verifyInstagramArchivedStreamProof,type InstagramArchivedStreamProof} from './instagramArchivedStreamProof.js';
import type {SocialOwnedVideoMetadata,SocialWeeklyG6Check} from '../../shared/contracts/socialWeeklyG6Review.js';
import {socialRequestHash} from './socialContentValidation.js';
const instagramSource='https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md';
const instagramCollection='https://www.postman.com/meta/instagram/folder/y6xustx/reels-publishing';
const facebookReference='https://developers.facebook.com/docs/graph-api/reference/page/videos/';
const linkedinReference='https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api';
/** Versioned local archive admission based on Meta's official sample, checked
 * 2026-10-10. Exact owned bytes must prove the MP4 structure and AVC sync samples.
 * The local 110 MiB ceiling is stricter than the sample's 1 GB limit. This is
 * technical format evidence; account permission and provider acceptance remain
 * independent G6 checks. Facebook Page Videos keeps its separate unknown rules. */
export function checkWeeklyMetaFormat(platform:'instagram'|'facebook'|'linkedin',metadata:SocialOwnedVideoMetadata|null,delivery?:{deliveryProofHash:string;streamProof?:InstagramArchivedStreamProof}):SocialWeeklyG6Check{
 const result=(status:SocialWeeklyG6Check['status'],reasons:string[]):SocialWeeklyG6Check=>({code:'platform_format',status,reasons,evidenceRefs:[...(platform==='instagram'?[instagramSource,instagramCollection]:platform==='linkedin'?[linkedinReference]:[facebookReference]),platform==='linkedin'?'linkedin_video_rules:2026-10':'meta_format_archived_rules:2026-10-10',...(metadata?[`owned_metadata:${metadata.recordHash}`]:[]),...(delivery&&/^[a-f0-9]{64}$/.test(delivery.deliveryProofHash)?[`archived_instagram_delivery:${delivery.deliveryProofHash}`]:[]),...(delivery?.streamProof?[`instagram_stream_proof:${delivery.streamProof.proofHash}`]:[])]});
 if(!metadata)return result('unknown',['owned_media_metadata_unavailable']);
 const {recordHash,...body}=metadata;
 if(recordHash!==socialRequestHash(body)||!/^[a-f0-9]{64}$/.test(metadata.fileSha256)||metadata.probeTool!=='ffmpeg_owned_byte_decode'||!metadata.probeVersion||!Number.isSafeInteger(metadata.bytes)||metadata.bytes<=0||![metadata.width,metadata.height].every(x=>Number.isSafeInteger(x)&&x>0)||![metadata.framesPerSecond,metadata.durationSeconds].every(x=>Number.isFinite(x)&&x>0))return result('unknown',['owned_media_metadata_integrity_unverified']);
 if(platform==='linkedin'){
  const reasons:string[]=[];
  if(metadata.container!=='mp4')reasons.push('linkedin_video_container_not_supported');
  if(metadata.bytes<75*1024||metadata.bytes>500*1024*1024)reasons.push('linkedin_video_file_size_outside_rule');
  if(metadata.durationSeconds<3||metadata.durationSeconds>30*60)reasons.push('linkedin_video_duration_outside_rule');
  return result(reasons.length?'blocked':'passed',reasons);
 }
 if(platform==='facebook')return result('unknown',['facebook_page_videos_current_format_rules_unverified']);
 const reasons:string[]=[];
 if(!metadata.container||!['mp4','mov'].includes(metadata.container))reasons.push('instagram_reels_container_not_supported');
 if(!['h264','hevc'].includes(metadata.videoCodec))reasons.push('instagram_reels_video_codec_not_supported');
 if(metadata.audioCodec!==null&&metadata.audioCodec!=='aac')reasons.push('instagram_reels_audio_codec_not_supported');
 if(metadata.framesPerSecond<23||metadata.framesPerSecond>60)reasons.push('instagram_reels_framerate_outside_rule');
 if(metadata.width>1920)reasons.push('instagram_reels_width_exceeds_rule');
 if(metadata.width/metadata.height<0.01||metadata.width/metadata.height>10)reasons.push('instagram_reels_aspect_ratio_outside_rule');
 if(metadata.durationSeconds<3||metadata.durationSeconds>900)reasons.push('instagram_reels_duration_outside_rule');
 if(metadata.videoBitrateBitsPerSecond!=null&&metadata.videoBitrateBitsPerSecond>25_000_000)reasons.push('instagram_reels_video_bitrate_exceeds_rule');
 if(metadata.audioSampleRateHz!=null&&metadata.audioSampleRateHz>48_000)reasons.push('instagram_reels_audio_sample_rate_exceeds_rule');
 if(metadata.audioChannels!=null&&![1,2].includes(metadata.audioChannels))reasons.push('instagram_reels_audio_channels_not_supported');
 if(metadata.videoScanMode==='interlaced')reasons.push('instagram_reels_video_scan_not_progressive');
 if(metadata.videoPixelFormat!=null&&/^yuvj?(422|444|411|410)/.test(metadata.videoPixelFormat))reasons.push('instagram_reels_chroma_not_supported');
 if(reasons.length)return result('blocked',reasons);
 if(metadata.bytes>110*1024*1024)return result('blocked',['instagram_archived_delivery_size_exceeds_local_rule']);
 if(!delivery||!/^[a-f0-9]{64}$/.test(delivery.deliveryProofHash))return result('unknown',['instagram_publish_derivative_source_unverified','instagram_reels_stream_structure_unverified']);
 const proof=delivery.streamProof;
 if(!proof||!verifyInstagramArchivedStreamProof(proof,metadata.fileSha256)||proof.bytes!==metadata.bytes)return result('unknown',['instagram_reels_stream_structure_unverified']);
 if(proof.status!=='passed')return result(proof.status,proof.reasons);
 if(metadata.videoScanMode!=='progressive'||metadata.videoPixelFormat!=='yuv420p'||metadata.videoBitrateBitsPerSecond==null)return result('unknown',['instagram_reels_video_stream_observations_incomplete']);
 if(metadata.audioCodec!==null&&(metadata.audioSampleRateHz==null||metadata.audioChannels==null))return result('unknown',['instagram_reels_audio_stream_observations_incomplete']);
 return result('passed',[]);
}
