import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limiter keyed by API key (from the X-Stamp header) when the request
 * carries one, falling back to the client IP for public/anonymous routes.
 *
 * Limitation: an unauthenticated attacker can rotate fake key_ids to get
 * fresh buckets. That hole closes once StampVerifierGuard is enforced
 * globally (the stamp's key_id is then validated before throttling matters).
 * For legitimate API keys the per-key limit works as documented.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const stamp = (req.headers as Record<string, string>)['x-stamp'];
    if (stamp) {
      const keyId = stamp.split('.')[2];
      if (keyId) {
        return Promise.resolve(`key:${keyId}`);
      }
    }
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }
}
