import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request metadata captured once at the HTTP edge and consumed deep in
 * the call stack by request-scoped writers (e.g. AuditLogRepository), which
 * are singletons and have no direct access to the request object.
 *
 * A middleware in main.ts wraps every request with `runWithRequestContext`;
 * AsyncLocalStorage propagates the store through all async continuations
 * of that request.
 */
export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
