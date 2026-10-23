import type {TestContext} from 'node:test';import fs from 'node:fs';import path from 'node:path';import type {DataStore,ListQuery,ListResult,Record_} from '../storage/datastore.js';import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';import {DURABLE_OPERATION_LEASE_COLLECTION} from './durableLease.js';import {WEEKLY_EXECUTION_TASKS} from '../socialPrograms/executionTasks.js';import {store as routeStore} from '../storage/index.js';import {updateTenantEnterpriseProfile,type EnterpriseProfile} from '../routes/enterprise.js';import {createSocialOperatingOrchestrationService} from '../socialOperating/orchestration.js';
function memoryStore(snapshot:Record<string,Record_[]>={}): DataStore & {snapshot():Record<string,Record_[]>} {
  const rows = new Map<string, Record_[]>(Object.entries(structuredClone(snapshot)));
  let counter = Math.max(0,...Object.values(snapshot).flatMap(items=>items.map(item=>/^row-(\d+)$/.exec(String(item.id))?.[1]).filter((value):value is string=>Boolean(value)).map(Number)));
  const matches = (row: Record_, where: ListQuery['where']) => Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
  return {
    snapshot(){return structuredClone(Object.fromEntries(rows));},
    async getById<T>(collection: string, id: string) {
      return structuredClone(rows.get(collection)?.find(row => row.id === id) ?? null) as T | null;
    },
    async create<T>(collection: string, data: Record<string, unknown>) {
      const list = rows.get(collection) ?? [];
      if (collection === DURABLE_OPERATION_LEASE_COLLECTION
        && list.some(row => row.tenant_id === data.tenant_id && row.lease_scope === data.lease_scope && row.subject_id === data.subject_id)) return null;
      if (collection === WEEKLY_EXECUTION_TASKS
        && list.some(row => row.tenant_id === data.tenant_id && row.idempotency_key === data.idempotency_key)) return null;
      const row = { id: `row-${++counter}`, ...structuredClone(data) } as Record_;
      rows.set(collection, [...list, row]);
      return structuredClone(row) as T;
    },
    async update(collection: string, id: string, data: Record<string, unknown>) {
      const list = rows.get(collection) ?? [];
      const index = list.findIndex(row => row.id === id);
      if (index < 0) return false;
      list[index] = { ...list[index], ...structuredClone(data) };
      return true;
    },
    async delete(collection: string, id: string) {
      const list = rows.get(collection) ?? [];
      const next = list.filter(row => row.id !== id);
      rows.set(collection, next);
      return next.length !== list.length;
    },
    async list<T>(collection: string, query: ListQuery = {}): Promise<ListResult<T>> {
      let list = (rows.get(collection) ?? []).filter(row => matches(row, query.where));
      if (query.sort) {
        const descending = query.sort.startsWith('-');
        const field = descending ? query.sort.slice(1) : query.sort;
        list = [...list].sort((left, right) => String(left[field] ?? '').localeCompare(String(right[field] ?? '')) * (descending ? -1 : 1));
      }
      const page = query.page ?? 1;
      const perPage = query.perPage ?? 30;
      return {
        items: structuredClone(list.slice((page - 1) * perPage, page * perPage)) as T[],
        totalItems: list.length,
        totalPages: Math.max(1, Math.ceil(list.length / perPage)),
        page,
        perPage,
      };
    },
  };
}

/** Test-only disk-backed DataStore: every completed mutation is durable before
 * the caller receives it, and a new instance reads the same serialized file. */
function persistentStore(file:string):DataStore & {snapshot():Record<string,Record_[]>}{
 const seed=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')) as Record<string,Record_[]>:{};
 const memory=memoryStore(seed);
 const persist=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(memory.snapshot()));fs.renameSync(temporary,file);};
 return {...memory,
  async create<T>(collection:string,data:Record<string,unknown>){const created=await memory.create<T>(collection,data);if(created)persist();return created;},
  async update(collection:string,id:string,data:Record<string,unknown>){const changed=await memory.update(collection,id,data);if(changed)persist();return changed;},
  async delete(collection:string,id:string){const changed=await memory.delete(collection,id);if(changed)persist();return changed;},
 };
}

export function reopenWeeklyEnterpriseFactFixtureStore(file:string):DataStore & {snapshot():Record<string,Record_[]>}{return persistentStore(file);}

function task(tenantId = 'tenant-a'): WeeklyExecutionTask {
  return { taskId: 'task-a', tenantId, programId: 'program-a', packageId: 'package-a', packageVersion: 1,
    workflowKind: 'readiness', scope: 'package', subjectId: 'package-a', accountId: null, publicationTaskId: null,
    dependsOnTaskIds: [], upstreamVersionRefs: [], inputSnapshot: {}, idempotencyKey: `key-${tenantId}`,
    budget: { category: 'none', limitCny: null }, schedule: { stepKind: 'business_outline', responsibleActor: 'business_agent', estimatedDurationMinutes: 15, estimatedStartAt: '', estimatedFinishAt: '', actualStartedAt: null, actualFinishedAt: null },
    status: 'queued', ownBlockingReasons: [], inheritedBlockingTaskIds: [], attempt: 0, maxAttempts: 3,
    nextAttemptAt: null, lease: null, resultRefs: [], lastError: null, recoveredFromDeadLetterAt: null, cancelReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

const now = '2026-09-26T00:00:00.000Z';
const program = {
  programId: 'program-a', brandName: 'Factory', businessLine: null, market: 'US', targetAudience: 'brand buyer',
  candidatePlatforms: ['tiktok'], route: 'cold_start', stage: 'ready_for_week', readiness: {}, enterpriseProfileRef: null,
  productMarketingProfileRefs: [], activeMonthlyPlanRef: null, activeWeeklyPlanRef: null, activeWeeklyOperatingPackageRef: null,
  version: 1, status: 'active', createdAt: now, updatedAt: now,
};
const account = {
  accountId: 'account-a', programId: 'program-a', platform: 'tiktok', displayName: 'TikTok', handle: '@factory', businessRole: 'proof',
  audiencePromise: 'facts', contentPromise: 'evidence', status: 'active', connectionId: 'connection-a', connectionCapabilities: ['publish'],
  playbookRef: { type: 'account_playbook', id: 'playbook-a', version: 1 },
  conversionRoute: { routeId: 'route-a', entryType: 'form', entryRef: 'https://example.test/form', callToAction: 'Submit', qualificationFields: [], handoffTarget: 'sales-a', verifiedAt: now },
  version: 2, createdAt: now, updatedAt: now,
};


export async function prepareWeeklyEnterpriseFactFixture(context:TestContext,options:{persistentFile?:string}={}){
 const store=options.persistentFile?persistentStore(options.persistentFile):memoryStore();for(const key of ['list','getById','create','update','delete'] as const)context.mock.method(routeStore,key,store[key].bind(store));
 await store.create('users',{id:'owner',tenantId:'tenant-a',role:'social_operator',active:true});
 const patch:Partial<EnterpriseProfile>={company:{name:'Actual factory',industry:'制造',description:'Verified factory',mainMarkets:'US',primaryLanguages:'en',founded:'2018'},products:{categories:'Industrial products',items:[{name:'Serum',priceRange:'',images:[],certificateImages:[],documents:[]}],priceRange:'',moq:'',certifications:'',highlights:'Small batch sampling'},brand:{name:'Factory',tone:'professional',style:'',taboos:'',usp:'Documented QC'}};
 const profile=await updateTenantEnterpriseProfile('tenant-a',patch,'owner');
 await store.create('social_programs',{tenant_id:'tenant-a',program_id:'program-a',payload:program});await store.create('social_owned_accounts',{tenant_id:'tenant-a',program_id:'program-a',account_id:'account-a',payload:account});
 const authority=await createSocialOperatingOrchestrationService(store).resolve('tenant-a','owner','program-a',{weekStart:'2026-10-12'});
 const t=task();Object.assign(t,{workflowKind:'content',scope:'publication',accountId:'account-a',publicationTaskId:'pub'});Object.assign(t.schedule,{stepKind:'material_readiness',estimatedStartAt:'2026-10-12T00:00:00Z',estimatedFinishAt:'2026-10-12T01:00:00Z'});
 const pub={publicationTaskId:'pub',accountId:'account-a',platform:'tiktok',factRefs:authority.goal.publicFactRefs};
 const pkg={packageId:t.packageId,programId:t.programId,version:1,status:'active',weekStart:'2026-10-12',weekEnd:'2026-10-18',businessContentGoalRef:authority.snapshot.businessContentGoalRef,operatingDecisionSnapshotRef:{type:'operating_authority_snapshot',id:authority.snapshot.snapshotId,version:authority.snapshot.version},socialContentPackage:{publicationTasks:[pub]}} as unknown as WeeklyOperatingPackage;
 t.inputSnapshot={publicationTask:structuredClone(pub)};
 await store.create('social_weekly_operating_packages',{tenant_id:t.tenantId,program_id:t.programId,package_id:t.packageId,version:1,status:'active',payload:pkg});
 return{store,task:t,pkg,profile,patch,authority,async confirm(){return updateTenantEnterpriseProfile('tenant-a',patch,'owner');}};
}
