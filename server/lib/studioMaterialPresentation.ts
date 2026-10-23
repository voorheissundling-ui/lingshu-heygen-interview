interface MaterialInfo {
  name?: string;
  type?: string;
  folder?: string;
  role?: string;
}

export interface MaterialStoryboardScene {
  environment: string;
  shot: string;
  camera: string;
  composition: string;
  purpose: string;
  visual: string;
  music: string;
}

export function materialRoleFromFolder(info: MaterialInfo): string {
  if (info.role) return info.role;
  if (info.folder === 'presenter') return '真人口播素材';
  if (info.folder === 'detail') return '产品细节素材';
  if (info.folder === 'factory') return '工厂/实力素材';
  if (info.folder === 'scene') return '场景使用素材';
  if (info.folder === 'model') return '模特/效果素材';
  if (info.type === 'image') return '静态产品图';
  return '产品展示素材';
}

export function safeMaterialVoicePlan(infos: MaterialInfo[], cta: string, language: string, audience = ''): string[] {
  const selected = infos.slice(0, 5);
  const english = /english|英语|^en\b/i.test(language);
  const firstBuyer = audience.split(/[、,，/]/).map(item => item.trim()).find(Boolean) || (english ? 'Factory manager' : '工厂负责人');
  const lines = selected.map((info, index) => {
    const name = String(info.name || `素材 ${index + 1}`).trim();
    if (index === 0) return english
      ? `${firstBuyer}, which production risk should you verify first?`
      : `${firstBuyer}，哪个生产风险最该先判断？`;
    return english ? `Review ${name}.` : `查看素材：${name}。`;
  });
  if (!lines.length) return [];
  lines[lines.length - 1] = cta.trim() || (english ? 'Message us for verified product details.' : '私信获取已核实的产品资料。');
  return lines;
}

export function safeMaterialScenes(infos: MaterialInfo[]): MaterialStoryboardScene[] {
  return infos.slice(0, 5).map((info, index) => {
    const name = String(info.name || `素材 ${index + 1}`).trim();
    const role = materialRoleFromFolder(info);
    return {
      environment: '按素材实际可见环境',
      shot: info.type === 'image' ? '静态画面' : '按素材原镜头',
      camera: info.type === 'image' ? '固定' : '沿用素材原运镜',
      composition: '保留素材主体，不补写不可见细节',
      purpose: index === 0 ? '主题钩子' : index === Math.min(4, infos.length - 1) ? 'CTA' : role,
      visual: `使用素材《${name}》，仅展示素材中实际可见内容`,
      music: '轻量中性节奏',
    };
  });
}
