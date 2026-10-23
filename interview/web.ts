import {createServer, type IncomingMessage} from 'node:http';
import fs from 'node:fs/promises';
import {snapshot, scan, executeLocal, local} from './control.js';
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
let busy = false;

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
      return send(200, {
        mode: real ? 'real' : 'offline',
        keyConfigured: real && Boolean(process.env.HEYGEN_API_KEY),
        credentialHash: real ? process.env.INTERVIEW_CREDENTIAL_SHA256 ?? null : null,
        providerHost: 'api.heygen.com',
        socialContentHeyGenEnabled: process.env.SOCIAL_CONTENT_HEYGEN_ENABLED === 'true',
        generationEnabled: process.env.HEYGEN_GENERATION_ENABLED === 'true',
        paidGenerationPerformed: false,
        notice: real
          ? '真实模式只加载凭据并限制外网；供应商操作仍需显式开关和预算。'
          : '离线模式；bootstrap 已阻断外网。',
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

    if (req.method === 'POST' && ['/api/scan', '/api/render'].includes(url.pathname)) {
      if (busy) return send(409, {error: 'sandbox_operation_busy'});
      busy = true;
      try {
        return send(200, url.pathname === '/api/scan' ? await scan() : await executeLocal());
      } finally {
        busy = false;
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
