import { productionNavigationIdentity } from './productionNavigation';
import type { PlanTask, WorkflowTask } from './digitalEmployees';

export type BusinessDestination =
  | 'enterprise' | 'accountManagement' | 'plugins' | 'scheduled' | 'socialInspiration'
  | 'scriptLibrary' | 'smartAssets' | 'adsManaged' | 'conversion' | 'digitalEmployees';

export interface DigitalEmployeeBusinessRef {
  taskKey: string;
  businessDomain?: string;
  capabilityKey?: string;
  statusSource?: string;
  entityId?: string;
  [key: string]: unknown;
}

export interface DigitalEmployeeDeepLink {
  page: BusinessDestination;
  view?: 'create' | 'publish';
  studioPanel?: 'projects';
  runId: string;
  taskId: string;
  businessRef: DigitalEmployeeBusinessRef;
}

export interface DigitalEmployeeReturnContext {
  customerNavigation?: unknown;
  navigationIdentity?: string;
  deliveryId?: string;
  returnPage: 'digitalEmployees';
  returnView: 'live';
  runId: string;
  taskId: string;
  taskKey: string;
  openedPage: BusinessDestination;
  openedAt: string;
  prompt: string;
}

const taskDestinationByKey: Record<string, Pick<DigitalEmployeeDeepLink, 'page' | 'view'>> = {
  context_readiness: { page: 'enterprise' },
  goal_decomposition: { page: 'digitalEmployees' },
  scheduled_source_collection: { page: 'scheduled' },
  viral_analysis: { page: 'socialInspiration' },
  content_mode_routing: { page: 'smartAssets', view: 'create' },
  content_production: { page: 'smartAssets', view: 'create' },
  content_quality_gate: { page: 'smartAssets', view: 'create' },
  content_release_approval: { page: 'smartAssets', view: 'publish' },
  publishing_calendar: { page: 'smartAssets', view: 'publish' },
  platform_publish: { page: 'smartAssets', view: 'publish' },
  customer_attribution: { page: 'conversion' },
  customer_segmentation: { page: 'conversion' },
  followup_batch_draft: { page: 'conversion' },
  followup_batch_approval: { page: 'conversion' },
  followup_dispatch: { page: 'conversion' },
  weekly_review: { page: 'digitalEmployees' },
};

export function buildTaskDeepLink(task: WorkflowTask, planTask: PlanTask | undefined, runId: string): DigitalEmployeeDeepLink {
  const resources = Array.isArray(task.business_refs) ? task.business_refs : [];
  const studioProject = resources.find(resource => resource?.type === 'studio_project' && String(resource.id || '').trim());
  const studioProjectId = studioProject ? String(studioProject.id).trim() : undefined;
  const mapped = taskDestinationByKey[task.task_key]
    || (/^(ads?|campaign|traffic)\./.test(task.capability_key || '') || ['ads', 'advertising', 'traffic'].includes(task.business_domain || '')
      ? { page: 'adsManaged' as const } : null)
    || (task.kind === 'production'
      ? { page: 'smartAssets' as const, view: 'create' as const }
      : task.kind === 'activation' ? { page: 'scheduled' as const } : { page: 'digitalEmployees' as const });
  const declaredDestination = task.destination || planTask?.destination;
  const page = declaredDestination && [
    'enterprise', 'accountManagement', 'scheduled', 'socialInspiration', 'scriptLibrary',
    'smartAssets', 'adsManaged', 'conversion', 'digitalEmployees',
  ].includes(declaredDestination) ? taskDestinationByKey[task.task_key]?.page || declaredDestination : mapped.page;
  return {
    page,
    view: page === 'smartAssets'
      ? (['content_release_approval', 'publishing_calendar', 'platform_publish'].includes(task.task_key)
        ? 'publish' : task.destination_view || planTask?.destinationView || mapped.view || 'create')
      : undefined,
    studioPanel: page === 'smartAssets' && ['content_production', 'content_quality_gate'].includes(task.task_key) ? 'projects' : undefined,
    runId, taskId: task.id,
    businessRef: {
      resources, taskKey: task.task_key,
      ...(studioProjectId ? { entityId: studioProjectId, deliveryId: `studio_project:${studioProjectId}` } : {}),
      businessDomain: task.business_domain || planTask?.businessDomain,
      capabilityKey: task.capability_key || planTask?.capabilityKey || String(task.output?.capability || ''),
      statusSource: task.status_source || planTask?.statusSource || String(task.output?.statusSource || ''),
      taskVersion: task.task_version, correctionVersion: task.correction_version,
    },
  };
}

export function dispatchDigitalEmployeeDeepLink(link: DigitalEmployeeDeepLink): void {
  if (typeof window === 'undefined') return;
  const navigationDetail = {
    ...link, navigationIdentity: productionNavigationIdentity(),
    workflowRunId: link.runId, workflowTaskId: link.taskId,
  };
  try {
    if (link.page === 'enterprise' && link.businessRef.enterpriseView === 'presenters') {
      window.localStorage.setItem('lingshu:enterprise:initial-view', 'presenters');
      window.dispatchEvent(new CustomEvent('lingshu:enterprise-view', { detail: { view: 'presenters' } }));
    }
    window.sessionStorage.setItem('digitalEmployee.businessDeepLink', JSON.stringify({ ...navigationDetail, issuedAt: Date.now() }));
    if (link.runId || link.taskId) {
      const returnContext: DigitalEmployeeReturnContext = {
        returnPage: 'digitalEmployees', navigationIdentity: productionNavigationIdentity(), returnView: 'live',
        ...(link.businessRef.customerNavigation ? { customerNavigation: link.businessRef.customerNavigation } : {}),
        runId: link.runId, taskId: link.taskId, taskKey: link.businessRef.taskKey,
        ...(typeof link.businessRef.deliveryId === 'string' ? { deliveryId: link.businessRef.deliveryId } : {}),
        openedPage: link.page, openedAt: new Date().toISOString(),
        prompt: '返回数字员工生产现场继续查看此任务',
      };
      window.sessionStorage.setItem('digitalEmployee.returnContext', JSON.stringify(returnContext));
    }
  } catch { /* optional context handoff */ }
  window.dispatchEvent(new CustomEvent('lingshu:navigate', { detail: navigationDetail }));
}

export function consumeDigitalEmployeeReturnContext(): DigitalEmployeeReturnContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem('digitalEmployee.returnContext');
    if (!raw) return null;
    window.sessionStorage.removeItem('digitalEmployee.returnContext');
    const value = JSON.parse(raw) as Partial<DigitalEmployeeReturnContext>;
    if (value.navigationIdentity !== productionNavigationIdentity() || value.returnPage !== 'digitalEmployees'
      || typeof value.taskId !== 'string' || typeof value.runId !== 'string') return null;
    return value as DigitalEmployeeReturnContext;
  } catch { return null; }
}
