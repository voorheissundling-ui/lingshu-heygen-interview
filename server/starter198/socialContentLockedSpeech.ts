import { socialText } from './socialContentValidation.js';

export function compactLockedSpeech(value: string, ratio: number, language: 'zh' | 'en'): string {
  const clean = socialText(value).replace(/\s+/g, language === 'en' ? ' ' : '');
  if (language === 'en') {
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length <= 2) return clean;
    const maximum = Math.max(2, Math.min(words.length - 1, Math.floor(words.length * ratio)));
    const clauses = clean.split(/(?<=[,;.!?])\s+/).map(item => item.trim()).filter(Boolean);
    const completeClause = clauses
      .map(item => item.replace(/[,;.!?]+$/g, ''))
      .filter(item => item.split(/\s+/).length <= maximum)
      .sort((left, right) => right.split(/\s+/).length - left.split(/\s+/).length)[0];
    return `${(completeClause || words.slice(0, maximum).join(' ')).replace(/[.,;:!?]+$/g, '')}.`;
  }
  const withoutEnding = clean.replace(/[，。；：！？、,.!?:;]+$/g, '');
  const characters = [...withoutEnding];
  if (characters.length <= 3) return clean;
  const maximum = Math.max(3, Math.min(characters.length - 1, Math.floor(characters.length * ratio)));
  const sentence = (text: string) => `${text.replace(/^[，。；：！？、,.!?:;\s]+|[，。；：！？、,.!?:;\s]+$/g, '')}。`;
  const candidates = new Set<string>();
  const addCandidate = (text: string) => {
    const normalized = sentence(text);
    if (normalized !== sentence(withoutEnding) && [...normalized].length > 2) candidates.add(normalized);
  };

  // Keep complete clauses and remove common scaffolding instead of slicing a
  // Chinese sentence in the middle (for example, never produce “的已。”).
  clean.split(/[，；。！？]/).map(item => item.trim()).filter(Boolean).forEach(addCandidate);
  addCandidate(withoutEnding.replace(/^通过客户上传的真实画面[，,]?/, ''));
  addCandidate(withoutEnding.replace(/^企业已确认资料显示[，,]?/, '已确认：'));
  addCandidate(withoutEnding.replace(/^口播[-—：:]?/, ''));
  if (/^想了解.+(?:的已确认信息)?[，,]?可以联系我们$/.test(withoutEnding)) {
    addCandidate('详情请联系我们');
  }
  if (/联系我们/.test(withoutEnding)) addCandidate('详情请联系我们');
  if (/客户上传的真实画面/.test(withoutEnding)) addCandidate('真实画面展示');

  const ranked = [...candidates].sort((left, right) => [...right].length - [...left].length);
  const withinBudget = ranked.find(item => [...item].length <= maximum + 1);
  if (withinBudget) return withinBudget;
  if (ranked.length) return [...ranked].sort((left, right) => [...left].length - [...right].length)[0]!;

  // Last resort for unpunctuated administrator templates: keep a complete
  // labelled phrase. Production copy with natural clauses exits above.
  return `${characters.slice(0, maximum).join('')}。`;
}
