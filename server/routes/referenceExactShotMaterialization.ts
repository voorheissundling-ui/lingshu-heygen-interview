import type { Router, RequestHandler } from 'express';
import type { DataStore } from '../storage/datastore.js';
import { createExactShotMaterializationService } from '../lib/referenceExactShotMaterialization.js';
import { SocialContentWorkflowError } from '../starter198/socialContentValidation.js';

/** Registered on the authenticated videos router; scope always comes from auth. */
export function registerReferenceExactShotMaterializationRoutes(router: Router, store: DataStore,
  options: { service?: ReturnType<typeof createExactShotMaterializationService> } = {}) {
  const service = options.service ?? createExactShotMaterializationService(store);
  const materialize: RequestHandler = async (req, res) => {
    const tenantId = res.locals.tenantId;
    if (typeof tenantId !== 'string' || !tenantId) { res.status(401).json({ error: 'authentication_required' }); return; }
    const body = req.body;
    const keys = ['expectedSourceSha256', 'expectedAnalysisRunId', 'expectedAnalysisHash'];
    if (typeof req.params.id !== 'string' || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !keys.includes(key))
      || keys.some(key => typeof body[key] !== 'string' || !body[key].trim())
      || !/^[a-f0-9]{64}$/.test(body.expectedSourceSha256) || !/^[a-f0-9]{64}$/.test(body.expectedAnalysisHash)
      || body.expectedAnalysisRunId.length > 200) {
      res.status(400).json({ error: 'reference_shot_request_invalid' }); return;
    }
    try {
      const receipt = await service.materialize({ tenantId, recordId: req.params.id,
        expectedSourceSha256: body.expectedSourceSha256, expectedAnalysisRunId: body.expectedAnalysisRunId,
        expectedAnalysisHash: body.expectedAnalysisHash });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ item: receipt });
    } catch (error) {
      const code = error instanceof SocialContentWorkflowError ? error.code : 'reference_shot_materialization_failed';
      res.status(error instanceof SocialContentWorkflowError ? 409 : 500).json({ error: code });
    }
  };
  router.post('/:id/exact-shot-materialization', materialize);
}
