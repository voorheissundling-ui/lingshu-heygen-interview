import type { VideoAiAnalysis } from '../types/index.js';
import { cleanupAnalysisTitle } from './videoCrawlerProviderProjection.js';
import { PLATFORM_LABEL, type CrawledVideo } from './videoCrawlerNormalization.js';

/** A source-metadata-only planning hint, never a claim of observed video evidence. */
export function metadataFallbackAnalysis(input: Pick<CrawledVideo, 'platform' | 'title' | 'views' | 'tags'> & { duration?: number }): VideoAiAnalysis {
  const tags = input.tags.filter(Boolean).slice(0, 5);
  const title = cleanupAnalysisTitle(input.title);
  const platform = PLATFORM_LABEL[input.platform] || input.platform;
  const topic = tags.length > 0 ? tags.slice(0, 3).join(' / ') : title;
  const durationHint = input.duration && input.duration > 90 ? '长视频评测/教程' : '短视频种草';
  return {
    theme: `${platform} ${durationHint}：${title}`,
    hooks: [
      `用标题承诺切入：${title}`,
      input.views ? `用热度做社会证明：${input.views}` : '先展示结果或冲突，再解释产品',
      tags.length ? `前三秒围绕「${tags[0]}」放大场景痛点` : '前三秒突出产品效果或前后反差',
    ],
    sellingPoints: tags.length
      ? tags.map(tag => `可围绕「${tag}」展开卖点或场景`)
      : ['产品演示', '痛点解决', '结果证明', '行动引导'],
    mood: input.platform === 'tiktok' || input.platform === 'instagram' ? '快节奏 / 社媒感 / 视觉种草' : '信息型 / 评测型 / 解释清晰',
    structure: `标题/封面钩子 → 场景痛点 → 核心展示（${topic}） → 证明细节 → CTA`,
    baseRequirements: `基础要求：情绪氛围围绕「${title}」制造好奇、信任和种草；光影应清晰突出人物与产品；全片主要场景围绕产品实拍、使用演示、结果对比和行动引导；质感强调真实口播、产品近景、包装/材质/效果细节；创作上需要强反转开头、真人口播、卡点剪辑、特效拉满，并把产品质感拍清楚。`,
    firstTenSeconds: {
      atmosphere: `前 10 秒大概率用「${title}」建立观看预期，并借助 ${platform} 平台语境形成信任或好奇。`,
      audioVisual: `字幕/标题应快速解释「${topic}」，画面需要同步出现产品、结果或痛点。`,
      camera: '建议先按近景展示、快速切换、结果对比三类镜头理解；视频级分析完成后会回填真实运镜细节。',
      visuals: tags.length ? `画面核心应围绕「${tags.slice(0, 3).join(' / ')}」展开。` : '画面核心应优先呈现产品、使用场景和前后反差。',
      voiceMusic: `配音/配乐应匹配「${input.platform === 'tiktok' || input.platform === 'instagram' ? '快节奏种草' : '评测解释'}」节奏。`,
    },
    coarseStructure: [
      { time: '0-3s', label: '标题承诺', description: `用标题或封面信息承接：${title}` },
      { time: '3-6s', label: '场景痛点', description: tags[0] ? `放大「${tags[0]}」相关使用场景或问题` : '展示用户痛点或结果反差' },
      { time: '6-9s', label: '核心展示', description: `进入核心展示：${topic}` },
      { time: '9-12s', label: '证明细节', description: input.views ? `用热度/评论/使用结果强化可信度：${input.views}` : '补充使用细节或效果证明' },
      { time: '12-15s', label: '行动引导', description: '给出购买、收藏、询盘或继续观看理由' },
    ],
    scriptSummary15s: {
      visualStyle: input.platform === 'youtube' ? '真人写实评测风格' : '真人社媒写实风格',
      coreEmotion: input.platform === 'tiktok' || input.platform === 'instagram' ? '快速种草、好奇、轻松' : '信任、解释、种草',
      competitors: [],
    },
    scriptDetails15s: [
      {
        time: '0.2s',
        environment: '产品实拍或人物口播场景',
        shot: '特写',
        camera: '固定镜头',
        visual: `用标题或封面信息承接「${title}」，优先出现人物、产品或结果画面。`,
        subtitle: `围绕「${title}」建立观看理由。`,
        audio: '配音/BGM 待真实视频分析回填。',
      },
      {
        time: '3.2s',
        environment: '使用场景或痛点展示场景',
        shot: '中近景',
        camera: '轻微推近',
        visual: tags[0] ? `放大「${tags[0]}」相关场景或痛点。` : '展示用户痛点或使用前后反差。',
        subtitle: '用一句口播解释为什么继续看。',
        audio: '轻节奏 BGM 或解释型配音。',
      },
      {
        time: '6.2s-9.2s',
        environment: '核心产品展示场景',
        shot: '近景',
        camera: '固定或手持跟拍',
        visual: `进入核心展示「${topic}」，突出产品、动作或效果。`,
        subtitle: '说明核心卖点/使用结果。',
        audio: '音效配合产品展示或字幕节奏。',
      },
      {
        time: '9.2s-12.2s',
        environment: '证明细节或反馈展示场景',
        shot: '中景',
        camera: '慢切或平移',
        visual: input.views ? `用热度、评论或结果画面强化可信度：${input.views}。` : '补充细节证明和真实使用反馈。',
        subtitle: '补强可信度和适用人群。',
        audio: '配音继续解释，BGM 不抢信息。',
      },
      {
        time: '12.2s-15.0s',
        environment: '产品收束或人物 CTA 场景',
        shot: '中近景',
        camera: '收束镜头',
        visual: '以结果、产品正面或人物反应收束，引导收藏/询盘/继续观看。',
        subtitle: '给出行动引导。',
        audio: 'BGM 进入收束节拍。',
      },
    ],
    recommendedScriptType: input.duration && input.duration > 60 ? 'storyboard' : 'voiceover',
  };
}
