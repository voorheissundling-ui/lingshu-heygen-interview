import type {DataStore} from '../storage/datastore.js';
import {currentDataAuthority} from '../storage/dataAuthority.js';

export class PublicationAtomicStoreError extends Error {
  readonly code='publication_atomic_store_unavailable';
  constructor(){
    super('真实发布暂不可用：请确认实际数据库已完成迁移，并核验租约唯一索引后重新验证。系统不会自动切换本地存储重试发布。');
    this.name='PublicationAtomicStoreError';
  }
}

/** Real publication needs database-arbitrated subject leases. A local JSON
 * fallback cannot satisfy this contract, including background worker calls. */
export async function assertPublicationAtomicStore(dataStore:DataStore):Promise<void> {
  if(currentDataAuthority()==='local'||await dataStore.supportsAtomicOperationLease?.()!==true)throw new PublicationAtomicStoreError();
}
