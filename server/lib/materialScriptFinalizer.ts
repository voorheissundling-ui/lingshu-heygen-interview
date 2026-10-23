import { callVideoModel } from '../digitalEmployees/videoModel.js';
import { spokenLanguageMatches } from '../../shared/contracts/videoCreationPlan.js';
export async function finalizeMaterialScript(input: {script:string;facts:string;language:string;infos:Array<{name:string;targetStart?:number;targetEnd?:number;observations?:string[]}>}, model: typeof callVideoModel = callVideoModel) {
  if(!input.infos.length || input.infos.some(info=>!info.name))throw Error('请选择有名称的真实素材区间');
  let lines=Array.from(input.script.matchAll(/^(?:台词|口播|对白)[：:]\s*(.+)$/gm)).map(match=>match[1].trim());
  if(lines.length!==input.infos.length) throw Error('分镜台词数量与已选素材区间不一致');
  const facts=input.facts+'\n可见事实：\n'+input.infos.map((info,i)=>`${i+1}. ${info.observations?.join('；')||''}`).join('\n');
  let problemIndexes = new Set<number>();
  const review = async () => {
    if(!spokenLanguageMatches(lines.join(' '),input.language)) {problemIndexes=new Set(lines.map((_,i)=>i));return ['口播语言与目标语言不一致'];}
    const pairs=input.infos.map((info,i)=>({scene:i+1,spoken:lines[i],evidence:info.observations}));
    const {text}=await model(`审核素材视频的口播事实，不作风格评分。每句台词只对应同一个scene的evidence，不要求所有镜头都包含该细节。普通同义翻译允许。看一看、注意某细节等邀请和中性问题不是事实承诺；无需加拍摄时间或审核说明。不要要求每句复述全部证据。只检查明确新增的数值/规格、性能效果、生产/检测结论、服务承诺，或与已确认事实直接矛盾的陈述。这里的“性能/参数”必须是句中明确声称的指标、效果或结论，不通过物体名词的字面含义联想出隐含承诺。已确认事实中的物体名称及其标准翻译直接允许，不能再否定这些已确认事实。例如走线=traces，焊点=solder joints，集成电路芯片=IC chip，引脚=pins；说焊点不等于承诺焊接可靠性，说走线不等于承诺线宽精度。普通可见形状或位置的概括、邀请观看、英语惯用语不扩展成技术结论。只有句子实际说“高良率、无缺陷、通过测试、某数值”等才能以这些承诺为由拒绝。
产品事实：${input.facts}
逐镜对应：${JSON.stringify(pairs)}
只输出JSON {"issues":[{"quote":"问题台词中逐字出现的原文","reason":"实质错误"}]}。完全支持或仅有文风建议时返回空数组。`,{timeoutMs:60000});
    const parsed=JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'').trim());
    if(!Array.isArray(parsed.issues))throw Error('口播事实审核未返回结论');
    if(parsed.issues.some((item:any)=>typeof item.quote!=='string' || !item.quote.trim() || !lines.some(line=>line.includes(item.quote)) || typeof item.reason!=='string'))throw Error('口播审核未能定位问题原句，请重试');
    problemIndexes = new Set(lines.flatMap((line,i)=>parsed.issues.some((item:any)=>line.includes(item.quote)) ? [i] : []));
    return parsed.issues.map((item:any)=>`${item.quote}：${item.reason}`);
  };
  let issues=await review();
  if(issues.length) {
    const {text}=await model(`按审核意见修复素材视频口播，只删除或简化指出的问题词，不引入任何新主体、细节或事实；未指出问题的句子逐字保留。保持恰好${input.infos.length}句，与素材区间一一对应。所有台词使用${input.language}。每句不超过对应区间时长可自然说完的字词数；英语每秒最多2.5词。只写可見外观，不写性能、品质、交付、测试、生产工艺或材质推论。问候/收尾可邀请看细节，不承诺服务。不要朗读素材文件名。\n事实：${facts}\n区间时长：${input.infos.map(info=>Number(info.targetEnd)-Number(info.targetStart)).join(',')}秒\n原口播：${JSON.stringify(lines)}\n审核意见：${issues.join('；')}\n只输出JSON {"lines":["完整自然的句子"]}。`,{timeoutMs:60000});
    const payload=JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'').trim());
    if(!Array.isArray(payload.lines) || payload.lines.length!==input.infos.length || payload.lines.some((line:unknown)=>typeof line!=='string'))throw Error('口播修复未保留分镜结构');
    lines=lines.map((line,i)=>problemIndexes.has(i) ? payload.lines[i] : line);
    issues=await review();
  }
  if(issues.length || !spokenLanguageMatches(lines.join(' '),input.language))throw Error(issues.join('；') || '目标口播语言不一致');
  return input.infos.map((info,i)=>`[${info.targetStart}-${info.targetEnd}s]\n素材：${info.name}\n环境：沿用原片\n景别：沿用原片\n运镜：沿用原片\n构图：保留原片实际主体\n镜头功能：${i===0?'外观引入':'外观细节'}\n画面：${info.observations?.join('；')||'已确认素材区间'}\n台词：${lines[i]}\n字幕：${lines[i]}`).join('\n\n');
}
