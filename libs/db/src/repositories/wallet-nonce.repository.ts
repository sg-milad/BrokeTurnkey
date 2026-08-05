import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../constants';
import type { DrizzleClient } from '../db';
import { IWalletNonceRepository } from './interfaces/wallet-nonce.repository.interface';

/**
 * Atomically reserves and consumes the next nonce for the wallet+chain pair.
 *
 * Uses a single INSERT ... ON CONFLICT upsert so the increment is atomic:
 * concurrent callers can never observe the same nonce, regardless of how
 * long the caller takes to sign and broadcast afterwards. The returned nonce
 * is permanently consumed — a failed broadcast leaves a gap (Ethereum
 * tolerates gaps; the guarantee that matters is that a nonce is never used
 * twice).
 *
 * Returns the reserved nonce (the pre-increment value).
 */
@Injectable()
export class WalletNonceRepository implements IWalletNonceRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) { }

  async reserve(walletId: string, chainId: number): Promise<number> {
    const result = await this.db.execute(
      sql`INSERT INTO wallet_nonces (wallet_id, chain_id, nonce)
          VALUES (${walletId}, ${chainId}, 1)
          ON CONFLICT (wallet_id, chain_id)
          DO UPDATE SET nonce = wallet_nonces.nonce + 1, updated_at = now()
          RETURNING nonce - 1 AS reserved`,
    );

    const row = result.rows[0] as { reserved: number } | undefined;
    if (!row) {
      throw new Error('nonce reservation returned no row');
    }
    return Number(row.reserved);
  }

  async syncFromChain(walletId: string, chainId: number, chainNonce: number): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO wallet_nonces (wallet_id, chain_id, nonce)
        VALUES (${walletId}, ${chainId}, ${chainNonce})
        ON CONFLICT (wallet_id, chain_id)
        DO UPDATE SET nonce = ${chainNonce}, updated_at = now()
        WHERE wallet_nonces.nonce < ${chainNonce}`,
    );
  }
}
