import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
export type InitialPreparationSource={key:string;platform:'youtube'|'tiktok'|'instagram'|'facebook'|'linkedin';mode:'keyword'|'account';value:string;origin:'external'|'owned';jobId?:string};
export type InitialPreparation={requestId:string;goalId:string;revision:number;confirmedBy:string;confirmedAt:string;status:'collecting'|'analyzing'|'preparing'|'running'|'blocked';sources:InitialPreparationSource[];candidateIds:string[];reason:string;runId?:string};
type PersistedInitialPreparationScope={goalPlatforms:unknown;businessPackage:unknown;config:unknown;profile:unknown};

function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function list(value:unknown):unknown[]{return Array.isArray(value)?value:[];}
function strings(value:unknown):string[]{return list(value).map(String).map(item=>item.trim()).filter(Boolean);}
function productNames(value:unknown):string[]{return typeof value==='string'?value.split(/[\n,，;；、]/).map(item=>item.trim()).filter(Boolean):[];}
function platforms(value:unknown):InitialPreparationSource['platform'][]{
 return [...new Set(strings(value).filter((item):item is InitialPreparationSource['platform']=>['youtube','tiktok','instagram','facebook','linkedin'].includes(item)))];
}

export function initialPreparationSources(input:{platforms:unknown;products:unknown;historyAccounts?:unknown;stage?:unknown;historyCollectionRequestId?:unknown}):InitialPreparationSource[]{
 const platforms=Array.isArray(input.platforms)?input.platforms.filter((p):p is InitialPreparationSource['platform']=>['youtube','tiktok','instagram','facebook','linkedin'].includes(String(p))):[];
 const products=Array.isArray(input.products)?input.products.map(String).map(x=>x.trim()).filter(Boolean):[];
 if(!platforms.length||!products.length)throw Error('initial_preparation_scope_required');
 const sources:InitialPreparationSource[]=platforms.map(platform=>({key:`external:${platform}`,platform,mode:'keyword',value:products.join(' '),origin:'external'}));
 if(input.stage==='b2b_growth'&&Array.isArray(input.historyAccounts))for(const raw of input.historyAccounts){const url=new URL(String(raw));const platform=platforms.find(p=>url.hostname===`${p}.com`||url.hostname.endsWith(`.${p}.com`));if(url.protocol!=='https:'||!platform)throw Error('initial_history_account_invalid');sources.push({key:`owned:${String(input.historyCollectionRequestId||"default")}:${platform}:${url.href}`,platform,mode:'account',value:url.href,origin:'owned'});}
 return [...new Map(sources.map(s=>[s.key,s])).values()];
}

/** Build collection scope only from the persisted plan boundary. The request is
 * deliberately consulted for optional owned-account history, never for the
 * platforms, products, or operating stage that define external collection. */
export function initialPreparationSourcesFromPersisted(
 persisted:PersistedInitialPreparationScope,
 request:unknown,
):InitialPreparationSource[]{
 const pack=record(persisted.businessPackage);const config=record(persisted.config);const profile=record(persisted.profile);
 const tasks=list(pack.tasks).map(record);const videoPlans=tasks.filter(task=>task.templateId==='production').flatMap(task=>list(task.videoPlans).map(record));
 const packagePlatforms=platforms([...list(pack.matrixPlan).map(item=>record(item).platform),...videoPlans.map(item=>item.platform),...list(record(pack.operatingContext).accounts).map(item=>record(item).platform)]);
 const configPlatforms=platforms(list(config.publishingTargets).map(item=>record(item).platform));
 const persistedPlatforms=platforms(persisted.goalPlatforms);const selectedPlatforms=persistedPlatforms.length?persistedPlatforms:packagePlatforms.length?packagePlatforms:configPlatforms;
 const strategy=record(profile.strategy);const productTable=record(profile.products);const socialStrategy=record(profile.socialStrategy);
 const focusedProducts=[...videoPlans.map(item=>String(item.productName||'').trim()).filter(Boolean),...productNames(config.focusProducts),...productNames(strategy.focusProducts)];
 const products=[...new Set(focusedProducts.length?focusedProducts:list(productTable.items).map(item=>String(record(item).name||'').trim()).filter(Boolean))];
 const stage=['b2b_launch','b2b_growth','d2c_brand'].includes(String(socialStrategy.contentStage||''))?String(socialStrategy.contentStage):undefined;
 const history=record(request);
 return initialPreparationSources({platforms:selectedPlatforms,products,stage,historyAccounts:history.historyAccounts,historyCollectionRequestId:history.historyCollectionRequestId});
}
export function initialPreparationJobKey(tenantId:string,state:InitialPreparation,source:InitialPreparationSource){return createHash('sha256').update(JSON.stringify(source.origin==='owned'?[tenantId,'history',source.key]:[tenantId,state.goalId,state.requestId,source.key])).digest('hex').slice(0,15);}

type InitialPreparationPlanRecord = { id: string; tenant_id: string; status: string; plan: unknown };
type InitialPreparationPlanStore = Pick<DataStore, 'getById' | 'compareAndSwap'>;

function planBody(value: unknown): Record<string, unknown> {
 if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
 if(typeof value==='string')try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed as Record<string,unknown>;}catch{/* fail closed below */}
 throw Error('初始化计划内容无效');
}

function compareAndSwapPort(store:InitialPreparationPlanStore){
 const compareAndSwap=store.compareAndSwap;
 if(!compareAndSwap)throw Error('初始化准备需要原子存储支持');
 return compareAndSwap.bind(store);
}

/** Merge only preparation progress into the newest plan. A bounded CAS retry
 * preserves unrelated concurrent plan edits without ever writing a stale body. */
export async function persistInitialPreparationState(input:{
 dataStore:InitialPreparationPlanStore;collection:string;planId:string;tenantId:string;state:InitialPreparation;maxAttempts?:number;
}):Promise<void>{
 const compareAndSwap=compareAndSwapPort(input.dataStore);const maxAttempts=Math.max(1,Math.min(5,input.maxAttempts??3));
 for(let attempt=0;attempt<maxAttempts;attempt+=1){
  const latest=await input.dataStore.getById<InitialPreparationPlanRecord>(input.collection,input.planId);
  if(!latest||latest.tenant_id!==input.tenantId)throw Error('原计划不存在');
  if(!['draft','approved'].includes(latest.status))throw Error('原计划已锁定，请刷新后重试');
  const currentPlan=planBody(latest.plan);if(Object.prototype.hasOwnProperty.call(currentPlan,'factRebuildFence'))throw Error('原计划正在重建，请刷新后重试');
  const nextPlan={...currentPlan,initialPreparation:structuredClone(input.state)};
  if(await compareAndSwap(input.collection,input.planId,{tenant_id:input.tenantId,status:latest.status,plan:latest.plan},{plan:nextPlan}))return;
 }
 throw Error('初始化进度保存冲突，请重试');
}

/** Commit a fully prepared plan only when the exact source plan is unchanged. */
export async function replaceInitialPreparationPlan(input:{
 dataStore:InitialPreparationPlanStore;collection:string;expected:InitialPreparationPlanRecord;tenantId:string;
 nextPlan:Record<string,unknown>;conflictMessage?:string;
}):Promise<void>{
 if(input.expected.tenant_id!==input.tenantId)throw Error('原计划不存在');
 if(input.expected.status!=='draft')throw Error('原计划已锁定，请刷新后重试');
 if(Object.prototype.hasOwnProperty.call(planBody(input.expected.plan),'factRebuildFence'))throw Error('原计划正在重建，请刷新后重试');
 const compareAndSwap=compareAndSwapPort(input.dataStore);
 if(!await compareAndSwap(input.collection,input.expected.id,{tenant_id:input.tenantId,status:'draft',plan:input.expected.plan},{plan:structuredClone(input.nextPlan)}))
  throw Error(input.conflictMessage||'计划版本已修改，请重新确认');
}

export async function advanceInitialPreparation(state:InitialPreparation,ports:{save:(state:InitialPreparation)=>Promise<void>;enqueue:(source:InitialPreparationSource)=>Promise<string>;observe:(id:string)=>Promise<{status:string;candidateIds:string[];error?:string}>;analyzed:(ids:string[])=>Promise<boolean>;prepare:(ids:string[])=>Promise<{ready:boolean;reason?:string;revision:number}>;activate:(revision:number)=>Promise<string>}):Promise<InitialPreparation>{
 if(state.status==='running')return state;
 const current=structuredClone(state);current.reason='';
 try{
  for(const source of current.sources)if(!source.jobId){source.jobId=await ports.enqueue(source);await ports.save(current);}
  const observations=await Promise.all(current.sources.map(source=>ports.observe(source.jobId!)));
  const failed=observations.find(o=>o.status==='failed');if(failed)throw Error(failed.error||'真实采集失败');
  if(observations.some(o=>!['done','completed'].includes(o.status))){current.status='collecting';await ports.save(current);return current;}
  if(observations.some(o=>!o.candidateIds.length))throw Error('采集未取得真实候选，请调整账号或关键词后重新确认计划');
  current.candidateIds=[...new Set(observations.flatMap(o=>o.candidateIds))];
  if(!await ports.analyzed(current.candidateIds)){current.status='analyzing';await ports.save(current);return current;}
  current.status='preparing';await ports.save(current);
  const prepared=await ports.prepare(current.candidateIds);if(!prepared.ready)throw Error(prepared.reason||'制作输入尚未就绪');
  current.revision=prepared.revision;await ports.save(current);
  current.runId=await ports.activate(prepared.revision);current.status='running';await ports.save(current);return current;
 }catch(error){current.status='blocked';current.reason=error instanceof Error?error.message:'初始化准备失败';await ports.save(current);return current;}
}
