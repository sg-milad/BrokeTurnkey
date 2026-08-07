import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Shape of the authenticated principal attached to `request.user` by
 * StampVerifierGuard (and OptionalStampVerifierGuard when a stamp is present).
 */
export interface AuthUser {
  orgId: string;
  apiKeyId: string;
  keyId: string;
  scopes: string[];
}

/**
 * Injects the authenticated API-key principal (`request.user`) into a route
 * handler parameter.
 *
 * Must be used on a route protected by StampVerifierGuard (or
 * OptionalStampVerifierGuard with a valid stamp), which attaches the object.
 *
 * Usage:
 *   @Get()
 *   handler(@CurrentUser() user: AuthUser) { ... }
 *
 *   // Single property:
 *   handler(@CurrentUser('orgId') orgId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user as AuthUser;
    return data ? user[data] : user;
  },
);
