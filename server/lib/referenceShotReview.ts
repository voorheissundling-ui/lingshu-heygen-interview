import { createHash } from 'node:crypto';
import { parseAnalysisTimeRange } from './videoAnalysisCodec.js';

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const number = (v: unknown): number => typeof v === 'number' ? v : Number.NaN;
const parse = (v: unknown): Row => { if (typeof v !== 'string') return obj(v); try { return obj(JSON.parse(v)); } catch { return {}; } };
const round = (n: number) => Math.round(n * 100) / 100;

export interface ReviewedSection { sectionId: string; title: string; start: number; end: number; purpose: string; confirmed: boolean; }
export const hookScriptFields = ['camera','visual','subject','music','voiceover','soundEffects','spokenWords','subjectAction'] as const;
export type HookScriptField = typeof hookScriptFields[number];
export type HookScript = Record<HookScriptField, string>;
const emptyHookScript = (): HookScript => Object.fromEntries(hookScriptFields.map(key => [key, ''])) as HookScript;
export interface ReviewedShot { shotId: string; start: number; end: number; content: string; purpose: string; sourceShotIds: string[]; reviewStatus: 'candidate'|'confirmed'|'discarded'; mixedScene: boolean; labels: string[]; evidenceRefs: string[]; hookAction: string; hookMotionConfirmed: boolean; hookScript?: HookScript; hookScriptConfirmed?: boolean; }
export interface ReferenceShotReview { schemaVersion: 1; referenceRecordId: string; sourceAnalysisRunId: string|null; version: string; sections: ReviewedSection[]; shots: ReviewedShot[]; selectedHookShotId: string|null; reviewComplete: boolean; productionExecutionAllowed: false; }
export function reviewShotMaterialFingerprint(record: Row, shot: Pick<ReviewedShot,'shotId'|'start'|'end'>): string {
  const analysis = parse(record.aiAnalysis);
  return hash([str(record.id),str(analysis.analysisRunId),str(analysis.contentSha256),shot.shotId,shot.start,shot.end]);
}
export function reviewShotMaterialRefs(record: Row, shot: Pick<ReviewedShot,'shotId'|'start'|'end'>): [string,string] {
  const key = reviewShotMaterialFingerprint(record,shot);
  const prefix = `/api/overseas/videos/${encodeURIComponent(str(record.id))}/shot-review/${encodeURIComponent(shot.shotId)}`;
  return [`${prefix}/clip?key=${key}`,`${prefix}/first-frame?key=${key}`];
}

const chapterTitles = ['工厂人物提问作开场钩子','卡粉、褪色等痛点画面','灌装与妆效','产品质地和定制展示','生产、检验及合作场景','展厅人物持瓶引导询价'];
const chapterIds = ['hook','pain','fill','texture','trust','cta'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const close = (a: number, b: number) => Math.abs(a-b) <= 0.06;

export function initialReferenceShotReview(record: Row): ReferenceShotReview {
  const analysis = parse(record.aiAnalysis);
  const gemini = parse(analysis.gemini);
  const candidates = arr(gemini.scriptDetails15s).map(obj);
  const shots: ReviewedShot[] = candidates.flatMap((detail, index) => {
    const range = parseAnalysisTimeRange(str(detail.time || detail.timestamp));
    if (!range) return [];
    const material = obj(detail.materialEvidence);
    const hookScript = emptyHookScript();
    if (range.start < 1 && range.end > 0 && range.end - range.start >= .2) {
      hookScript.camera = str(detail.camera);
      hookScript.visual = str(detail.visual);
      hookScript.subject = str(detail.observedFacts);
      hookScript.music = str(detail.bgm);
      hookScript.voiceover = str(detail.voiceover);
      hookScript.soundEffects = arr(detail.soundEffects).map(str).filter(Boolean).join('；');
      hookScript.spokenWords = str(detail.dialogue);
      hookScript.subjectAction = arr(detail.beats).map(obj).map(beat => str(beat.action)).filter(Boolean).join('；');
    }
    return [{shotId:`shot-${index+1}`,start:range.start,end:range.end,content:str(detail.visual),purpose:str(detail.purpose),sourceShotIds:[`shot-${index+1}`],reviewStatus:'candidate' as const,mixedScene:false,labels:[],evidenceRefs:[str(material.clipRef),str(material.firstFrameRef)].filter(Boolean),hookAction:'',hookMotionConfirmed:false,hookScript,hookScriptConfirmed:false}];
  });
  const duration = Number(analysis.durationSeconds || record.durationSeconds || shots.at(-1)?.end || 0);
  const bounds = [0, .06, .19, .36, .58, .88, 1].map(x => round(x * duration));
  const sections = chapterTitles.map((title,i) => ({sectionId:chapterIds[i]!,title,start:bounds[i]!,end:bounds[i+1]!,purpose:'',confirmed:false}));
  const sourceAnalysisRunId = str(analysis.analysisRunId) || null;
  const base = {referenceRecordId:str(record.id),sourceAnalysisRunId,sections,shots,selectedHookShotId:null};
  return {schemaVersion:1,...base,version:hash(base),reviewComplete:false,productionExecutionAllowed:false};
}

export function loadReferenceShotReview(record: Row): ReferenceShotReview {
  const initial = initialReferenceShotReview(record);
  const saved = parse(record.referenceShotReview);
  return saved.sourceAnalysisRunId === initial.sourceAnalysisRunId && saved.referenceRecordId === initial.referenceRecordId
    && Array.isArray(saved.shots) && Array.isArray(saved.sections) ? saved as unknown as ReferenceShotReview : initial;
}

export function updateReferenceShotReview(record: Row, body: Row): ReferenceShotReview {
  const current = loadReferenceShotReview(record);
  if (str(body.expectedVersion) !== current.version) throw new Error('review_version_conflict');
  const sections = arr(body.sections).map(obj).map(s => ({sectionId:str(s.sectionId),title:str(s.title),start:number(s.start),end:number(s.end),purpose:str(s.purpose),confirmed:s.confirmed===true}));
  const shots = arr(body.shots).map(obj).map(s => ({shotId:str(s.shotId),start:number(s.start),end:number(s.end),content:str(s.content),purpose:str(s.purpose),sourceShotIds:arr(s.sourceShotIds).map(str),reviewStatus:str(s.reviewStatus),mixedScene:s.mixedScene===true,labels:arr(s.labels).map(str).filter(Boolean),evidenceRefs:[] as string[],hookAction:str(s.hookAction),hookMotionConfirmed:s.hookMotionConfirmed===true,hookScript:Object.fromEntries(hookScriptFields.map(key => [key,str(obj(s.hookScript)[key])])) as HookScript,hookScriptConfirmed:s.hookScriptConfirmed===true}));
  const source = new Map(current.shots.flatMap(s => s.sourceShotIds.map(id => [id,s] as const)));
  if (sections.length !== 6 || sections.some((s,i) => s.sectionId !== chapterIds[i] || !s.title || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end-s.start < .5 || (i && !close(sections[i-1]!.end,s.start)))) throw new Error('invalid_six_sections');
  const duration = current.shots.at(-1)?.end ?? sections.at(-1)!.end;
  if (!close(sections[0]!.start,0) || !close(sections.at(-1)!.end,duration)) throw new Error('sections_must_cover_video');
  if (!shots.length || shots.length > 200 || new Set(shots.map(s => s.shotId)).size !== shots.length) throw new Error('invalid_review_shots');
  const sorted = [...shots].sort((a,b) => a.start-b.start);
  if (sorted.some((s,i) => !s.shotId || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end-s.start < (s.reviewStatus === 'confirmed' ? .15 : .01) || !['candidate','confirmed','discarded'].includes(s.reviewStatus) || !s.sourceShotIds.length || s.sourceShotIds.some(id => !source.has(id)) || s.labels.length > 12 || s.content.length > 2000 || s.purpose.length > 1000 || s.hookAction.length > 2000 || (s.hookMotionConfirmed && s.hookAction.length < 20) || hookScriptFields.some(key => s.hookScript[key].length > 2000) || (s.hookScriptConfirmed && hookScriptFields.some(key => !s.hookScript[key])) || (i && s.start < sorted[i-1]!.end-.06))) throw new Error('invalid_review_shot_range');
  const retained = sorted.filter(s => s.reviewStatus !== 'discarded');
  if (!retained.length || !close(sorted[0]!.start,0) || !close(sorted.at(-1)!.end,duration) || sorted.some((s,i) => i && !close(sorted[i-1]!.end,s.start))) throw new Error('shots_must_cover_video');
  for (const shot of sorted) {
    const previous = current.shots.find(item => item.shotId === shot.shotId && close(item.start,shot.start) && close(item.end,shot.end));
    shot.evidenceRefs = previous?.evidenceRefs ?? [];
  }
  const selectedHookShotId = str(body.selectedHookShotId) || null;
  if (selectedHookShotId && !retained.some(s => s.shotId === selectedHookShotId && s.start < 1 && s.end > 0 && s.end-s.start >= .2)) throw new Error('invalid_hook_shot');
  const selectedHook = retained.find(s => s.shotId === selectedHookShotId);
  const reviewComplete = sections.every(s => s.confirmed) && retained.every(s => s.reviewStatus === 'confirmed' && s.content && s.purpose && s.labels.length && !s.mixedScene) && Boolean(selectedHook?.hookScriptConfirmed && selectedHook.hookMotionConfirmed);
  const next = {schemaVersion:1 as const,referenceRecordId:current.referenceRecordId,sourceAnalysisRunId:current.sourceAnalysisRunId,sections,shots:sorted as ReviewedShot[],selectedHookShotId,reviewComplete,productionExecutionAllowed:false as const};
  return {...next,version:hash(next)};
}

export function attachReviewShotMaterials(record: Row, shotId: string, expectedVersion: string): ReferenceShotReview {
  const current = loadReferenceShotReview(record);
  if (current.version !== expectedVersion) throw new Error('review_version_conflict');
  const shot = current.shots.find(s => s.shotId === shotId && s.reviewStatus !== 'discarded');
  if (!shot) throw new Error('review_shot_not_found');
  const shots = current.shots.map(s => s.shotId === shotId ? {...s,evidenceRefs:reviewShotMaterialRefs(record,s)} : s);
  const next = {...current,shots,productionExecutionAllowed:false as const};
  return {...next,version:hash(next)};
}
