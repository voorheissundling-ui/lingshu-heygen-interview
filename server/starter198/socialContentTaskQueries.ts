import type { SocialContentTaskPage, SocialContentWorkspace } from '../../shared/contracts/socialContentWorkflow.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { readSocialTaskDetail, socialTaskSummary } from './socialContentRecords.js';
import { SOCIAL_THEME_CATALOG } from './socialContentThemes.js';
import { listSocialWeeklyPlans } from './socialContentTaskSupport.js';
import { socialText } from './socialContentValidation.js';
import { listActiveSocialWorkPackageCards } from './socialWorkPackages.js';

export async function listSocialContentTasks(input: {
  repository: Starter198Repository;
  tenantId: string;
  status?: string;
  page?: number;
  perPage?: number;
}): Promise<SocialContentTaskPage> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, {
    ...(input.status ? { where: { status: input.status } } : {}), sort: '-updated_at', page: input.page, perPage: input.perPage,
  });
  return { ...result, items: result.items.map(socialTaskSummary) };
}

export async function readSocialContentWorkspace(input: {
  repository: Starter198Repository;
  tenantId: string;
  now?: Date;
}): Promise<SocialContentWorkspace> {
  const [catalog, list, weeklyPlans] = await Promise.all([
    listActiveSocialWorkPackageCards(input),
    listSocialContentTasks({ ...input, page: 1, perPage: 50 }),
    listSocialWeeklyPlans(input),
  ]);
  const current = list.items.find(item => !['reviewed'].includes(item.status)) ?? list.items[0] ?? null;
  return { catalog, tasks: list.items,
    taskList: { page: list.page, perPage: list.perPage, totalItems: list.totalItems, totalPages: list.totalPages },
    currentTask: current ? await readSocialTaskDetail({ ...input, taskId: current.taskId }) : null,
    weeklyPlans, themes: [...SOCIAL_THEME_CATALOG] };
}

export function resolveEnterpriseProductSelection<T extends { id?: unknown; productId?: unknown; sku?: unknown; name?: unknown }>(
  items: T[], selection: { productId?: unknown; productRef?: unknown },
): { item: T; canonicalId: string } | null {
  const selectedId = socialText(selection.productId), selectedName = socialText(selection.productRef).toLocaleLowerCase();
  const indexed = items.map((item, index) => ({ item, canonicalId: enterpriseProductIdentity(item, index) }));
  const idMatch = selectedId ? indexed.find(candidate => candidate.canonicalId === selectedId) : undefined;
  if (idMatch) return idMatch;
  if (!selectedName) return null;
  const fallback = indexed.filter(({ item }) => [item.name, item.sku]
    .some(value => socialText(value).toLocaleLowerCase() === selectedName));
  return fallback.length === 1 ? fallback[0]! : null;
}
