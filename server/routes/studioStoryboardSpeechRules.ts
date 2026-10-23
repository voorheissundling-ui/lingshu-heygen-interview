export function storyboardSpeechIssues(script: string): string[] {
  const issues: string[] = [];
  const blocks = String(script || '').split(/(?=\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\])/i);
  for (const block of blocks) {
    const range = block.match(/\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/i);
    const voice = block.match(/(?:人物说|台词|Voiceover|VO|口播)\s*[：:]\s*[“"]?([^\n”"]+)/i)?.[1]?.trim();
    if (!range || !voice) continue;
    const duration = Math.max(0, Number(range[2]) - Number(range[1]));
    if (!duration) {
      issues.push(`${range[0]} 时间段无效`);
      continue;
    }
    const cjkChars = Array.from(voice).filter(char => /[\u3400-\u9fff]/.test(char)).length;
    const latinWords = voice.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length || 0;
    const estimated = cjkChars > 0
      ? cjkChars / 4.5 + latinWords / 2.5 + 0.6
      : latinWords / 2.5 + 0.5;
    if (estimated > duration + 0.35) {
      issues.push(`${range[0]} 口播预计${estimated.toFixed(1)}秒，超过镜头${duration.toFixed(1)}秒`);
    }
  }
  return issues;
}

export function fitSpeechToShot(value: string, duration: number): string {
  const text = String(value || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text === '无') return '无';
  const hasCjk = /[\u3400-\u9fff]/.test(text);
  if (!hasCjk) {
    const maxWords = Math.max(1, Math.floor(Math.max(0.5, duration - 0.15) * 2.5));
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    const complete = words.slice(0, maxWords).join(' ').match(/^(.+[.!?])(?:\s|$)/)?.[1]?.trim();
    if (complete) return complete;
    const estimated = words.length / 2.5 + 0.5;
    if (estimated <= duration + 1.5) {
      const terminal = /[.!?]$/.test(text) ? text.slice(-1) : '';
      const candidates = [
        text.replace(/[.!?]$/, '').replace(/^(?:brand (?:founder|owner)|product manager|procurement|buyer|importer|distributor)[,:]\s*/i, '').replace(/\b(?:really|clearly|simply|carefully|directly|actually|currently|now|first|just|please)\b[,.]?\s*/gi, ''),
        text.replace(/[.!?]$/, '').replace(/^(?:brand (?:founder|owner)|product manager|procurement|buyer|importer|distributor)[,:]\s*/i, ''),
        text.replace(/[.!?]$/, '').replace(/\b(?:really|clearly|simply|carefully|directly|actually|currently|now|first|just|please)\b[,.]?\s*/gi, ''),
        text.replace(/[.!?]$/, '').replace(/\bhow can you\b/gi, 'how do you').replace(/\bdo you want to\b/gi, 'want to'),
      ].map(candidate => candidate.replace(/\s+/g, ' ').replace(/^[,:]\s*|\s*[,:]$/g, '').trim());
      for (const candidate of candidates) {
        if (candidate && candidate.split(/\s+/).length <= maxWords) return `${candidate}${terminal || (/^(?:how|why|which|what|can|do|is|are|should|would)\b/i.test(candidate) ? '?' : '.')}`;
      }
    }
    return text;
  }
  const maxChars = Math.max(2, Math.floor(Math.max(0.5, duration - 0.6) * 4));
  const chars = Array.from(text);
  const spokenCharCount = (candidate: string) => Array.from(candidate).filter(char => !/[\s，。！？、；：,.!?;:“”"'（）()]/.test(char)).length;
  const originalChars = spokenCharCount(text);
  if (originalChars <= maxChars) return text;
  let count = 0;
  let result = '';
  let lastComplete = '';
  for (const char of chars) {
    if (!/[\s，。！？、；：,.!?;:“”"'（）()]/.test(char)) count += 1;
    if (count > maxChars) break;
    result += char;
    if (/[。！？!?]/.test(char)) lastComplete = result.trim();
  }
  if (lastComplete) return lastComplete;

  // A small timing miss should not reject the whole material storyboard. For
  // a single Chinese sentence, remove only discourse fillers and redundant
  // modifiers, then keep the original terminal punctuation. This is semantic
  // compaction rather than character slicing, so it cannot create a fragment.
  const estimated = originalChars / 4.5 + 0.6;
  if (estimated <= duration + 1.5) {
    const terminal = /[。！？!?]$/.test(text) ? text.slice(-1) : '';
    let compact = text.replace(/[。！？!?]$/, '')
      .replace(/^(?:各位)?(?:品牌方|品牌创始人|产品经理|采购|买家)[，,：:]\s*/, '')
      .replace(/你是否正在/g, '是否')
      .replace(/我们(?:先|来)?(?:一起)?看看/g, '看看')
      .replace(/是否能够/g, '能否')
      .replace(/如何才能/g, '如何')
      .replace(/(?:到底|真正|具体|现在|首先|其实|本次|当前|这款)/g, '')
      .replace(/可以帮助/g, '能')
      .replace(/[，,]{2,}/g, '，')
      .replace(/^[，,：:]|[，,：:]$/g, '')
      .trim();
    if (compact && spokenCharCount(compact) <= maxChars) return `${compact}${terminal || (/^(?:怎么|如何|是否|能否|哪|什么|为什么)/.test(compact) ? '？' : '。')}`;
  }
  return text;
}

export function ctaSemanticallySatisfied(candidate: string, primaryCta: string): boolean {
  if (!primaryCta || candidate.includes(primaryCta)) return true;
  const requestedNamedChannel = /messenger|whatsapp|\bwa\b/i.test(primaryCta);
  const usedNamedChannel = /messenger|whatsapp|\bwa\b/i.test(candidate);
  // A named channel is part of the enterprise's single CTA. Generic contact
  // wording may not silently replace it, or introduce it when unverified.
  if (requestedNamedChannel !== usedNamedChannel) return false;
  if (requestedNamedChannel) return /message|contact|联系|触达|咨询/i.test(candidate);
  const intentPatterns: Array<[RegExp, RegExp]> = [
    [/发送|提交|发来|分享|\bsend\b|\bshare\b|\bsubmit\b/i, /发送|提交|发来|分享|\bsend\b|\bshare\b|\bsubmit\b/i],
    [/工件|节拍|缺陷|样本|布局|参数|需求|workpiece|cycle|defect|sample|layout|specification|requirement/i, /工件|节拍|缺陷|样本|布局|参数|需求|workpiece|cycle|defect|sample|layout|specification|requirement/i],
    [/预约|安排|\bbook\b|\bschedule\b/i, /预约|安排|\bbook\b|\bschedule\b/i],
    [/诊断|评估|方案|咨询|diagnos|assessment|consult|solution/i, /诊断|评估|方案|咨询|diagnos|assessment|consult|solution/i],
    [/目录|资料|catalog|verified details|product details/i, /目录|资料|catalog|verified details|product details/i],
    [/报价|价格|quote|pricing/i, /报价|价格|quote|pricing/i],
    [/私信|联系|message|\bdm\b|contact/i, /私信|联系|message|\bdm\b|contact/i],
  ];
  const required = intentPatterns.filter(([primary]) => primary.test(primaryCta));
  if (!required.length) return false;
  const matched = required.filter(([, output]) => output.test(candidate)).length;
  return matched >= Math.min(2, required.length);
}

export function safeStoryboardCta(primaryCta: string, language: string): string {
  const cta = String(primaryCta || '').trim();
  if (/messenger/i.test(cta)) return language === 'zh' ? '请通过 Messenger 联系。' : 'Message us on Messenger.';
  if (/whatsapp/i.test(cta)) return language === 'zh' ? '请用WhatsApp联系。' : 'Message us on WhatsApp.';
  if (language === 'zh') {
    if (/(?:发送|提交|发来|分享)/.test(cta) && /预约/.test(cta) && /(?:诊断|评估|方案|咨询)/.test(cta)) {
      const detail = /工件/.test(cta) && /节拍/.test(cta) ? '工件和节拍' : /缺陷/.test(cta) ? '缺陷样本' : '关键参数';
      return `发${detail}，预约方案诊断。`;
    }
    if (/预约/.test(cta) && /(?:诊断|评估|方案|咨询)/.test(cta)) return '预约一次方案诊断。';
    if (/(?:发送|提交|发来|分享)/.test(cta) && /工件|节拍|缺陷|样本|布局|参数|需求/.test(cta)) return '发送关键资料，获取方案建议。';
    if (/报价|价格/.test(cta)) return '发送需求，获取报价。';
    if (/目录|资料/.test(cta)) return '联系获取已核实资料。';
    return cta || '请联系我们了解已核实资料。';
  }
  if (/(?:send|share|submit)/i.test(cta) && /(?:book|schedule)/i.test(cta) && /(?:diagnos|assessment|consult|solution)/i.test(cta)) {
    return 'Share key details and book a solution review.';
  }
  if (/(?:book|schedule)/i.test(cta) && /(?:diagnos|assessment|consult|solution)/i.test(cta)) return 'Book a solution review.';
  if (/quote|pricing/i.test(cta)) return 'Share your needs for a quote.';
  if (/catalog|product details/i.test(cta)) return 'Message us for verified product details.';
  return cta || 'Message us for verified details.';
}

export function shortStoryboardCta(primaryCta: string, language: string): string {
  const cta = String(primaryCta || '');
  if (/messenger/i.test(cta)) return language === 'zh' ? 'Messenger 联系。' : 'Message us on Messenger.';
  if (/whatsapp/i.test(cta)) return language === 'zh' ? 'WhatsApp联系。' : 'Message us on WhatsApp.';
  if (language === 'zh') {
    if (/预约/.test(cta) && /(?:诊断|评估|方案|咨询)/.test(cta)) return '预约方案诊断。';
    if (/报价|价格/.test(cta)) return '发送需求报价。';
    if (/目录|资料/.test(cta)) return '联系获取资料。';
    return '联系了解详情。';
  }
  if (/(?:book|schedule)/i.test(cta) && /(?:diagnos|assessment|consult|solution)/i.test(cta)) return 'Book a solution review.';
  if (/quote|pricing/i.test(cta)) return 'Send needs for a quote.';
  return 'Message us for details.';
}

/** Keep an otherwise valid strategy script renderable even after a rewrite pass. */
export function fitStoryboardSpeech(script: string): string {
  return String(script || '').replace(
    /(\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\][\s\S]*?)(人物说|台词|Voiceover|VO|口播)(\s*[：:]\s*[“"]?)([^\n”"]+)([”"]?)/gi,
    (_full, prefix, start, end, label, separator, voice, quote) => `${prefix}${label}${separator}${fitSpeechToShot(voice, Math.max(0.5, Number(end) - Number(start)))}${quote}`,
  );
}

export function syncStoryboardSubtitles(script: string): string {
  return String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m).map(block => {
    if (!/^\s*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\]/.test(block)) return block;
    const voice = block.match(/^台词[：:]\s*(.+)$/m)?.[1]?.trim() || '';
    if (!voice || /^(无|none)$/i.test(voice)) return block;
    if (/^字幕[：:]/m.test(block)) return block.replace(/^字幕[：:].*$/m, `字幕：${voice}`);
    return block.replace(/^(台词[：:].*)$/m, `$1\n字幕：${voice}`);
  }).join('');
}

export function normalizeStoryboardFieldLines(script: string): string {
  const labels = '素材|环境|景别|运镜|构图|镜头功能|画面|配乐|台词|字幕';
  return String(script || '')
    .replace(/^[ \t]*(?:[-*•][ \t]+|\d+[.)][ \t]+)?(?=\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/gm, '')
    .replace(/(\[[^\]\r\n]+\])[ \t]+(?=(?:素材|环境|景别|运镜|构图|镜头功能|画面|配乐|台词|字幕)[：:])/g, '$1\n')
    .replace(new RegExp(`[ \\t]+(?=(?:${labels})[：:])`, 'g'), '\n')
    .trim();
}

export function dedupeStoryboardFieldLines(script: string): string {
  const fields = new Set(['素材', '环境', '景别', '运镜', '构图', '镜头功能', '画面', '配乐', '台词', '字幕']);
  return String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m).map(block => {
    if (!/^\s*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]/.test(block)) return block;
    const seen = new Set<string>();
    return block.split('\n').filter(line => {
      const field = line.match(/^\s*([^：:\n]+)[：:]/)?.[1]?.trim() || '';
      if (!fields.has(field)) return true;
      if (seen.has(field)) return false;
      seen.add(field);
      return true;
    }).join('\n');
  }).join('');
}

export function restoreProductStoryboardBoundaries(script: string): string {
  const scenes: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.some(line => /^(?:环境|景别|运镜|构图|镜头功能|画面|配乐|台词|字幕)[：:]/.test(line))) scenes.push(current);
    current = [];
  };
  for (const rawLine of normalizeStoryboardFieldLines(script).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\[[^\]]+\]$/.test(line)) {
      flush();
      continue;
    }
    if (/^环境[：:]/.test(line) && current.some(item => /^环境[：:]/.test(item))) flush();
    current.push(line);
  }
  flush();
  if (scenes.length < 2) return normalizeStoryboardFieldLines(script);
  let cursor = 0;
  return scenes.map(lines => {
    const voice = lines.find(line => /^台词[：:]/.test(line))?.replace(/^台词[：:]\s*/, '').trim() || '';
    const cjk = Array.from(voice.replace(/[\s，。！？、；：,.!?;:“”"'（）()]/g, '')).length;
    const words = voice.split(/\s+/).filter(Boolean).length;
    const spoken = /[\u3400-\u9fff]/.test(voice) ? cjk / 4.5 + 0.6 : words / 2.5 + 0.5;
    const duration = Math.max(2.4, +(spoken + 0.35).toFixed(1));
    const end = +(cursor + duration).toFixed(1);
    const output = `[${cursor}-${end}s]\n${lines.join('\n')}`;
    cursor = end;
    return output;
  }).join('\n');
}

export function duplicateStoryboardFieldIssues(script: string): string[] {
  const required = ['素材', '环境', '景别', '运镜', '构图', '镜头功能', '画面', '配乐', '台词', '字幕'];
  return String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m).flatMap(block => {
    if (!/^\s*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?/.test(block)) return [];
    const range = block.match(/^\s*(\[[^\]]+\])/)?.[1] || '分镜';
    return required.flatMap(field => {
      const count = (block.match(new RegExp(`^${field}[：:]`, 'gm')) || []).length;
      return count > 1 ? [`${range} 重复输出“${field}”字段`] : [];
    });
  });
}

export function subtitleVoiceMismatchIssues(script: string, allowedFinalCtaCaption = ''): string[] {
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  const lastSceneIndex = blocks.map((block, index) => /^\s*\[\s*\d/.test(block) ? index : -1).filter(index => index >= 0).pop();
  return blocks.flatMap((block, index) => {
    if (!/^\s*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?/.test(block)) return [];
    const range = block.match(/^\s*(\[[^\]]+\])/)?.[1] || '分镜';
    const voice = block.match(/^台词[：:]\s*(.+)$/m)?.[1]?.trim() || '';
    const caption = block.match(/^字幕[：:]\s*(.+)$/m)?.[1]?.trim() || '';
    if (!voice || /^(无|none)$/i.test(voice)) return [];
    if (allowedFinalCtaCaption && index === lastSceneIndex && caption.includes(allowedFinalCtaCaption)) return [];
    const normalize = (value: string) => value.replace(/[\s，。！？、；：,.!?;:“”"'（）()—–-]/g, '').toLowerCase();
    return normalize(voice) === normalize(caption) ? [] : [`${range} 字幕必须逐字反映口播`];
  });
}

export function applyLockedVoicePlan(script: string, lines: string[]): string {
  if (!lines.length) return script;
  let cursor = 0;
  return String(script || '').split(/(?=^\[[^\]\r\n]+\][ \t]*$)/m).map(block => {
    if (!/^\[[^\]]+\]/.test(block.trim()) || cursor >= lines.length) return block;
    const line = lines[cursor++]!;
    let next = block.replace(/^台词[：:].*$/m, `台词：${line}`);
    const parts = next.split('\n');
    const captionIndex = parts.findIndex(item => /^字幕[：:]/.test(item));
    if (captionIndex >= 0) {
      let endIndex = captionIndex + 1;
      while (endIndex < parts.length && !/^(环境|景别|运镜|构图|镜头功能|画面|配乐|台词|素材)[：:]|^\[/.test(parts[endIndex]!)) endIndex += 1;
      parts.splice(captionIndex, endIndex - captionIndex, `字幕：${line}`);
      next = parts.join('\n');
    }
    return next;
  }).join('');
}
