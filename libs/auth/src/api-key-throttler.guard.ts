import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limiter keyed by the VERIFIED API key when the request carries a
 * valid stamp, falling back to the client IP for public/anonymous routes.
 *
 * StampVerifierGuard runs before this guard (global guard order in
 * api.module.ts) and attaches the verified key identity to request.user.
 * Tracking `request.user.apiKeyId` instead of the raw key_id from the
 * X-Stamp header means an attacker cannot rotate fake key_ids to get a
 * fresh bucket per request — unverified stamps are rejected with 401 before
 * the throttler ever sees them.
 *
 * TODO: Storage is in-memory (default ThrottlerStorage). When running more
 * than one API instance, rate limits become per-instance and effectively
 * multiply. Migrate to a shared store (e.g. Redis via @nestjs/throttler's
 * ThrottlerStorageRedisService) before horizontal scaling.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    // Only trust identities attached by StampVerifierGuard. Never derive
    // the tracker from unvalidated header content.
    const user = req.user as { apiKeyId?: string } | undefined;
    if (user?.apiKeyId) {
      return Promise.resolve(`key:${user.apiKeyId}`);
    }
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }
}
