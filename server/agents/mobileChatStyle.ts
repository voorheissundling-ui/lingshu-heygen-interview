const MARKDOWN_OR_LIST_PATTERN = /(^|\n)\s*(?:#{1,6}\s+|>\s+|[-*+•◦▪▫◆◇]\s+|\d+[.)]\s+|[-*+]\s*\[[ xX]\]\s+)|\*\*[^*]+\*\*|__[^_]+__|```|`[^`]+`/m;
const FORMAL_TRANSLATION_PATTERN = /\b(?:thank you for your inquiry|we would be delighted|please be advised|we are pleased to|kindly (?:provide|note|confirm)|happy to assist|feel free to contact us|at your earliest convenience)\b/i;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MAX_MESSAGES = 3;
const MAX_CJK_CHARS = 30;
const MAX_LATIN_WORDS = 25;

export function normalizeMobileChatFormatting(value: unknown): string {
  const raw = String(value || '')
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '$1: $2');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const plain = lines.map(line => line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^(?:[-*+•◦▪▫◆◇✅☑️✔️✓]\s+)+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim())
    .filter(Boolean)
    .join(' ');
  const naturalized = plain
    .replace(/\bthank you for your inquiry\b/gi, 'Thanks for your message')
    .replace(/\bwe would be delighted to\b/gi, "We'd be glad to")
    .replace(/\bplease be advised(?: that)?\b/gi, 'Just so you know,')
    .replace(/\bkindly (?:provide|send)\b/gi, 'Please send')
    .replace(/\bhappy to assist\b/gi, 'glad to help')
    .replace(/\bfeel free to contact us\b/gi, 'Just message me')
    .replace(/\bat your earliest convenience\b/gi, 'when you can')
    .replace(/\s{2,}/g, ' ')
    .trim();
  let keptEmoji = false;
  return naturalized
    .replace(/\p{Extended_Pictographic}/gu, emoji => {
      if (!keptEmoji && /^(?:👍|😊|👌|🙌|✨|📦)$/.test(emoji)) {
        keptEmoji = true;
        return emoji;
      }
      return '';
    })
    .replace(/\uFE0F/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function messageUnits(value: string): number {
  if (CJK_PATTERN.test(value)) {
    return Array.from(value.replace(/\s/g, '')).length;
  }
  return value.split(/\s+/).filter(Boolean).length;
}

function messageLimit(value: string): number {
  return CJK_PATTERN.test(value) ? MAX_CJK_CHARS : MAX_LATIN_WORDS;
}

function hardSplit(value: string): string[] {
  const limit = messageLimit(value);
  if (messageUnits(value) <= limit) return [value.trim()];
  if (!CJK_PATTERN.test(value)) {
    const words = value.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    for (let index = 0; index < words.length; index += limit) {
      chunks.push(words.slice(index, index + limit).join(' '));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let current = '';
  for (const char of Array.from(value.trim())) {
    if (/^[，。！？；：、,.!?;:]$/u.test(char) && current) {
      current += char;
      continue;
    }
    const candidate = `${current}${char}`;
    if (messageUnits(candidate) > limit && current.trim()) {
      chunks.push(current.trim());
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Turns a model draft into WhatsApp-sized bubbles. This is the final, deterministic
 * guard: at most three bubbles, at most two sentences per bubble, and a compact
 * per-bubble word/character budget. Any overflow is dropped instead of silently
 * sending a wall of text after the third bubble.
 */
export function planMobileChatMessages(value: unknown): { messages: string[]; truncated: boolean } {
  const normalized = normalizeMobileChatFormatting(value);
  if (!normalized) return { messages: [], truncated: false };
  const sentences = normalized.match(/(?:[^.!?。！？؟]|(?<=\d)\.(?=\d))+[.!?。！？؟]?/gu)?.map(item => item.trim()).filter(Boolean) ?? [normalized];
  let keptQuestion = false;
  // 保留原始口语顺序，只去掉第二个及之后的问题。强行把问题移到末尾会让
  // “That helps me check it” 之类的承接句跑到问题前面，听起来像机器拼句。
  const dialogueSentences = sentences.filter(sentence => {
    if (!/[?？？]/.test(sentence)) return true;
    if (keptQuestion) return false;
    keptQuestion = true;
    return true;
  });
  const pieces = dialogueSentences.flatMap(hardSplit);
  const messages: string[] = [];
  let current = '';
  let sentenceCount = 0;

  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (current && (sentenceCount >= 2 || messageUnits(candidate) > messageLimit(candidate))) {
      messages.push(current.trim());
      current = piece;
      sentenceCount = 1;
    } else {
      current = candidate;
      sentenceCount += 1;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return { messages: messages.slice(0, MAX_MESSAGES), truncated: messages.length > MAX_MESSAGES };
}

export function splitMobileChatMessages(value: unknown): string[] {
  return planMobileChatMessages(value).messages;
}

function isDetailedBuyerMessage(message: string): boolean {
  const normalized = message.trim();
  const questions = (normalized.match(/[?？]/g) ?? []).length;
  return normalized.length >= 120
    || questions >= 2
    || /\b(?:detail|specification|material|dimension|certificate|certification|packaging|compare|difference|requirement|shipping|delivery|payment)\b|材质|规格|尺寸|认证|包装|对比|区别|付款|交期/i.test(normalized);
}

export function shouldReshapeMobileChatDraft(draft: string, latestBuyerMessage: string): boolean {
  const value = String(draft || '').trim();
  if (!value) return false;
  if (MARKDOWN_OR_LIST_PATTERN.test(value) || FORMAL_TRANSLATION_PATTERN.test(value)) return true;
  if (planMobileChatMessages(value).truncated) return true;
  const detailed = isDetailedBuyerMessage(latestBuyerMessage);
  if (value.length > 720) return true;
  if (!detailed && value.length > Math.max(280, latestBuyerMessage.trim().length * 5)) return true;
  return false;
}

export function mobileChatRewritePrompt(draft: string, latestBuyerMessage: string, language: string): string {
  return [
    'Rewrite one seller reply so it sounds typed by a real, experienced Yiwu trader on a phone.',
    `Use ${language} throughout. Return one to three plain-text WhatsApp messages separated by a blank line.`,
    'Keep each message brief enough to feel naturally typed on a phone. A quick buyer question needs a quick reply; a serious detail question may need a little more explanation.',
    'Keep every supported business fact and the original intent. Do not add product facts, prices, promises, or capabilities.',
    'Match the length to the buyer: keep a casual message brief; give a serious detail question only the extra explanation it genuinely needs.',
    'Use natural spoken trade language, not an essay, brochure, customer-service template, or polished marketing copy.',
    'Do not use headings, Markdown, bold text, checkboxes, bullets, numbered lists, or decorative symbols. If several points matter, connect them naturally in conversation, such as “one thing is…” and “also…”.',
    'For English, prefer direct everyday trade talk such as “You want to add skincare to your shop?” or “Tell me the quantity you need and I’ll check the best option for you.” Avoid formal translated phrases.',
    `Latest buyer message: ${latestBuyerMessage}`,
    `Draft to rewrite: ${draft}`,
  ].join('\n');
}
