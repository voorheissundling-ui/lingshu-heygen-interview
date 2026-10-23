export interface WeeklyScanCounts {claimed:number;succeeded:number;pending:number;blocked:number;failed:number;projectionFailed?:number}
export interface WeeklyExecutionObservation {
 configuredEnabled:boolean;started:boolean;state:'not_started'|'disabled'|'waiting'|'scanning'|'idle'|'failed';
 workerId:string|null;startedAt:string|null;lastScanStartedAt:string|null;lastScanFinishedAt:string|null;
 lastResult:WeeklyScanCounts|null;lastErrorCode:string|null;
}
/** Local process observations only: no inference from the general worker heartbeat or provider configuration. */
export function createWeeklyExecutionObservation(){
 let state:Omit<WeeklyExecutionObservation,'configuredEnabled'>={started:false,state:'not_started',workerId:null,startedAt:null,lastScanStartedAt:null,lastScanFinishedAt:null,lastResult:null,lastErrorCode:null};
 return {
  initialize(enabled:boolean,workerId:string|null=null,now=new Date()){if(state.started)return;state={...state,started:enabled,state:enabled?'waiting':'disabled',workerId:enabled?workerId:null,startedAt:enabled?now.toISOString():null};},
  read(env:NodeJS.ProcessEnv=process.env):WeeklyExecutionObservation{return {configuredEnabled:env.SOCIAL_WEEKLY_EXECUTION_WORKER_ENABLED==='true',...structuredClone(state)};},
  async scan<T extends WeeklyScanCounts>(run:()=>Promise<T>):Promise<T>{
   if(!state.started||state.state==='scanning')throw Error('weekly_scan_observation_not_started_or_busy');
   state={...state,state:'scanning',lastScanStartedAt:new Date().toISOString(),lastErrorCode:null};
   try{const result=await run();const counts={claimed:result.claimed,succeeded:result.succeeded,pending:result.pending,blocked:result.blocked,failed:result.failed};if(Object.values(counts).some(v=>!Number.isSafeInteger(v)||v<0))throw Error('weekly_scan_observation_result_invalid');state={...state,state:'idle',lastScanFinishedAt:new Date().toISOString(),lastResult:counts};return result;}
   catch(error){const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,100}$/.test(error.code)?error.code:'weekly_execution_scan_failed';state={...state,state:'failed',lastScanFinishedAt:new Date().toISOString(),lastResult:null,lastErrorCode:code};throw error;}
  },
 };
}
export const weeklyExecutionObservation=createWeeklyExecutionObservation();
