import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

export type SimpleCaptionPixelProof={status:'matched'|'unknown';reason:string;frameCount:number;failedFrameIndex?:number};
const escapeFilterPath=(value:string)=>value.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/,/g,'\\,');

/** Narrow, complete decoded-frame proof for plain captions over a solid dark base.
 * Complex imagery and effects are deliberately not certified by this routine.
 */
export async function proveSimpleCaptionPixels(input:{finalPath:string;baselinePath:string;assPath:string;width:number;height:number;expectedFrameCount:number}):Promise<SimpleCaptionPixelProof>{
 const {width,height,expectedFrameCount}=input;
 if(!ffmpegStatic||!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width*height>640*360||!Number.isInteger(expectedFrameCount)||expectedFrameCount<1||expectedFrameCount>300)return {status:'unknown',reason:'简单字幕像素证明超出有界范围',frameCount:0};
 const stride=width*3,frameBytes=stride*height;
 const graph=`[0:v]format=gray[final];[1:v]format=gray,split=2[base][templatein];[templatein]subtitles='${escapeFilterPath(input.assPath)}',format=gray[template];[final][base][template]hstack=inputs=3[out]`;
 const child=spawn(String(ffmpegStatic),['-hide_banner','-loglevel','error','-nostdin','-i',input.finalPath,'-i',input.baselinePath,'-filter_complex',graph,'-map','[out]','-an','-vsync','0','-pix_fmt','gray','-f','rawvideo','pipe:1'],{stdio:['ignore','pipe','pipe']});
 const exit=new Promise<number|null>(resolve=>{child.on('error',()=>resolve(null));child.on('close',code=>resolve(code));});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120_000);
 child.stderr?.resume();
 let pending=Buffer.alloc(0),index=0,failedFrameIndex:number|undefined,reason='';
 try{
  for await(const chunk of child.stdout!){
   pending=Buffer.concat([pending,chunk]);
   while(pending.length>=frameBytes){
    if(index>=expectedFrameCount){reason='解码帧多于冻结时间轴';child.kill('SIGKILL');break;}
    const frame=pending.subarray(0,frameBytes);pending=pending.subarray(frameBytes);
    let glyph=0,badGlyph=0,baseBad=0,unexpected=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
     const row=y*stride,actual=frame[row+x]!,base=frame[row+width+x]!,expected=frame[row+2*width+x]!;
     if(base>12)baseBad++;
     if(expected>base+48){glyph++;if(Math.abs(actual-expected)>48)badGlyph++;}
     else if(actual>expected+64)unexpected++;
    }
    // A percentage tolerance can hide one missing glyph in a long caption.
    // Permit only two codec-noise pixels in each direction per decoded frame.
    if(baseBad>width*height*0.001||!glyph||badGlyph>2||unexpected>2){
     failedFrameIndex=index;reason=baseBad>width*height*0.001?'基底不是受支持的纯暗画面':!glyph?'字幕模板当前帧没有字形':'最终帧与逐字模板像素不一致';child.kill('SIGKILL');break;
    }
    index++;
   }
   if(reason)break;
  }
  const code=await exit;
  if(reason)return {status:'unknown',reason,frameCount:index,...(failedFrameIndex===undefined?{}:{failedFrameIndex})};
  if(code!==0||index!==expectedFrameCount||pending.length)return {status:'unknown',reason:'完整解码帧数或模板比对不一致',frameCount:index};
  return {status:'matched',reason:'有界纯暗基底的每一解码帧与同次 ASS 字形模板像素相符；不证明复杂画面、OCR 可读性或 G4 其他维度',frameCount:index};
 }catch{return {status:'unknown',reason:'逐帧简单字幕像素核验失败',frameCount:index};}
 finally{clearTimeout(timer);child.kill('SIGKILL');}
}
