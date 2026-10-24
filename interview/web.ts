import {createServer, type IncomingMessage} from 'node:http';
import fs from 'node:fs/promises';
import {snapshot, scan, local} from './control.js';
import {
  describeError, readPublicPipeline, startPipeline, step5ErrorCode,
} from './step5Pipeline.js';
import {
  isStep5PageGenerationEnabled, readStep5GenerationSummary, reconcileStep5Generation,
  step5GenerationCapFromEnv,
} from './step5Generation.js';
import {pbStore} from '../server/storage/pbStore.js';
import {createStarter198Repository} from '../server/starter198/repository.js';
import {openSocialArtifactPreviewMedia} from '../server/starter198/socialArtifactMedia.js';
import {
  STORYBOARD_ASSET_PATH,
  STORYBOARD_MAX_BYTES,
  findClientTenantFields,
  parseStoryboardText,
  readStoryboardFile,
  saveStoryboardFile,
  validateStoryboard,
  type StoryboardIssue,
} from './storyboard.js';

const html = await fs.readFile(new URL('./public/index.html', import.meta.url));

type BodyResult =
  | {ok: true; text: string}
  | {ok: false; status: number; error: string; issues: StoryboardIssue[]};

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: 'payload_too_large',
      issues: [{path: '$', code: 'payload_too_large', message: `请求体超过 ${maxBytes} 字节`}],
    };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: 'payload_too_large',
        issues: [{path: '$', code: 'payload_too_large', message: `请求体超过 ${maxBytes} 字节`}],
      };
    }
    chunks.push(Buffer.from(chunk));
  }
  return {ok: true, text: Buffer.concat(chunks).toString('utf8')};
}

/** Reads an optional JSON object body. An absent body means "use defaults". */
async function readOptionalJsonObject(req: IncomingMessage, maxBytes = 16 * 1024):
  Promise<{ok: true; value: Record<string, unknown>} | {ok: false; status: number; error: string}> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (!(declared > 0) && !req.headers['transfer-encoding']) return {ok: true, value: {}};
  const body = await readJsonBody(req, maxBytes);
  if (!body.ok) return {ok: false, status: body.status, error: body.error};
  if (!body.text.trim()) return {ok: true, value: {}};
  try {
    const value = JSON.parse(body.text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return {ok: false, status: 400, error: 'invalid_json_object'};
    return {ok: true, value: value as Record<string, unknown>};
  } catch {
    return {ok: false, status: 400, error: 'invalid_json'};
  }
}

const server = createServer(async (req, res) => {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(html);
      return;
    }

    // Storyboard reads and writes are deliberately separate from every
    // production endpoint: loading or previewing a storyboard never starts a
    // render, a paid provider operation, or a queue claim.
    if (req.method === 'GET' && url.pathname === '/api/storyboard') {
      const result = await readStoryboardFile(STORYBOARD_ASSET_PATH);
      return send(result.ok ? 200 : 422, {
        ok: result.ok,
        path: STORYBOARD_ASSET_PATH,
        storyboard: result.storyboard,
        issues: result.issues,
        sha256: result.sha256,
        savedAt: result.savedAt,
        raw: result.raw,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/storyboard') {
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return send(415, {
          ok: false,
          error: 'unsupported_media_type',
          issues: [{
            path: '$',
            code: 'content_type_required',
            message: 'Content-Type 必须是 application/json',
          }],
        });
      }
      const body = await readJsonBody(req, STORYBOARD_MAX_BYTES);
      if (!body.ok) return send(body.status, {ok: false, error: body.error, issues: body.issues});
      const parsed = parseStoryboardText(body.text);
      if (!parsed.ok) return send(400, {ok: false, error: 'invalid_json', issues: parsed.issues});

      // Tenant authority is never taken from the request body.
      const tenantIssues = findClientTenantFields(parsed.value);
      if (tenantIssues.length) {
        return send(400, {ok: false, error: 'client_tenant_not_accepted', issues: tenantIssues});
      }

      const validated = validateStoryboard(parsed.value);
      if (!validated.ok) {
        return send(400, {ok: false, error: 'storyboard_invalid', issues: validated.issues});
      }

      const saved = await saveStoryboardFile(validated.value, STORYBOARD_ASSET_PATH);
      return send(200, {
        ok: true,
        storyboard: validated.value,
        issues: [],
        path: STORYBOARD_ASSET_PATH,
        sha256: saved.sha256,
        savedAt: saved.savedAt,
        bytes: saved.bytes,
      });
    }

    // Public, non-secret runtime state. It never returns the key or the key file path.
    if (req.method === 'GET' && url.pathname === '/api/real/status') {
      const real = process.env.INTERVIEW_REAL_MODE === '1';
      let capCny: number | null = null;
      let capError: string | null = null;
      try { capCny = step5GenerationCapFromEnv(); }
      catch (error) { capError = step5ErrorCode(error); }
      return send(200, {
        mode: real ? 'real' : 'offline',
        keyConfigured: real && Boolean(process.env.HEYGEN_API_KEY),
        credentialHash: real ? process.env.INTERVIEW_CREDENTIAL_SHA256 ?? null : null,
        providerHost: 'api.heygen.com',
        socialContentHeyGenEnabled: process.env.SOCIAL_CONTENT_HEYGEN_ENABLED === 'true',
        generationEnabled: process.env.HEYGEN_GENERATION_ENABLED === 'true',
        pageGenerationEnabled: isStep5PageGenerationEnabled(),
        generationCapCny: capCny,
        generationCapError: capError,
        maxGenerationCapCny: 8,
        reconcileAvailable: real,
        paidGenerationPerformed: false,
        notice: real
          ? '真实模式只加载凭据并限制外网；供应商操作仍需显式开关和预算。'
          : '离线模式；bootstrap 已阻断外网。',
      });
    }

    // Read-only pipeline state. Loading this endpoint never starts, resumes, or
    // settles anything; execution is only reachable through POST /api/start.
    if (req.method === 'GET' && url.pathname === '/api/pipeline') {
      const generationLedger = await readStep5GenerationSummary().catch(() => null);
      return send(200, {
        ok: true,
        pipeline: await readPublicPipeline(),
        generationLedger: generationLedger
          ? {
            shots: generationLedger.shots.map(shot => ({
              shotId: shot.shotId, kind: shot.kind, phase: shot.phase,
              requestId: shot.requestId, title: shot.title,
              providerTaskId: shot.kind === 'presenter' ? shot.providerTaskId : null,
              providerStatus: shot.providerStatus, durationSeconds: shot.durationSeconds,
              chargedCny: shot.chargedCny, reusedFrom: shot.reusedFrom,
              mediaSha256: shot.mediaSha256, mediaBytes: shot.mediaBytes,
            })),
            unknownShots: generationLedger.unknownShots,
            pendingShots: generationLedger.pendingShots,
          }
          : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await snapshot());

    if (req.method === 'GET' && url.pathname === '/api/media') {
      const state = await snapshot();
      const artifact = state.artifacts.find((item: any) =>
        item.artifact_id === url.searchParams.get('artifactId') && item.tenant_id === 't');
      if (!artifact) return send(404, {error: 'artifact_not_found'});
      // Reuse the original artifact/file resolver: storage keys are not filesystem paths.
      const media = await local(() => openSocialArtifactPreviewMedia({
        repository: createStarter198Repository(pbStore),
        tenantId: 't',
        taskId: artifact.task_id,
        artifactId: artifact.artifact_id,
      }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of media.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': bytes.length,
        ...(url.searchParams.get('download') === '1'
          ? {'Content-Disposition': 'attachment; filename="interview-output.mp4"'}
          : {}),
      });
      res.end(bytes);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      try {
        const body = await readOptionalJsonObject(req);
        if (!body.ok) return send(body.status, {ok: false, error: body.error, code: body.error});
        const mode = body.value.mode === undefined ? 'reuse' : body.value.mode;
        if (mode !== 'reuse' && mode !== 'generate')
          return send(400, {ok: false, error: 'mode_must_be_reuse_or_generate', code: 'invalid_mode'});
        const confirmedCapCny = body.value.confirmedCapCny === undefined
          ? undefined : Number(body.value.confirmedCapCny);
        if (mode === 'generate' && !(typeof confirmedCapCny === 'number' && Number.isFinite(confirmedCapCny)))
          return send(400, {
            ok: false, error: '真实生成必须显式确认 CNY 预算上限', code: 'step5_generation_cap_not_confirmed',
          });
        const result = await startPipeline({mode, ...(confirmedCapCny !== undefined ? {confirmedCapCny} : {})});
        return send(result.status === 'started' ? 202 : 200, {ok: true, ...result});
      } catch (error) {
        const code = step5ErrorCode(error);
        const status = code === 'step5_execution_running' ? 409
          : code === 'step5_seed_required' || code === 'step5_session_missing' ? 409 : 400;
        return send(status, {ok: false, error: describeError(error), code});
      }
    }

    // Explicit reconciliation for an unknown submission. Read-only against the
    // provider: it never creates, downloads or re-submits a paid task.
    if (req.method === 'POST' && url.pathname === '/api/reconcile') {
      try {
        const body = await readOptionalJsonObject(req);
        if (!body.ok) return send(body.status, {ok: false, error: body.error, code: body.error});
        const shotId = body.value.shotId === undefined ? undefined : String(body.value.shotId);
        const videoId = body.value.videoId === undefined ? undefined : String(body.value.videoId);
        const shot = await local(() => reconcileStep5Generation({
          ...(shotId ? {shotId} : {}),
          ...(videoId ? {videoId} : {}),
        }));
        return send(200, {ok: true, shot, pipeline: await readPublicPipeline()});
      } catch (error) {
        const code = step5ErrorCode(error);
        const status = code === 'step5_submission_unknown' || code === 'step5_reconcile_not_found'
          || code === 'step5_reconcile_ambiguous' ? 409 : 400;
        return send(status, {ok: false, error: describeError(error), code});
      }
    }

    // Explicit settlement retry: it consumes the weekly queue but never submits
    // or re-renders a provider operation.
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      try {
        return send(200, {ok: true, result: await scan()});
      } catch (error) {
        return send(500, {ok: false, error: describeError(error), code: step5ErrorCode(error)});
      }
    }

    send(404, {error: 'not_found'});
  } catch (error) {
    send(500, {error: error instanceof Error ? error.message : String(error)});
  }
});

server.listen(Number(process.env.PORT ?? 4318), '127.0.0.1', () =>
  console.log('http://127.0.0.1:' + String(process.env.PORT ?? 4318)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
