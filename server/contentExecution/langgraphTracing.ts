import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { RunTree } from 'langsmith/run_trees';

/**
 * A local callback reserved for this graph. Core 1.2.17 auto-installs a remote
 * tracer when environment tracing is enabled and no handler with this name
 * exists. Supply a non-exporting handler explicitly, in addition to a scoped
 * tracing=false RunTree, so nested callbacks cannot re-enable ambient tracing.
 * This relies on the pinned core callback contract and is covered by a child
 * process test with both tracing environment switches enabled.
 */
export class LocalOnlyContentGraphCallbacks extends BaseCallbackHandler {
  name = 'langchain_tracer';
  copyWithTracingConfig(): this { return this; }
  updateFromRunTree(): void { /* Deliberately never export input or output. */ }
  getRunTreeWithTracingConfig(): RunTree {
    return new RunTree({name:'content-production-local',tracingEnabled:false});
  }
}
