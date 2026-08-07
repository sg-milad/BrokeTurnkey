import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyRepository } from '@app/db/repositories';
import { createHash, verify } from 'crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

// Request body this size or larger is rejected by the body parser before the
// guard runs (express.json `limit` option). Keeping it in sync with main.ts.
export const MAX_BODY_BYTES = 1024 * 1024;

@Injectable()
export class StampVerifierGuard implements CanActivate {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Record<string, any>>();
    const headers = request.headers as Record<string, string>;
    const stamp = headers['x-stamp'];

    if (!stamp) {
      throw new UnauthorizedException('Missing X-Stamp header');
    }

    // Parse stamp: <base64url(sig)>.<timestamp_ms>.<key_id>
    const parts = stamp.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid stamp format');
    }

    const [signatureB64, timestampMs, keyId] = parts;
    const timestamp = parseInt(timestampMs, 10);

    if (isNaN(timestamp)) {
      throw new UnauthorizedException('Invalid timestamp in stamp');
    }

    // Validate timestamp (not older than 5 min, not more than 30 sec in future)
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const thirtySecondsFuture = now + 30 * 1000;

    if (timestamp < fiveMinutesAgo || timestamp > thirtySecondsFuture) {
      throw new UnauthorizedException('Stamp timestamp is out of valid range');
    }

    // Lookup API key
    const apiKey = await this.apiKeyRepo.findByKeyId(keyId);
    if (!apiKey) {
      throw new UnauthorizedException('API key not found');
    }

    if (apiKey.status !== 'active') {
      throw new UnauthorizedException('API key is not active');
    }

    if (apiKey.expires_at && apiKey.expires_at < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Reconstruct the signed payload over the RAW request bytes, exactly as
    // the client signed them (docs/STAMP_AUTH.md step 4). Never re-serialize
    // request.body — JSON round-tripping (key order, number formatting,
    // duplicate keys) would diverge from the signed bytes.
    const rawBody = request.rawBody as Buffer | undefined;
    const bodyHash = createHash('sha256')
      .update(rawBody ?? Buffer.alloc(0))
      .digest('base64url');
    const signedPayload = `${timestamp}.${bodyHash}`;

    // Decode and sanity-check the signature. Spec (docs/STAMP_AUTH.md):
    // DER-encoded ES256. DER for P-256 is 70-72 bytes (68-75 including edge
    // case encodings) — anything outside that range is malformed.
    let signatureBuffer: Buffer;
    try {
      signatureBuffer = Buffer.from(signatureB64, 'base64url');
    } catch {
      throw new UnauthorizedException('Invalid signature encoding');
    }
    if (signatureBuffer.length < 68 || signatureBuffer.length > 75) {
      throw new UnauthorizedException('Invalid signature length');
    }

    const publicKey = apiKey.public_key;

    let isValid = false;
    try {
      isValid = verify(
        'sha256',
        Buffer.from(signedPayload),
        {
          key: publicKey,
          dsaEncoding: 'der',
        },
        signatureBuffer,
      );
    } catch {
      // Malformed public key or signature — treat as invalid, never crash.
      throw new UnauthorizedException('Invalid signature');
    }

    if (!isValid) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Attach context to request
    request.user = {
      orgId: apiKey.org_id,
      apiKeyId: apiKey.id,
      keyId: apiKey.key_id,
      scopes: apiKey.scopes as string[],
    };

    // Update last_used_at — fire and forget, must not block or fail the
    // request (docs/STAMP_AUTH.md step 6).
    void this.apiKeyRepo
      .update(apiKey.id, {
        last_used_at: new Date(),
      })
      .catch(() => {
        /* best-effort bookkeeping only */
      });

    return true;
  }
}

/**
 * Like StampVerifierGuard but does NOT reject when X-Stamp is absent.
 * When a valid stamp is present it verifies and attaches request.user as usual.
 * When no stamp is present it simply returns true so the route handler can
 * fall back to alternative auth (e.g. X-Bootstrap-Token).
 */
@Injectable()
export class OptionalStampVerifierGuard implements CanActivate {
  constructor(
    private readonly stampVerifier: StampVerifierGuard,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public (same logic as StampVerifierGuard)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Record<string, any>>();
    const headers = request.headers as Record<string, string>;
    const stamp = headers['x-stamp'];

    // No stamp — allow through; the handler must enforce its own auth.
    if (!stamp) {
      return true;
    }

    // Delegate to the real guard via DI-managed instance (not manual new).
    return this.stampVerifier.canActivate(context);
  }
}
