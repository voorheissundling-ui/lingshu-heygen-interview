import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export type DataAuthority = 'pocketbase' | 'local';

interface AuthorityContext {
  authority: DataAuthority | null;
}

const requestAuthority = new AsyncLocalStorage<AuthorityContext>();

export class DataAuthorityConflictError extends Error {
  constructor(readonly current: DataAuthority, readonly requested: DataAuthority) {
    super(`Request data authority is already locked to ${current}`);
    this.name = 'DataAuthorityConflictError';
  }
}

export class LocalAuthorityPocketBaseAccessError extends Error {
  constructor() {
    super('A local-authenticated request cannot access PocketBase data');
    this.name = 'LocalAuthorityPocketBaseAccessError';
  }
}

export function dataAuthorityRequestScope(_req: Request, _res: Response, next: NextFunction): void {
  requestAuthority.run({ authority: null }, next);
}

export function runInDataAuthorityRequestScope<T>(callback: () => T): T {
  return requestAuthority.run({ authority: null }, callback);
}

export function currentDataAuthority(): DataAuthority | null {
  return requestAuthority.getStore()?.authority ?? null;
}

export function bindDataAuthority(authority: DataAuthority): void {
  const context = requestAuthority.getStore();
  if (!context) {
    // Standalone routers and focused tests may not install the app-level scope.
    // Node gives each incoming request its own async resource, so enterWith still
    // keeps the decision on that request chain.
    requestAuthority.enterWith({ authority });
    return;
  }
  if (context.authority && context.authority !== authority) {
    throw new DataAuthorityConflictError(context.authority, authority);
  }
  context.authority = authority;
}

export function runWithDataAuthority<T>(authority: DataAuthority, callback: () => T): T {
  return requestAuthority.run({ authority }, callback);
}

export function assertPocketBaseDataAuthority(): void {
  if (currentDataAuthority() === 'local') throw new LocalAuthorityPocketBaseAccessError();
}
