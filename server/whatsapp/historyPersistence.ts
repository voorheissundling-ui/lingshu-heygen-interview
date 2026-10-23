import { storedCompleteness, mergeStoredObjects } from './storedValueMerge.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { objectStorageUpload } from '../storage/objectStorage.js';
import { store } from '../storage/index.js';
import type { StoredCustomer, StoredCustomerOrder, StoredInteraction, ImportStatus } from './historyImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'whatsapp-customers.json');
const INTERACTIONS_FILE = path.join(DATA_DIR, 'whatsapp-interactions.json');
const IMPORT_STATUS_FILE = path.join(DATA_DIR, 'whatsapp-import-status.json');
export const NIGHT_MODE_EVENTS_FILE = path.join(DATA_DIR, 'night-mode-events.json');
const ENTERPRISE_FILE = path.join(DATA_DIR, 'enterprise.json');
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');

function customerFreshness(customer: StoredCustomer): number {
  return Math.max(
    Number(customer.lastActiveAt || 0),
    Date.parse(customer.updatedAt || '') || 0,
    Date.parse(customer.createdAt || '') || 0,
  );
}

function mergeStoredCustomers(left: StoredCustomer, right: StoredCustomer): StoredCustomer {
  const leftFreshness = customerFreshness(left);
  const rightFreshness = customerFreshness(right);
  const rightPreferred = rightFreshness > leftFreshness
    || (rightFreshness === leftFreshness
      && storedCompleteness(right as unknown as Record<string, unknown>) >= storedCompleteness(left as unknown as Record<string, unknown>));
  const fallback = rightPreferred ? left : right;
  const preferred = rightPreferred ? right : left;
  const merged = mergeStoredObjects(
    fallback as unknown as Record<string, unknown>,
    preferred as unknown as Record<string, unknown>,
  ) as unknown as StoredCustomer;
  const tags = [...new Set([...(preferred.tags || []), ...(fallback.tags || [])].map(item => String(item || '').trim()).filter(Boolean))];
  if (tags.length) merged.tags = tags;
  const orders = new Map<string, StoredCustomerOrder>();
  for (const order of [...(fallback.orders || []), ...(preferred.orders || [])]) {
    if (order?.id) orders.set(order.id, order);
  }
  if (orders.size) merged.orders = [...orders.values()];
  merged.lastActiveAt = Math.max(Number(left.lastActiveAt || 0), Number(right.lastActiveAt || 0));
  const createdTimes = [left.createdAt, right.createdAt].map(value => Date.parse(value || '')).filter(Number.isFinite);
  if (createdTimes.length) merged.createdAt = new Date(Math.min(...createdTimes)).toISOString();
  const updatedTimes = [left.updatedAt, right.updatedAt].map(value => Date.parse(value || '')).filter(Number.isFinite);
  if (updatedTimes.length) merged.updatedAt = new Date(Math.max(...updatedTimes)).toISOString();
  return merged;
}

export function dedupeWhatsAppCustomerRecords(items: StoredCustomer[]): StoredCustomer[] {
  const records = new Map<string, StoredCustomer>();
  const invalid: StoredCustomer[] = [];
  for (const item of items) {
    const tenantId = String(item?.tenantId || '').trim();
    const id = String(item?.id || '').trim();
    if (!tenantId || !id) { invalid.push(item); continue; }
    const key = `${tenantId}\u0000${id}`;
    const prior = records.get(key);
    records.set(key, prior ? mergeStoredCustomers(prior, item) : item);
  }
  return [...records.values(), ...invalid];
}

function mergeStoredInteractions(left: StoredInteraction, right: StoredInteraction): StoredInteraction {
  const rightPreferred = Number(right.timestamp || 0) > Number(left.timestamp || 0)
    || (Number(right.timestamp || 0) === Number(left.timestamp || 0)
      && storedCompleteness(right as unknown as Record<string, unknown>) >= storedCompleteness(left as unknown as Record<string, unknown>));
  return mergeStoredObjects(
    (rightPreferred ? left : right) as unknown as Record<string, unknown>,
    (rightPreferred ? right : left) as unknown as Record<string, unknown>,
  ) as unknown as StoredInteraction;
}

export function dedupeWhatsAppInteractionRecords(items: StoredInteraction[]): StoredInteraction[] {
  const records = new Map<string, StoredInteraction>();
  const invalid: StoredInteraction[] = [];
  for (const item of items) {
    const tenantId = String(item?.tenantId || '').trim();
    const id = String(item?.id || '').trim();
    if (!tenantId || !id) { invalid.push(item); continue; }
    const providerId = whatsappInteractionProviderId(item);
    const key = `${tenantId}\u0000${providerId ? 'provider:' + String(item.audit?.phoneNumberId||'') + ':' + providerId : 'local:' + id}`;
    const prior = records.get(key);
    records.set(key, prior ? mergeStoredInteractions(prior, item) : item);
  }
  return [...records.values(), ...invalid].sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    const backupFile = `${file}.bak`;
    if (fs.existsSync(backupFile)) {
      try {
        return JSON.parse(fs.readFileSync(backupFile, 'utf8')) as T;
      } catch { /* continue to corruption backup */ }
    }
    if (fs.existsSync(file)) {
      const corruptFile = `${file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(file, corruptFile);
        console.error('[whatsapp-json-corrupt]', file, 'backed up to', corruptFile, error);
      } catch (copyError) {
        console.error('[whatsapp-json-corrupt]', file, copyError);
      }
    }
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort backup */ }
  }
  fs.renameSync(tmp, file);
}

export function backupWhatsAppDataFiles(now = new Date()): void {
  const date = now.toISOString().slice(0, 10);
  const backupDir = path.join(BACKUP_ROOT, date);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of [CUSTOMERS_FILE, INTERACTIONS_FILE, IMPORT_STATUS_FILE, ENTERPRISE_FILE]) {
    if (!fs.existsSync(file)) continue;
    const target = path.join(backupDir, path.basename(file));
    if (fs.existsSync(target)) continue;
    try { fs.copyFileSync(file, target); } catch (error) { console.error('[whatsapp-daily-backup]', file, error); }
  }
}

function r2BackupEnabled(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim()
    && process.env.R2_ACCESS_KEY_ID?.trim()
    && process.env.R2_SECRET_ACCESS_KEY?.trim()
    && process.env.R2_BUCKET_NAME?.trim(),
  );
}

function backupPrefix(): string {
  return (process.env.R2_BACKUP_PREFIX || 'lingshu-backups').replace(/^\/+|\/+$/g, '');
}

function localBackupRetentionDays(): number {
  const raw = Number(process.env.R2_BACKUP_LOCAL_RETENTION_DAYS || 7);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 7;
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(full) : [full];
  });
}

export async function syncBackupsToR2(now = new Date()): Promise<void> {
  if (!r2BackupEnabled()) {
    console.warn('[whatsapp-backup-r2] skipped: R2 credentials are not configured');
    return;
  }
  if (!fs.existsSync(BACKUP_ROOT)) return;

  const dirs = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const prefix = backupPrefix();
  for (const dir of dirs) {
    const backupDir = path.join(BACKUP_ROOT, dir.name);
    const files = listFilesRecursive(backupDir);
    for (const file of files) {
      const relative = path.relative(BACKUP_ROOT, file).split(path.sep).join('/');
      await objectStorageUpload({
        key: `${prefix}/${relative}`,
        body: fs.readFileSync(file),
        contentType: 'application/json',
      });
    }
  }

  const cutoff = now.getTime() - localBackupRetentionDays() * 86_400_000;
  for (const dir of dirs) {
    const time = new Date(`${dir.name}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(time) || time >= cutoff) continue;
    fs.rmSync(path.join(BACKUP_ROOT, dir.name), { recursive: true, force: true });
  }
}

const pocketBaseMirrorQueues = new Map<string, Promise<void>>();

async function serializePocketBaseMirror(key: string, operation: () => Promise<void>): Promise<void> {
  const prior = pocketBaseMirrorQueues.get(key) || Promise.resolve();
  const current = prior.catch(() => undefined).then(operation);
  pocketBaseMirrorQueues.set(key, current);
  try { await current; }
  finally {
    if (pocketBaseMirrorQueues.get(key) === current) pocketBaseMirrorQueues.delete(key);
  }
}

export async function mirrorCustomerToPocketBase(customer: StoredCustomer): Promise<void> {
  await serializePocketBaseMirror(`customer:${customer.tenantId}:${customer.id}`, async () => {
    const payload = {
      tenant_id: customer.tenantId,
      customer_id: customer.id,
      wa_number: customer.waNumber,
      name: customer.name,
      stage: customer.stage,
      last_active_at: customer.lastActiveAt,
      payload: JSON.stringify(customer),
    };
    const existing = await store.list<{ id: string }>('whatsapp_customers', {
      where: { tenant_id: customer.tenantId, customer_id: customer.id },
      perPage: 1,
    });
    const id = existing.items[0]?.id;
    const written=id?(await store.update('whatsapp_customers',id,payload)===true?{id}:null):await store.create<{id:string}>('whatsapp_customers',payload);
    if(!written?.id)throw Error('whatsapp_customer_persistence_failed');
    const saved=await store.getById<Record<string,unknown>>('whatsapp_customers',written.id);
    if(!saved||saved.id!==written.id||saved.tenant_id!==customer.tenantId||saved.customer_id!==customer.id||saved.payload!==payload.payload)throw Error('whatsapp_customer_persistence_failed');
  });
}

export async function mirrorInteractionToPocketBase(interaction: StoredInteraction): Promise<void> {
  await serializePocketBaseMirror(`interaction:${interaction.tenantId}:${interaction.id}`, async () => {
    const payload = {
      tenant_id: interaction.tenantId,
      interaction_id: interaction.id,
      customer_id: interaction.customerId,
      wa_number: interaction.waNumber,
      timestamp: interaction.timestamp,
      payload: JSON.stringify(interaction),
    };
    const existing = await store.list<{ id: string }>('whatsapp_interactions', {
      where: { tenant_id: interaction.tenantId, interaction_id: interaction.id },
      perPage: 1,
    });
    const id = existing.items[0]?.id;
    const written=id?(await store.update('whatsapp_interactions',id,payload)===true?{id}:null):await store.create<{id:string}>('whatsapp_interactions',payload);
    if(!written?.id)throw Error('whatsapp_interaction_persistence_failed');
    const saved=await store.getById<Record<string,unknown>>('whatsapp_interactions',written.id);
    if(!saved||saved.id!==written.id||saved.tenant_id!==interaction.tenantId||saved.interaction_id!==interaction.id||saved.payload!==payload.payload)throw Error('whatsapp_interaction_persistence_failed');
  });
}

export function customers(): StoredCustomer[] {
  return dedupeWhatsAppCustomerRecords(readJson<StoredCustomer[]>(CUSTOMERS_FILE, []));
}

export function writeCustomers(items: StoredCustomer[]): void {
  writeJson(CUSTOMERS_FILE, dedupeWhatsAppCustomerRecords(items));
}

export function interactions(): StoredInteraction[] {
  return dedupeWhatsAppInteractionRecords(readJson<StoredInteraction[]>(INTERACTIONS_FILE, []));
}

export function writeInteractions(items: StoredInteraction[]): void {
  writeJson(INTERACTIONS_FILE, dedupeWhatsAppInteractionRecords(items));
}

export function importStatus(): ImportStatus {
  return readJson<ImportStatus>(IMPORT_STATUS_FILE, {
    tenantId: 'local',
    status: 'idle',
    done: 0,
    total: 0,
    updatedAt: new Date(0).toISOString(),
  });
}

export function writeImportStatus(status: ImportStatus): void {
  writeJson(IMPORT_STATUS_FILE, status);
}


export function whatsappInteractionProviderId(item: Pick<StoredInteraction, 'metaMessageId' | 'meta' | 'audit'>): string {
  return String(item.metaMessageId || item.meta?.providerMessageId || item.audit?.providerMessageId || '').trim();
}
