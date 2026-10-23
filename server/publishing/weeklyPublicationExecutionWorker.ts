import { readTikTokCanonicalAttemptReceipt } from './platformPublisher.js';
import {weeklyFormalPublicationBoundary,assertWeeklyPublicationStoredScope} from './weeklyFormalPublicationBoundary.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';
import {assertWeeklyPublicationRecoveryDue} from '../socialPrograms/weeklyPublicationRecoverySchedule.js';
import type { WeeklyOperatingPackage } from '../../shared/contracts/socialProgram.js';
import type { DataStore, ListQuery } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { readStarterPublicationPackage } from './starterPublicationPackage.js';
import { createWeeklyPublishingAdapter } from './weeklyPublishingAdapter.js';
import { executeWeeklyPublication, reconcileWeeklyPublication, PUBLICATION_ASSIGNMENTS, PUBLICATION_ATTEMPTS, type DurablePublicationAttempt, type StoredPublicationAssignment, type WeeklyPublishingProviderAdapter } from './weeklyLineage.js';

type WeeklyPackageRow = { id: string; tenant_id: string; package_id: string; version: number; payload: WeeklyOperatingPackage };
export interface WeeklyPublicationExecutionResult { scanned: number; published: number; pending: number; failed: number; skipped: number; errors: Array<{ tenantId: string; assignmentId: string; code: string }> }

/** Existing ambiguous attempts are reconciled and never submitted again. */
export async function runWeeklyPublicationExecutionScan(input: {
  dataStore?: DataStore;
  limit?: number;
  now?: Date;
  adapterFactory?: (assignment: StoredPublicationAssignment) => Promise<WeeklyPublishingProviderAdapter>;
} = {}): Promise<WeeklyPublicationExecutionResult> {
  const dataStore = input.dataStore ?? store;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  // Pagination uses stable IDs; the limit bounds each page, never silently drops later pages.
  async function all<T>(collection: string, query: ListQuery): Promise<T[]> {
    const items: T[] = [];
    const ids = new Set<string>();
    let expectedTotal: number | undefined;
    let expectedPages: number | undefined;
    for (let page = 1; ; page++) {
      const found = await dataStore.list<T>(collection, { ...query, sort: 'id', page, perPage: limit });
      if (!Number.isSafeInteger(found.totalItems) || found.totalItems < 0 || (found.totalItems === 0 ? ![0, 1].includes(found.totalPages) : found.totalPages !== Math.ceil(found.totalItems / limit)) || found.page !== page || found.perPage !== limit || (expectedTotal !== undefined && (found.totalItems !== expectedTotal || found.totalPages !== expectedPages))) throw Error('publication_scan_snapshot_changed');
      expectedTotal = found.totalItems; expectedPages = found.totalPages;
      for (const item of found.items) {
        const record = item as Record<string, unknown>;
        if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || Object.entries(query.where ?? {}).some(([key, value]) => record[key] !== value)) throw Error('publication_scan_scope_or_duplicate');
        ids.add(record.id); items.push(structuredClone(item));
      }
      if (page >= found.totalPages) {
        if (items.length !== expectedTotal) throw Error('publication_scan_snapshot_changed');
        return items;
      }
      if (!found.items.length) throw Error('publication_scan_pagination_incomplete');
    }
  }

  const result: WeeklyPublicationExecutionResult = { scanned: 0, published: 0, pending: 0, failed: 0, skipped: 0, errors: [] };
  const candidates = new Map<string, { row: StoredPublicationAssignment; recoveryAttempt?: DurablePublicationAttempt }>();
  for (const row of await all<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, { where: { status: 'package_ready' } })) {
    if (row.status !== 'package_ready') throw Error('publication_assignment_scan_scope_invalid');
    candidates.set(`${row.tenant_id}\0${row.assignment_id}`, { row });
  }
  for (const row of await all<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, { where: { receipt_recovery_required: true } })) {
    candidates.set(`${row.tenant_id}\0${row.assignment_id}`, { row });
  }
  for (const status of ['unknown', 'in_flight'] as const) {
    for (const attempt of await all<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, { where: { status } })) {
      try {
        if (attempt.status !== status || !attempt.tenant_id || !attempt.assignment_id || !attempt.package_id || !attempt.attempt_id) throw Error('publication_attempt_scope_invalid');
        const found = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, { where: { tenant_id: attempt.tenant_id, assignment_id: attempt.assignment_id }, page: 1, perPage: 2 });
        const row = found.items[0];
        if (found.totalItems !== 1 || found.items.length !== 1 || !row || row.tenant_id !== attempt.tenant_id || row.assignment_id !== attempt.assignment_id || row.package_id !== attempt.package_id) throw Error('publication_recovery_assignment_scope_invalid');
        const key = `${row.tenant_id}\0${row.assignment_id}`;
        const previous = candidates.get(key)?.recoveryAttempt;
        if (previous && previous.id !== attempt.id) throw Error('publication_attempt_scope_ambiguous');
        candidates.set(key, { row, recoveryAttempt: attempt });
      } catch (error) {
        result.errors.push({ tenantId: attempt.tenant_id, assignmentId: attempt.assignment_id, code: error instanceof Error ? error.message : 'publication_recovery_candidate_failed' });
      }
    }
  }
  result.scanned = candidates.size;
  for (const candidate of candidates.values()) {
    const row = structuredClone(candidate.row);
    const recoveryAttempt = candidate.recoveryAttempt ? structuredClone(candidate.recoveryAttempt) : undefined;
    try {
      const weeklyRows = await dataStore.list<WeeklyPackageRow>('social_weekly_operating_packages', { where: { tenant_id: row.tenant_id, package_id: row.operating_package_id, version: row.operating_package_version }, page: 1, perPage: 2 });
      if (weeklyRows.totalItems !== 1 || weeklyRows.items.length!==1 || !weeklyRows.items[0] || weeklyRows.items[0].tenant_id!==row.tenant_id || weeklyRows.items[0].package_id!==row.operating_package_id || weeklyRows.items[0].version!==row.operating_package_version) throw new Error('weekly_operating_package_not_found');
      assertWeeklyPublicationStoredScope(row,weeklyRows.items[0].payload);
      const attempts = await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, { where: { tenant_id: row.tenant_id, assignment_id: row.assignment_id }, page: 1, perPage: 2 });
      if(attempts.totalItems!==attempts.items.length||attempts.items.length>1||attempts.items.some(attempt=>attempt.tenant_id!==row.tenant_id||attempt.assignment_id!==row.assignment_id||attempt.package_id!==row.package_id))throw Error('publication_attempt_scope_ambiguous');
      let existing=attempts.items[0];
      const clearTerminalRecovery = async (attempt: DurablePublicationAttempt) => {
        const terminal=await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS,{where:{tenant_id:row.tenant_id,assignment_id:row.assignment_id},page:1,perPage:2});
        const fresh=terminal.items[0];
        if(terminal.totalItems!==1||terminal.items.length!==1||!fresh||fresh.id!==attempt.id||fresh.attempt_id!==attempt.attempt_id||fresh.package_id!==row.package_id||fresh.provider!==attempt.provider||fresh.provider_receipt_id!==attempt.provider_receipt_id||fresh.status!==attempt.status||!['published','failed'].includes(fresh.status))throw Error('publication_recovery_terminal_changed');
        const assignments=await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS,{where:{tenant_id:row.tenant_id,assignment_id:row.assignment_id},page:1,perPage:2});
        const actual=assignments.items[0];
        if(assignments.totalItems!==1||assignments.items.length!==1||!actual||actual.id!==row.id||actual.package_id!==row.package_id||actual.operating_package_id!==row.operating_package_id||actual.operating_package_version!==row.operating_package_version||actual.account_id!==row.account_id||actual.platform!==row.platform||actual.status!==row.status||actual.assignment_hash!==row.assignment_hash)throw Error('publication_recovery_assignment_changed');
        assertWeeklyPublicationStoredScope(actual,weeklyRows.items[0]!.payload);
        if ((actual as unknown as Record<string, unknown>).receipt_recovery_required !== true) return;
        const started = publicationInstant(fresh.started_at), resolved = publicationInstant(fresh.resolved_at);
        const expectedProvider = row.platform === 'tiktok' ? 'tiktok-content-posting-api' : row.platform === 'youtube' ? 'youtube-data-api' : row.platform === 'linkedin' ? 'linkedin-posts-api' : 'meta-graph-api';
        if (started === null || resolved === null || resolved < started || resolved > (input.now ?? new Date()).getTime() || fresh.provider !== expectedProvider || (fresh.status === 'published' ? !fresh.provider_receipt_id?.trim() || !fresh.platform_post_id?.trim() : !fresh.failure_code?.trim())) throw Error('publication_recovery_terminal_evidence_invalid');
        if(!await dataStore.update(PUBLICATION_ASSIGNMENTS,row.id,{receipt_recovery_required:false}))throw Error('publication_recovery_projection_failed');
      };
      if(existing?.status==='published'||existing?.status==='failed'){await clearTerminalRecovery(existing);result.skipped++;continue;}
      if(recoveryAttempt && (!existing || existing.id!==recoveryAttempt.id || existing.attempt_id!==recoveryAttempt.attempt_id || existing.provider!==recoveryAttempt.provider || existing.provider_receipt_id!==recoveryAttempt.provider_receipt_id)) throw Error('publication_recovery_attempt_changed');
      const reconciling=Boolean(existing&&['unknown','in_flight'].includes(existing.status));
      if((recoveryAttempt||row.status!=='package_ready')&&!reconciling){result.skipped++;continue;}
      if (reconciling && !existing?.provider_receipt_id?.trim() && row.platform === 'tiktok' && existing?.provider === 'tiktok-content-posting-api') {
        const receiptId = await readTikTokCanonicalAttemptReceipt({ tenantId: row.tenant_id, accountId: row.account_id, attemptId: existing.attempt_id, dataStore });
        if (receiptId) {
          const actual = await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, { where: { tenant_id: row.tenant_id, assignment_id: row.assignment_id }, perPage: 2 });
          const current = actual.items[0];
          if (actual.totalItems !== 1 || actual.items.length !== 1 || !current || current.id !== existing.id || current.tenant_id !== row.tenant_id || current.attempt_id !== existing.attempt_id || current.assignment_id !== row.assignment_id || current.package_id !== row.package_id || current.provider !== existing.provider || current.status !== existing.status || !['unknown','in_flight'].includes(current.status) || (current.provider_receipt_id && current.provider_receipt_id !== receiptId)) throw Error('publication_canonical_recovery_attempt_changed');
          if (!await dataStore.update(PUBLICATION_ATTEMPTS, current.id, { provider_receipt_id: receiptId, updated_at: new Date().toISOString() })) throw Error('publication_canonical_recovery_persistence_failed');
          const saved = await dataStore.getById<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, current.id);
          if (!saved || saved.tenant_id !== row.tenant_id || saved.attempt_id !== current.attempt_id || saved.assignment_id !== row.assignment_id || saved.package_id !== row.package_id || saved.provider !== current.provider || saved.status !== current.status || saved.provider_receipt_id !== receiptId) throw Error('publication_canonical_recovery_attempt_changed');
          existing = saved;
        }
      }
      if(reconciling&&!existing?.provider_receipt_id?.trim()){result.pending++;continue;}
      if(!reconciling){try{await assertWeeklyPublicationRecoveryDue(dataStore,row.payload,input.now??new Date());}catch(error){if(error instanceof Error&&'code' in error&&error.code==='weekly_publication_recovery_not_due'){result.pending++;continue;}throw error;}}
      if(!reconciling&&await weeklyFormalPublicationBoundary(dataStore,row,weeklyRows.items[0].payload)==='formal'){result.skipped++;continue;}
      const publicationPackage = await readStarterPublicationPackage(row.tenant_id, row.package_id, dataStore);
      if (!publicationPackage) throw new Error('publication_package_not_found');
      const lineage = publicationPackage.operatingLineage;
      const expectedRef = row.payload.lineage.productionResultRef;
      if (publicationPackage.tenantId !== row.tenant_id || publicationPackage.packageId !== row.package_id || publicationPackage.platform !== row.platform || !lineage || lineage.assignmentId !== row.assignment_id || lineage.assignmentHash !== row.assignment_hash || lineage.productionResultRef.type !== expectedRef.type || lineage.productionResultRef.id !== expectedRef.id || lineage.productionResultRef.version !== expectedRef.version) throw Error('publication_package_scope_invalid');
      const adapter = input.adapterFactory ? await input.adapterFactory(row) : await createWeeklyPublishingAdapter({ tenantId: row.tenant_id, accountId: row.account_id, platform: row.platform, dataStore, now: input.now,...(reconciling?{purpose:'receipt_lookup' as const,providerReceiptId:existing?.provider_receipt_id}:{}) });
      if(reconciling&&adapter.provider!==existing!.provider)throw Error('publication_attempt_provider_changed');
      if (adapter.capability !== 'available') { result.errors.push({ tenantId: row.tenant_id, assignmentId: row.assignment_id, code: adapter.unavailableReason || 'publishing_provider_unavailable' }); continue; }
      if(reconciling){const attempt=await reconcileWeeklyPublication({assignment:row.payload,publicationPackage,adapter,now:input.now,dataStore});if(attempt.status==='published')result.published++;else if(attempt.status==='failed')result.failed++;else result.pending++;if(['published','failed'].includes(attempt.status))await clearTerminalRecovery(attempt);continue;}
      const operatingAssignments = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, { where: { tenant_id: row.tenant_id, operating_package_id: row.operating_package_id, operating_package_version: row.operating_package_version }, page: 1, perPage: 500 });
      if (operatingAssignments.totalItems > operatingAssignments.items.length) throw new Error('publication_assignment_scan_truncated');
      let existingPublishedCount = 0;
      for (const assigned of operatingAssignments.items) {
        const terminal = await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, { where: { tenant_id: row.tenant_id, assignment_id: assigned.assignment_id, status: 'published' }, page: 1, perPage: 1 });
        if (terminal.totalItems) existingPublishedCount += 1;
      }
      const attempt = await executeWeeklyPublication({ assignment: row.payload, publicationPackage, contentPackage: weeklyRows.items[0].payload.socialContentPackage, adapter, existingPublishedCount, now: input.now, dataStore });
      if (attempt.status === 'published') result.published += 1;
      else if (attempt.status === 'failed') result.failed += 1;
      else result.pending += 1;
    } catch (error) {
      result.errors.push({ tenantId: row.tenant_id, assignmentId: row.assignment_id, code: error instanceof Error ? error.message : 'weekly_publication_execution_failed' });
    }
  }
  return result;
}
