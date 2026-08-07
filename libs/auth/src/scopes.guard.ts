import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './user.decorator';

export const SCOPES_KEY = 'required_scopes';

/**
 * Declares the API-key scopes required to call a route, e.g.
 * `@Scopes('key:write')`. The `*` wildcard scope satisfies any requirement.
 *
 * **OR semantics**: when multiple scopes are listed, possessing ANY ONE of
 * them is sufficient. For example, `@Scopes('wallet:sign', 'wallet:create')`
 * allows a key that has either `wallet:sign` OR `wallet:create`.
 *
 * Must be used on a route protected by StampVerifierGuard (which attaches
 * `request.user.scopes`); routes without an authenticated user and a scope
 * requirement are denied.
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No scope requirement declared — any authenticated caller passes.
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Record<string, any>>();
    const user = request.user as AuthUser | undefined;
    const scopes: string[] = user?.scopes ?? [];

    const allowed =
      scopes.includes('*') || required.some((scope) => scopes.includes(scope));

    if (!allowed) {
      throw new ForbiddenException('insufficient_scope');
    }

    return true;
  }
}
