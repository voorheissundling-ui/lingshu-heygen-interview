/** Validate the visual plan before any paid presenter generation or render. */
export interface MixedMaterialEvidence { name?: string; duration?: number; effectiveDuration?: number; observations?: string[] }
export function mixedStoryboardRules(mode: string, materials: MixedMaterialEvidence[]): string {
  if (mode !== 'heygen') return '';
  return `混剪交付硬约束（优先于通用补拍建议）：至少一镜数字人、至少一镜已选素材视频。默认首尾数字人，中段素材。每镜画面必须明确以“数字人：”或“素材《完整素材名》；源片截取：a-bs；”开头。数字人只面对镜头讲述，不凭空手持、操作或演示产品。素材仅来自下列闭集，不允许建议补拍、新拍人物或手部、虚构同一物件/正反面的连续性。只描述已观察的动作；没有足够素材时明确失败，不补造画面。源片截取是该文件从0起的局部秒数，不是成片时间轴；必须满足0≤a<b≤对应原始时长。不得把素材累计的建议时间段当源片时间。不要将这些制作要求写进口播。\n${materials.filter(m => m.name).map(m => `素材《${m.name}》原始时长 ${Number(m.duration || 0)}s；观察：${(m.observations || []).join('；') || '未提供，不能编造动作'}`).join('\n')}`;
}
/** Negative visual constraints are not observed actions. Keep contrast clauses separate. */
function affirmativeVisualDescription(value: string): string {
  return value.split(/[，,；;。\n、]|但是|然而|但|\bbut\b/i).map(clause =>
    clause.replace(/(?:无|没有|未(?:曾)?|不(?:会|要)?|禁止|不得|\bno\b|\bwithout\b|\bnot\b)[^，,；;。]*$/gi, '')
  ).join(' ');
}
export function mixedStoryboardIssues(script: string, mode: string, materials: MixedMaterialEvidence[]): string[] {
  if (mode !== 'heygen') return [];
  const blocks = script.split(/(?=^\s*\[\s*\d+(?:\.\d+)?\s*[-–—])/m).filter(s => /^\s*\[\s*\d/.test(s));
  const issues: string[] = [];
  let avatars = 0, clips = 0;
  for (const [index, block] of blocks.entries()) {
    const visual = block.match(/^画面[：:]\s*(.*)$/m)?.[1] || '';
    const rawDescription = block.split('\n').filter(line => /^(?:画面|构图|环境)[：:]/.test(line)).join(' ');
    const description = affirmativeVisualDescription(rawDescription);
    const tag = `第${index + 1}镜`;
    if (/建议补拍|需要补拍|待补拍|补拍|重新拍摄|另行拍摄|reshoot|additional filming/i.test(description)) issues.push(`${tag}混剪不能用补拍建议代替现有素材`);
    if (/^数字人[：:]/.test(visual)) {
      avatars++;
      if (/手持|拿起|操作产品|演示产品|展示\s|holding (?:the )?product/i.test(description)) issues.push(`${tag}数字人不能虚构产品操作`);
      continue;
    }
    const match = visual.match(/^素材《([^》]+)》/);
    const material = materials.find(m => Boolean(match?.[1]) && m.name === match?.[1]);
    if (!material) { issues.push(`${tag}缺少明确数字人来源或有效素材绑定`); continue; }
    clips++;
    const range = visual.match(/源片截取[：:]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
    if (!range) issues.push(`${tag}缺少可验证的源片截取区间`);
    else if (!(Number(range[1]) >= 0 && Number(range[2]) > Number(range[1]) && Number(range[2]) <= Number(material.duration || 0))) issues.push(`${tag}源片截取超出素材时长或区间无效`);
    const evidence = affirmativeVisualDescription((material.observations || []).join(' '));
    if (/手部|手指|食指|指尖|伸手|hand|finger/i.test(description) && !/手|hand|finger/i.test(evidence)) issues.push(`${tag}素材观察未证实画面中的手部动作`);
    if (/同一(?:块|个|件|台)|同一物件|same (?:board|product|object)/i.test(description) && !/同一|same/i.test(evidence)) issues.push(`${tag}素材观察未证实跨镜头为同一物件`);
  }
  if (!avatars || !clips) issues.push('数字人混剪必须同时包含数字人镜头和已选素材镜头');
  return [...new Set(issues)];
}
