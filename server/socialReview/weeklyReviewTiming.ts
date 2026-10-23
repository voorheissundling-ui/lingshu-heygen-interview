/** Product reporting window in the operating timezone (Asia/Shanghai). */
export function weeklyReviewWindowBounds(week:{weekStart:string;weekEnd:string}):{startsAt:string;endsAt:string} {
 const parse=(day:string,suffix:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('weekly_review_window_invalid');
  const date=new Date(`${day}${suffix}`);
  if(!Number.isFinite(date.getTime()))throw Error('weekly_review_window_invalid');
  return date;
 };
 const startsAt=parse(week.weekStart,'T00:00:00+08:00'),end=parse(week.weekEnd,'T20:00:00+08:00');
 if(end.getTime()<startsAt.getTime())throw Error('weekly_review_window_invalid');
 return {startsAt:startsAt.toISOString(),endsAt:end.toISOString()};
}
