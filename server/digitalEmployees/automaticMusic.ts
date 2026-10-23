import { randomInt } from 'node:crypto';
export type MusicCandidate = { id: string; name: string; mood: string };
/** Model ranks suitability; randomness stays within its validated shortlist. */
export function chooseMusic(raw: string, catalog: MusicCandidate[], recent: string[] = [], pick = randomInt) {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  const ids: string[] = Array.isArray(parsed.ids) ? [...new Set<string>(parsed.ids.filter((id: unknown): id is string => typeof id === 'string'))] : [];
  const suitable = ids.map(id => catalog.find(track => track.id === id)).filter((track): track is MusicCandidate => Boolean(track));
  if (!suitable.length) throw Error('AI 未返回可用配乐，请重试或在生产现场选择');
  const fresh = suitable.filter(track => !recent.includes(track.id));
  const pool = fresh.length ? fresh : suitable;
  return { track: pool[pick(pool.length)], reason: String(parsed.reason || '根据内容情绪匹配').slice(0, 240), candidates: suitable.map(track => track.id) };
}
