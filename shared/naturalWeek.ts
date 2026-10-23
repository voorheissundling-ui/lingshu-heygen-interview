/** Business weeks are Monday–Sunday in the business timezone, never a rolling seven-day window. */
export function businessDate(value:string|Date,timeZone='Asia/Shanghai'):string{
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)){
  const date=new Date(`${value}T12:00:00Z`);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw Error('natural_week_date_invalid');return value;
 }
 const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.getTime()))throw Error('natural_week_date_invalid');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
}
export function naturalWeek(value:string|Date,timeZone='Asia/Shanghai'){
 const date=businessDate(value,timeZone),instant=new Date(`${date}T12:00:00Z`),offset=(instant.getUTCDay()+6)%7;
 instant.setUTCDate(instant.getUTCDate()-offset);const start=instant.toISOString().slice(0,10);
 instant.setUTCDate(instant.getUTCDate()+6);return{start,end:instant.toISOString().slice(0,10),timeZone};
}
