import type { Request } from 'express';
import type { Starter198Capability } from '../../shared/contracts/starter198.js';
import { requestOrganizationRoleStrict } from '../lib/organizationRole.js';
import {
  buildStarter198CapabilityManifest,
  starter198CapabilityAllowed,
  starter198OrgRole,
  type Starter198AccessSnapshot,
} from './profile.js';
import {
  STARTER_COLLECTIONS,
  type Starter198Repository,
} from './repository.js';

export const SOCIAL_LEGACY_TASK_HEADER = 'x-lingshu-social-task-id' as const;
export const SOCIAL_LEGACY_PAGE_HEADER = 'x-lingshu-social-page' as const;

const SOCIAL_CONTEXT_PAGES = [
  'enterprise',
  'socialInspiration',
  'scriptLibrary',
  'smartAssets',
  'traffic',
  'accountManagement',
] as const;

type SocialContextPage = typeof SOCIAL_CONTEXT_PAGES[number];
type AccessKind = 'read' | 'edit' | 'generate';

type RouteRule = {
  kind: AccessKind;
  methods: readonly string[];
  pages: readonly SocialContextPage[];
  path: RegExp;
  requestAllowed?: (request: Request) => boolean;
};

const KNOWLEDGE_PAGES = ['enterprise', 'socialInspiration', 'smartAssets'] as const;
const CONTENT_LIBRARY_PAGES = ['socialInspiration', 'scriptLibrary', 'smartAssets', 'traffic'] as const;
const MATERIAL_PAGES = ['socialInspiration', 'smartAssets'] as const;
const STUDIO_PAGES = ['scriptLibrary', 'smartAssets'] as const;
const PUBLISHING_PAGES = ['traffic'] as const;
const DATA_PAGES = ['traffic', 'accountManagement'] as const;

/**
 * Explicit bridge from a social-content task into the existing professional
 * workbenches. Every entry is method-, page- and path-bound. Deliberately absent:
 * account connection, direct/bulk publishing, crawling, remote material import,
 * AI video generation, digital humans and internal control routes.
 */
const ROUTE_RULES: readonly RouteRule[] = [
  // Enterprise facts and task inputs.
  { kind: 'read', methods: ['GET', 'HEAD'], pages: KNOWLEDGE_PAGES, path: /^\/api\/overseas\/enterprise\/profile\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: ['enterprise'], path: /^\/api\/overseas\/enterprise\/faq\/packs\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: KNOWLEDGE_PAGES, path: /^\/api\/overseas\/enterprise\/assets\/[^/]+\/?$/ },
  { kind: 'edit', methods: ['POST', 'PATCH'], pages: ['enterprise'], path: /^\/api\/overseas\/enterprise\/profile\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: ['enterprise'], path: /^\/api\/overseas\/enterprise\/assets\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['enterprise'], path: /^\/api\/overseas\/enterprise\/faq\/structure\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: ['enterprise'], path: /^\/api\/overseas\/enterprise\/faq\/packs\/import\/?$/ },

  // Tenant-owned inspiration records and their media projections.
  { kind: 'read', methods: ['GET', 'HEAD'], pages: CONTENT_LIBRARY_PAGES, path: /^\/api\/overseas\/videos\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: CONTENT_LIBRARY_PAGES, path: /^\/api\/overseas\/videos\/[^/]+\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: CONTENT_LIBRARY_PAGES, path: /^\/api\/overseas\/videos\/[^/]+\/(?:media|media-url|thumbnail)\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: CONTENT_LIBRARY_PAGES, path: /^\/api\/overseas\/videos\/[^/]+\/image\/\d+\/?$/ },
  { kind: 'edit', methods: ['PATCH', 'DELETE'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/[^/]+\/?$/ },
  { kind: 'edit', methods: ['PATCH'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/[^/]+\/analysis-corrections\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/[^/]+\/refinement-sync\/?$/ },
  { kind: 'generate', methods: ['PATCH'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/[^/]+\/reanalyze\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/[^/]+\/reanalyze-image\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/analyze-source\/?$/, requestAllowed: request => /^[a-z0-9:_-]{1,200}$/i.test(String(request.body?.id || '').trim()) },
  { kind: 'generate', methods: ['POST'], pages: ['socialInspiration'], path: /^\/api\/overseas\/videos\/material-exact-analysis\/?$/ },

  // Material library: user uploads, metadata and explicit curation only.
  { kind: 'read', methods: ['GET', 'HEAD'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials\/pb\/[^/]+\/[^/]+\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/material-products\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/private-assets\/[^/]+\/[^/]+\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials(?:\/file)?\/?$/ },
  { kind: 'edit', methods: ['PATCH', 'DELETE'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials\/[^/]+\/?$/ },
  { kind: 'edit', methods: ['PATCH'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials\/[^/]+\/(?:pin|segments\/[^/]+)\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/materials\/[^/]+\/(?:analysis|analyze-segments|classify)\/?$/ },

  // Script/draft persistence and manual version selection.
  { kind: 'read', methods: ['GET', 'HEAD'], pages: STUDIO_PAGES, path: /^\/api\/overseas\/studio\/projects(?:\/[^/]+)?\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: STUDIO_PAGES, path: /^\/api\/overseas\/studio\/projects\/?$/ },
  { kind: 'edit', methods: ['DELETE'], pages: STUDIO_PAGES, path: /^\/api\/overseas\/studio\/projects\/[^/]+\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/video-versions\/?$/ },
  { kind: 'edit', methods: ['PATCH'], pages: MATERIAL_PAGES, path: /^\/api\/overseas\/studio\/video-versions\/[^/]+\/select\/?$/ },

  // Low-cost/manual content tools included in a standard workflow run.
  { kind: 'generate', methods: ['POST'], pages: ['socialInspiration', 'smartAssets'], path: /^\/api\/overseas\/studio\/(?:script|covers|caption|select|storyboard-quality-check|cover|translate|translate\/batch|fb-poster|lead-content-package)\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/fb-poster\/render\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/tts(?:\/batch|\/align|\/transcribe)?\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/(?:render|render\/local|transformations\/assess)\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/(?:subscription|tts\/capabilities|voice-samples|bgm)\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/(?:voice-samples|voiceover|bgm)\/?$/ },
  { kind: 'edit', methods: ['DELETE'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/bgm\/[^/]+\/?$/ },
  { kind: 'read', methods: ['POST'], pages: ['smartAssets'], path: /^\/api\/overseas\/studio\/library\/download-file\/?$/ },

  // 198 publishing remains package-first. Only local preparation and read-only
  // schedules/account inventory are bridged; provider upload/connect is absent.
  { kind: 'read', methods: ['GET', 'HEAD'], pages: PUBLISHING_PAGES, path: /^\/api\/overseas\/publishing\/(?:best-time|posting-schedule|calendar)\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: PUBLISHING_PAGES, path: /^\/api\/overseas\/publishing\/local-videos\/[^/]+\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: PUBLISHING_PAGES, path: /^\/api\/overseas\/publishing\/local-videos\/?$/ },
  { kind: 'edit', methods: ['PUT'], pages: PUBLISHING_PAGES, path: /^\/api\/overseas\/publishing\/posting-schedule\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: PUBLISHING_PAGES, path: /^\/api\/overseas\/publishing\/adapt-copy\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/(?:youtube|social)\/accounts\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/(?:youtube|social)\/accounts\/[^/]+\/videos\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/(?:youtube|social)\/accounts\/[^/]+\/video\/[^/]+\/comments\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-metrics\/(?:overview|trends)\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-engagement\/comments\/?$/ },
  { kind: 'read', methods: ['GET', 'HEAD'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-engagement\/(?:interactions|creative-learnings)\/?$/ },
  { kind: 'edit', methods: ['POST'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-engagement\/inquiries\/[^/]+\/qualification\/?$/ },
  { kind: 'generate', methods: ['POST'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-engagement\/comments\/(?:translate|analyze)\/?$/ },
  { kind: 'edit', methods: ['PATCH'], pages: DATA_PAGES, path: /^\/api\/overseas\/social-engagement\/comments\/status\/?$/ },
];

const REQUIRED_CAPABILITIES: Record<AccessKind, readonly Starter198Capability[]> = {
  read: ['workspace.read', 'production_site.read'],
  edit: ['workspace.read', 'production_site.read', 'orchestrator.command.submit'],
  generate: ['workspace.read', 'production_site.read', 'orchestrator.command.submit', 'workflow.standard.run'],
};

function headerValue(request: Request, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value.trim() : '';
}

function contextPage(value: string): SocialContextPage | null {
  return SOCIAL_CONTEXT_PAGES.includes(value as SocialContextPage)
    ? value as SocialContextPage
    : null;
}

function taskId(value: string): string | null {
  return /^[a-z0-9:_-]{1,200}$/i.test(value) ? value : null;
}

export type Starter198SocialLegacyDecision =
  | { state: 'not_requested' }
  | { state: 'denied' }
  | { state: 'allowed'; taskId: string; page: SocialContextPage; kind: AccessKind };

export interface Starter198SocialLegacyAccessDependencies {
  repository: Starter198Repository;
  access: Starter198AccessSnapshot;
  tenantId: string;
  userId: string;
  resolveRole?: (request: Request, userId: string) => Promise<unknown>;
  now?: () => Date;
}

export async function authorizeStarter198SocialLegacyRequest(
  request: Request,
  dependencies: Starter198SocialLegacyAccessDependencies,
): Promise<Starter198SocialLegacyDecision> {
  const rawTaskId = headerValue(request, SOCIAL_LEGACY_TASK_HEADER);
  const rawPage = headerValue(request, SOCIAL_LEGACY_PAGE_HEADER);
  if (!rawTaskId && !rawPage) return { state: 'not_requested' };

  const requestedTaskId = taskId(rawTaskId);
  const requestedPage = contextPage(rawPage);
  if (!requestedTaskId || !requestedPage) return { state: 'denied' };

  const pathname = new URL(request.originalUrl || request.url, 'http://local').pathname;
  const method = request.method.toUpperCase();
  const rule = ROUTE_RULES.find(candidate => (
    candidate.methods.includes(method)
    && candidate.pages.includes(requestedPage)
    && candidate.path.test(pathname)
    && (!candidate.requestAllowed || candidate.requestAllowed(request))
  ));
  if (!rule) return { state: 'denied' };

  const resolveRole = dependencies.resolveRole
    ?? ((req: Request, userId: string) => requestOrganizationRoleStrict(req.headers.authorization, userId));
  const role = starter198OrgRole(await resolveRole(request, dependencies.userId));
  if (!role || !['owner', 'admin', 'operator'].includes(role)) return { state: 'denied' };

  const manifest = buildStarter198CapabilityManifest(
    dependencies.access,
    dependencies.now?.() ?? new Date(),
  );
  if (REQUIRED_CAPABILITIES[rule.kind].some(capability => !starter198CapabilityAllowed(manifest, capability))) {
    return { state: 'denied' };
  }

  const task = await dependencies.repository.list(
    STARTER_COLLECTIONS.socialContentTasks,
    dependencies.tenantId,
    { where: { task_id: requestedTaskId }, perPage: 2 },
  );
  if (task.totalItems !== 1 || task.items.length !== 1) return { state: 'denied' };
  if (String(task.items[0]?.task_id || '').trim() !== requestedTaskId) return { state: 'denied' };

  return { state: 'allowed', taskId: requestedTaskId, page: requestedPage, kind: rule.kind };
}
