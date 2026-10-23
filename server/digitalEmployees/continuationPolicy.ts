import type { ContinuationPolicy } from '../../shared/contracts/continuationPolicy.js';
import { beijingDate, latestDueReviewSlot, type ReviewCadenceSchedule } from './runtimeSchedule.js';
export function cyclesOverlap(a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }): boolean {
  if (![a.starts_at,a.ends_at,b.starts_at,b.ends_at].every(x=>/^\d{4}-\d{2}-\d{2}$/.test(x))) return true;
  return a.starts_at <= b.ends_at && b.starts_at <= a.ends_at;
}
export function followupDraftDue(input: { schedule: ReviewCadenceSchedule; startedAt: string; startsAt: string; endsAt: string; policy: ContinuationPolicy['missedFollowup']; now?: Date; reopened?: boolean }): boolean {
  const now=input.now || new Date(); const day=beijingDate(now); const started=Date.parse(input.startedAt);
  if (!Number.isFinite(started) || now.getTime()<started || day<input.startsAt || day>input.endsAt) return false;
  if (input.reopened) return true;
  const slot=latestDueReviewSlot(input.schedule,now); const slotDay=beijingDate(slot);
  if(slot.getTime()>=started && slotDay>=input.startsAt && slotDay<=input.endsAt)return true;
  // Catch up only when this cycle actually contained a due slot before launch.
  return input.policy==='catch_up' && slot.getTime()<started && slotDay>=input.startsAt && slotDay<=input.endsAt;
}
export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en',{timeZone:value}).format();return Boolean(value); } catch{return false;}
}
/** Resolve the configured local 20:00 using Intl's zone rules, including DST. */
function zonedEvening(day:string,zone:string):number {
 const [y,m,d]=day.split('-').map(Number); const desired=Date.UTC(y,m-1,d,20); let instant=desired;
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<4;i++){
  const parts=Object.fromEntries(fmt.formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  const actual=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
  const delta=desired-actual;instant+=delta;if(!delta)return instant;
 }
 throw new Error('无法确定账号当地发布时间，请核对时区');
}
export function boundedPublishingSlots(input:{startsAt:string;endsAt:string;timezone:string;count:number;now:Date}):string[]{
 if(!validTimeZone(input.timezone))throw new Error('请为发布账号配置有效的 IANA 时区，例如 America/New_York');
 const begin=Date.parse(input.startsAt+'T00:00:00Z'),end=Date.parse(input.endsAt+'T00:00:00Z');
 if(!Number.isFinite(begin)||!Number.isFinite(end)||end<begin||end-begin>366*86400000)throw new Error('经营周期无效');
 const slots:string[]=[];
 for(let day=begin;day<=end&&slots.length<input.count;day+=86400000){const at=zonedEvening(new Date(day).toISOString().slice(0,10),input.timezone);if(at>input.now.getTime())slots.push(new Date(at).toISOString());}
 if(slots.length<input.count)throw new Error(`经营周期内仅余 ${slots.length} 个发布时间，无法安排 ${input.count} 条视频；请调整周期或视频数量后重新审批`);
 return slots;
}
