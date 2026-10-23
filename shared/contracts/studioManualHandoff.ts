export const STUDIO_MANUAL_HANDOFF_ACTIONS = ['team_review', 'publishing_plan'] as const;
export type StudioManualHandoffAction = typeof STUDIO_MANUAL_HANDOFF_ACTIONS[number];

export function studioProjectRenderPaths(spec: Record<string, any>): string[] {
  const outputs = spec.languageRenderOutputs && typeof spec.languageRenderOutputs === 'object'
    ? Object.values(spec.languageRenderOutputs as Record<string, any>) : [];
  const versions = spec.languageRenderVersions && typeof spec.languageRenderVersions === 'object'
    ? Object.values(spec.languageRenderVersions as Record<string, any>).flatMap(value => Array.isArray(value) ? value : []) : [];
  return [...outputs, ...versions]
    .filter(value => value && typeof value === 'object' && value.status === 'done')
    .map(value => String((value as any).path || '').trim())
    .filter(Boolean);
}

export function isManualStudioProject(spec: Record<string, any>): boolean {
  return spec.creationPath === 'free_creation' && spec.manualWorkflow === true
    && spec.automation?.managedBy !== 'digital_employee';
}
