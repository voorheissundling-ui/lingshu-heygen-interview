export const PROCESS_ROLES = ['all', 'web', 'worker'] as const;

export type ProcessRole = typeof PROCESS_ROLES[number];

export function parseProcessRole(
  value: string | undefined,
  splitEnabled = process.env.PROCESS_ROLE_SPLIT_ENABLED === 'true',
): ProcessRole {
  const role = value?.trim() || 'all';
  if (!(PROCESS_ROLES as readonly string[]).includes(role)) {
    throw new Error(`Invalid PROCESS_ROLE "${role}"; expected one of: ${PROCESS_ROLES.join(', ')}`);
  }
  if (role !== 'all' && !splitEnabled) {
    throw new Error(
      `PROCESS_ROLE="${role}" is disabled: web/worker process splitting requires the persistent queue and scheduler migration first. `
      + 'Use PROCESS_ROLE=all, or explicitly set PROCESS_ROLE_SPLIT_ENABLED=true only after that migration is complete.',
    );
  }
  return role as ProcessRole;
}

export function processRoleStartsHttp(role: ProcessRole): boolean {
  return role === 'all' || role === 'web';
}

export function processRoleStartsBackgroundJobs(role: ProcessRole): boolean {
  return role === 'all' || role === 'worker';
}
