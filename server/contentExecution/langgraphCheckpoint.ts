import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver, WRITES_IDX_MAP,
  type Checkpoint, type CheckpointMetadata, type CheckpointTuple,
  type CheckpointListOptions, type ChannelVersions, type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { DataStore } from '../storage/datastore.js';
import { recordCurrentContentExecutionCheckpoint, parseContentExecutionCheckpoints } from './context.js';
import { assertGraphJobScope, graphIdentityHash, graphThreadId, type ProductionGraphIdentity } from './langgraphIdentity.js';

const STAGE = 'langgraph.v1';
const FORMAT = 'langgraph-checkpoints.v1';
const MAX_BYTES = 1_800_000;
const MAX_HISTORY = 128;
interface Encoded { type: string; bytes: string }
interface StoredWrite { taskId: string; index: number; channel: string; value: Encoded }
interface StoredCheckpoint { id: string; namespace: string; checkpoint: Encoded; metadata: Encoded; parentId?: string }
export interface ContentGraphCheckpointDocument {
  format: typeof FORMAT;
  identityHash: string;
  checkpoints: StoredCheckpoint[];
  writes: Record<string, StoredWrite[]>;
}
export interface ContentGraphCheckpointPort {
  read(): Promise<ContentGraphCheckpointDocument | null>;
  write(document: ContentGraphCheckpointDocument): Promise<void>;
  assertActive(): Promise<void>;
}
/** Uses the existing context's ordered write chain, never a competing checkpoints update. */
export function createJobGraphCheckpointPort(input: {
  dataStore: DataStore; identity: ProductionGraphIdentity; assertActive: () => Promise<void>; correctionHash?: string;
}): ContentGraphCheckpointPort {
  const identityHash = graphIdentityHash(input.identity);
  if(input.correctionHash && !/^[a-f0-9]{64}$/.test(input.correctionHash)) throw Error('content_graph_correction_identity_invalid');
  const stage=input.correctionHash?`lg.fix.${input.correctionHash}.v1`:STAGE;
  const read = async () => {
    const job = await assertGraphJobScope(input.dataStore, input.identity);
    const stored = parseContentExecutionCheckpoints(job.checkpoints)[stage];
    if (!stored) {
      if (job.checkpoints && typeof job.checkpoints === 'object' && Object.hasOwn(job.checkpoints, stage)) throw new Error('content_graph_checkpoint_corrupt');
      return null;
    }
    if (stored.version !== FORMAT || stored.inputHash !== identityHash) throw new Error('content_graph_checkpoint_version_changed');
    return stored.payload as ContentGraphCheckpointDocument;
  };
  return {
    read,
    assertActive: input.assertActive,
    write: async document => {
      await input.assertActive();
      await assertGraphJobScope(input.dataStore, input.identity);
      await recordCurrentContentExecutionCheckpoint({ stage, version: FORMAT, inputHash: identityHash, payload: document });
      // Context persistence intentionally no-ops outside a job. Fail closed instead
      // of treating a missing context as a production checkpointer.
      if (JSON.stringify(await read()) !== JSON.stringify(document)) throw new Error('content_graph_checkpoint_not_persisted');
    },
  };
}

/** Real BaseCheckpointSaver backed by the business datastore through the durable job context. */
export class ContentJobCheckpointSaver extends BaseCheckpointSaver {
  private writes = Promise.resolve();
  constructor(readonly identity: ProductionGraphIdentity, readonly port: ContentGraphCheckpointPort) { super(); }
  private config(config: RunnableConfig): { namespace: string; id: string } {
    if (config.configurable?.thread_id !== graphThreadId(this.identity)) throw new Error('content_graph_thread_scope_mismatch');
    const namespace = config.configurable?.checkpoint_ns ?? '';
    // This pilot is a single graph, with no nested graphs or arbitrary namespaces.
    if (namespace !== '') throw new Error('content_graph_namespace_unsupported');
    const id = config.configurable?.checkpoint_id ?? '';
    if (typeof id !== 'string' || id.length > 128 || ['__proto__','constructor','prototype'].includes(id)) throw new Error('content_graph_checkpoint_id_invalid');
    return { namespace, id };
  }
  private async read(): Promise<ContentGraphCheckpointDocument> {
    const document = await this.port.read();
    if (!document) return { format: FORMAT, identityHash: graphIdentityHash(this.identity), checkpoints: [], writes: {} };
    if (document.format !== FORMAT || document.identityHash !== graphIdentityHash(this.identity)
      || !Array.isArray(document.checkpoints) || !document.writes || typeof document.writes !== 'object') {
      throw new Error('content_graph_checkpoint_corrupt');
    }
    const encoded = (value: unknown): value is Encoded => Boolean(value && typeof value === 'object'
      && typeof (value as Encoded).type === 'string' && (value as Encoded).type.length <= 40
      && typeof (value as Encoded).bytes === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test((value as Encoded).bytes));
    if (document.checkpoints.length > MAX_HISTORY || Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES
      || document.checkpoints.some(row => !row || typeof row.id !== 'string' || !row.id || row.id.length > 128 || row.namespace !== ''
        || !encoded(row.checkpoint) || !encoded(row.metadata) || row.parentId !== undefined && typeof row.parentId !== 'string')
      || new Set(document.checkpoints.map(row=>row.id)).size !== document.checkpoints.length
      || Object.values(document.writes).some(rows => !Array.isArray(rows) || rows.some(row => !row
        || typeof row.taskId !== 'string' || !row.taskId || !Number.isSafeInteger(row.index)
        || typeof row.channel !== 'string' || !encoded(row.value)))) throw new Error('content_graph_checkpoint_corrupt');
    return document;
  }
  private async encode(value: unknown): Promise<Encoded> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return { type, bytes: Buffer.from(bytes).toString('base64') };
  }
  private async decode(value: Encoded): Promise<unknown> {
    try { return await this.serde.loadsTyped(value.type, Buffer.from(value.bytes, 'base64')); }
    catch { throw new Error('content_graph_checkpoint_corrupt'); }
  }
  private enqueue(action: (document: ContentGraphCheckpointDocument) => Promise<void>): Promise<void> {
    const operation = this.writes.then(async () => {
      await this.port.assertActive();
      const document = await this.read();
      await action(document);
      if (document.checkpoints.length > MAX_HISTORY || Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) {
        throw new Error('content_graph_checkpoint_capacity_exceeded');
      }
      await this.port.write(document);
    });
    this.writes = operation;
    return operation;
  }
  private async tuple(document: ContentGraphCheckpointDocument, row: StoredCheckpoint): Promise<CheckpointTuple> {
    const configurable = { thread_id: graphThreadId(this.identity), checkpoint_ns: row.namespace, checkpoint_id: row.id };
    const pending = [...(document.writes[row.id] ?? [])].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.index - b.index);
    return {
      config: { configurable },
      checkpoint: await this.validCheckpoint(row),
      metadata: await this.validMetadata(row),
      ...(row.parentId ? { parentConfig: { configurable: { ...configurable, checkpoint_id: row.parentId } } } : {}),
      pendingWrites: await Promise.all(pending.map(async item => [item.taskId, item.channel, await this.decode(item.value)] as [string, string, unknown])),
    };
  }
  private async validCheckpoint(row: StoredCheckpoint): Promise<Checkpoint> {
    const value = await this.decode(row.checkpoint) as Checkpoint;
    if (!value || value.id !== row.id || value.v !== 4 || !Number.isFinite(Date.parse(value.ts))
      || !value.channel_values || typeof value.channel_values !== 'object' || Array.isArray(value.channel_values)
      || !value.channel_versions || typeof value.channel_versions !== 'object' || Array.isArray(value.channel_versions)
      || !value.versions_seen || typeof value.versions_seen !== 'object' || Array.isArray(value.versions_seen)) {
      throw new Error('content_graph_checkpoint_corrupt');
    }
    return value;
  }
  private async validMetadata(row: StoredCheckpoint): Promise<CheckpointMetadata> {
    const value = await this.decode(row.metadata) as CheckpointMetadata;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.step)
      || !['input','loop','update','fork'].includes(value.source)) throw new Error('content_graph_checkpoint_corrupt');
    return value;
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { namespace, id } = this.config(config);
    await this.writes;
    const document = await this.read();
    const rows = document.checkpoints.filter(row => row.namespace === namespace).sort((a,b) => b.id.localeCompare(a.id));
    const row = id ? rows.find(row => row.id === id) : rows[0];
    return row ? this.tuple(document, row) : undefined;
  }
  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { namespace, id } = this.config(config);
    await this.writes;
    const document = await this.read();
    const before = options?.before ? this.config(options.before).id : '';
    let emitted = 0;
    for (const row of [...document.checkpoints].sort((a,b)=>b.id.localeCompare(a.id))) {
      if (row.namespace !== namespace || id && row.id !== id || before && row.id >= before) continue;
      const tuple = await this.tuple(document, row);
      if (options?.filter && !Object.entries(options.filter).every(([key,value]) => JSON.stringify(tuple.metadata?.[key as keyof CheckpointMetadata]) === JSON.stringify(value))) continue;
      if (options?.limit !== undefined && emitted >= options.limit) break;
      emitted++; yield tuple;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _versions: ChannelVersions): Promise<RunnableConfig> {
    const { namespace, id } = this.config(config);
    if (!checkpoint.id || checkpoint.id.length > 128 || ['__proto__','constructor','prototype'].includes(checkpoint.id)) throw new Error('content_graph_checkpoint_id_invalid');
    await this.enqueue(async document => {
      const row: StoredCheckpoint = { id: checkpoint.id, namespace, checkpoint: await this.encode(checkpoint), metadata: await this.encode(metadata), ...(id ? { parentId: id } : {}) };
      const prior = document.checkpoints.find(item=>item.id === row.id && item.namespace === namespace);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('content_graph_checkpoint_conflict');
      if (!prior) document.checkpoints.push(row);
    });
    return { configurable: { thread_id: graphThreadId(this.identity), checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { id } = this.config(config);
    if (!id || !taskId) throw new Error('content_graph_pending_write_identity_invalid');
    await this.enqueue(async document => {
      const stored = document.writes[id] ?? [];
      for (const [offset,[channel,value]] of writes.entries()) {
        const index = WRITES_IDX_MAP[channel] ?? offset;
        const existing = stored.find(item => item.taskId === taskId && item.index === index);
        // Ordinary outputs are immutable; special errors/interrupts/resume writes are replaceable.
        if (existing && index >= 0) continue;
        const next = { taskId, index, channel, value: await this.encode(value) };
        if (existing) stored[stored.indexOf(existing)] = next; else stored.push(next);
      }
      document.writes[id] = stored;
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== graphThreadId(this.identity)) throw new Error('content_graph_thread_scope_mismatch');
    await this.enqueue(async document => { document.checkpoints = []; document.writes = {}; });
  }
}
