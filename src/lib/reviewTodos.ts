import type { ReviewInsight } from './reviewInsights';
export type ReviewTodoKind = 'video' | 'knowledge' | 'followup' | 'strategy' | 'operation';
export interface ReviewTodo {
  id: string; sourceIds: string[]; sourceTitle: string; title: string; kind: ReviewTodoKind;
  requirements: string; acceptance: string; materials: string; reference: string;
  quantity: number; videoIndexes: number[];
  status: 'pending' | 'needs_input' | 'assigned'; reason: string; assignedGoalId?: string;
}
export interface ReviewTodoBoard {
  id: string; revision: number; sourceGoalId: string; week: string; targetGoalId: string;
  recentWeeks?: Array<{ week: string; pending: number }>;
  authorizedBy?: string;
  autoAssign: boolean; scheduledAt: string; items: ReviewTodo[]; lastError: string;
}
export const todoKindLabels: Record<ReviewTodoKind, string> = { video: '视频分镜要求', knowledge: '知识补充审核', followup: '客户跟进准备', strategy: '策略验证', operation: '经营执行要求' };
export function nextReviewWeek(now = new Date()): string {
  const local = new Date(now.getTime() + 8 * 3600000);
  local.setUTCDate(local.getUTCDate() + (8 - (local.getUTCDay() || 7)));
  return local.toISOString().slice(0, 10);
}
export function reviewTodoDraft(insight: ReviewInsight): ReviewTodo {
  return { id: crypto.randomUUID(), sourceIds: [insight.id], sourceTitle: insight.title,
    title: insight.title, kind: insight.category === 'content' ? 'video' : insight.category === 'knowledge' ? 'knowledge' : insight.category === 'opportunity' ? 'followup' : insight.category === 'strategy' ? 'strategy' : 'operation',
    requirements: insight.suggestion, acceptance: '', materials: '', reference: insight.evidence.map(e => `${e.label}：${e.value}`).join('\n'), quantity: 1, videoIndexes: [], status: 'pending', reason: '' };
}
export function todoIssues(item: ReviewTodo): string[] {
  return [!item.title.trim() && '请填写待办标题', !item.requirements.trim() && '请填写具体执行要求', !item.acceptance.trim() && '请填写验收条件', item.kind === 'video' && (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 30) && '视频数量须为 1–30 条', item.kind === 'video' && !item.reference.trim() && '请填写钩子的参考片段或结构', item.kind === 'video' && !item.materials.trim() && '请填写首镜素材要求'].filter(Boolean) as string[];
}

const clean = (v: unknown, max = 4000) => String(v || '').trim().slice(0, max);
export function normalizeTodo(raw: ReviewTodo, previous?: ReviewTodo): ReviewTodo {
  if (previous?.status === 'assigned') return previous;
  if (raw.videoIndexes?.some(n => !Number.isInteger(n) || n < 0 || n >= 30)) throw Error('视频序号须为1–30之间的整数');
  if (!['video', 'knowledge', 'followup', 'strategy', 'operation'].includes(raw.kind)) throw Error('待办类型无效');
  return { id: clean(raw.id, 80) || crypto.randomUUID(), sourceIds: [...new Set((raw.sourceIds || []).map(s => clean(s, 160)))].slice(0, 30), sourceTitle: clean(raw.sourceTitle, 500), title: clean(raw.title, 180), kind: raw.kind,
    requirements: clean(raw.requirements), acceptance: clean(raw.acceptance), materials: clean(raw.materials), reference: clean(raw.reference), quantity: Number(raw.quantity), videoIndexes: [...new Set((raw.videoIndexes || []).map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < 30), status: 'pending', reason: '' };
}
