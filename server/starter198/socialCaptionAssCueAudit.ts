/** Exact source-side binding for plain ASS captions. This says nothing about pixels. */
export function auditPlainAssCueBinding(input:{ass:string;cues:Array<{start:number;end:number;text:string}>}):{status:'matched'|'mismatch'|'unknown';reason:string}{
 const lines=input.ass.split(/\r?\n/);
 const format=lines.find(line=>line.startsWith('Format: ')&&line.includes('Layer, Start, End, Style'));
 if(format!=='Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')return {status:'unknown',reason:'ASS 事件列不受支持'};
 const events=lines.filter(line=>line.startsWith('Dialogue: '));
 // The renderer may legitimately page one cue or add timed-word / emphasis
 // layers. Such output is outside this exact plain-event subset.
 if(!events.length||events.length!==input.cues.length)return {status:'unknown',reason:'ASS 事件数与冻结字幕数不同，可能含分页或强调层'};
 const time=(seconds:number)=>{
  if(!Number.isFinite(seconds)||seconds<0)return null;
  const cs=Math.round(seconds*100),h=Math.floor(cs/360000),m=Math.floor(cs%360000/6000),s=Math.floor(cs%6000/100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;
 };
 for(let i=0;i<events.length;i++){
  const cue=input.cues[i]!,start=time(cue.start),end=time(cue.end);
  if(!start||!end||cue.end<=cue.start||typeof cue.text!=='string'||!cue.text.trim())return {status:'unknown',reason:'冻结字幕字段不完整'};
  if(/[{}\\\r\n]/.test(cue.text))return {status:'unknown',reason:'复杂 ASS 转义或特效不在简单字幕核验范围'};
  const expected=`Dialogue: 0,${start},${end},Default,,0,0,0,,${cue.text}`;
  if(!/^Dialogue: 0,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},Default,,0,0,0,,[^{}\\\r\n]+$/.test(events[i]!))return {status:'unknown',reason:'ASS 使用复杂图层、分页或转义，不属于简单事件子集'};
  if(events[i]!==expected)return {status:'mismatch',reason:`第 ${i+1} 条简单 ASS 事件与冻结字幕文字或时间不一致`};
 }
 return {status:'matched',reason:'简单 ASS 事件与冻结 cue 的逐条文字、顺序和百分秒时间相同；不证明成片像素或可读性'};
}
