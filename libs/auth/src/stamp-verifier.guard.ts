import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepository } from '@app/db/repositories';
import { createHash } from 'crypto';
import { verify } from 'crypto';

@Injectable()
export class StampVerifierGuard implements CanActivate {
  constructor(private readonly apiKeyRepo: ApiKeyRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Record<string, unknown>>();
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

    // Reconstruct signed payload: timestamp + "." + base64url(SHA-256(body))
    const body = request.body ? JSON.stringify(request.body) : '';
    const bodyHash = createHash('sha256').update(body).digest('base64url');
    const signedPayload = `${timestamp}.${bodyHash}`;

    // Verify P-256 (ES256) signature
    const signatureBuffer = Buffer.from(signatureB64, 'base64url');
    const publicKey = apiKey.public_key;

    const isValid = verify(
      'sha256',
      Buffer.from(signedPayload),
      {
        key: publicKey,
        dsaEncoding: 'ieee-p1363',
      },
      signatureBuffer,
    );

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

    // Update last_used_at
    await this.apiKeyRepo.update(apiKey.id, {
      last_used_at: new Date(),
    });

    return true;
  }
}
